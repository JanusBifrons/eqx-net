/**
 * Gameplay audit log — a persistent, queryable record of DISCRETE
 * semantic gameplay events ("your capital in sol-prime was destroyed by a
 * fighter drone"). Answers questions like "what happened to my base?" long
 * after the fact, including events that fire while no player is connected
 * (the living world ticks at 60 Hz with zero players — see
 * src/server/CLAUDE.md "Drone warp-in / Equinox Phase 8").
 *
 * Modelled on `ServerEventLog.ts` (module-level singleton, importable from
 * anywhere on the server, no DI). Two destinations:
 *   1. an in-memory ring (recent N) for instant `/dev/audit` reads, and
 *   2. a rolling NDJSON file via a dedicated `pino-roll`-backed logger
 *      (one file per day under `audit-logs/`, the durable history).
 *
 * HOT-LOOP DISCIPLINE (root CLAUDE.md invariant #14): every `auditEvent`
 * call site MUST be a discrete, low-frequency boundary (a destruction, a
 * dispatch, a shield 0-cross, a join) — NEVER the per-tick pose/broadcast
 * path and NEVER per-hit damage. "Under attack" is captured as a throttled
 * first-hit-in-window signal, not a per-hit stream. The file write itself is
 * off-thread (pino transports run in a `thread-stream` worker), so this is
 * the same shape as the existing `serverLogEvent('damage_applied', …)`
 * already on these paths — no new per-tick allocation, no wire change.
 *
 * The audit log is a DISCRETE-EVENT sink (Event Bus Architecture rule): never
 * stream positions/velocities or per-tick data into it.
 */

import { pino, destination, type Logger } from 'pino';
import path from 'node:path';

/** Fields the caller never supplies — `auditEvent` stamps them. */
export interface AuditEventStamp {
  /** epoch ms */
  ts: number;
  /** ISO-8601, derived from `ts` (human-readable in the raw NDJSON). */
  iso: string;
}

/** Common context carried by every event. `sector` omitted for galaxy-wide. */
export interface AuditEventBase extends AuditEventStamp {
  sector?: string;
}

/**
 * The semantic event vocabulary. `event` is the discriminator so the query
 * layer can trivially include/exclude high-volume variants (e.g. drop
 * `drone_destroyed` to read the base story).
 */
export type AuditEvent =
  // ── Base / living-world ─────────────────────────────────────────────
  | (AuditEventBase & { event: 'wave_dispatched'; owner: string; targetSector: string; squadId: string; squadSize: number })
  | (AuditEventBase & { event: 'wave_incoming'; disposition: string; count: number; label?: string })
  | (AuditEventBase & { event: 'base_ready'; owner: string; composition?: Record<string, number> })
  | (AuditEventBase & {
      event: 'wave_repelled';
      owner: string;
      /** WS-E #8 — why the wave stood down: a healthy time-box phase-end vs a
       *  genuine de-escalation vs a fully-razed base. Lets a cadence audit tell
       *  the relentless-grind class from a clean resolution. Optional for
       *  back-compat with older log readers. */
      reason?: 'timeout' | 'de-escalation' | 'base-razed';
    })
  | (AuditEventBase & {
      // WS-E #22 — a roaming squad re-routed AWAY from an active-combat sector
      // (combat within the recent window). `squadId` identifies the pack; `from`
      // is where it roamed from, `avoided` the combat sector it skipped, `to` the
      // safe goal it picked instead (or `from` when it held because every live
      // neighbour was in combat).
      event: 'roam_avoid_combat';
      squadId: string;
      from: string;
      avoided: string;
      to: string;
    })
  // ── Structures ──────────────────────────────────────────────────────
  | (AuditEventBase & { event: 'structure_placed'; owner: string; kind: string; x: number; y: number })
  | (AuditEventBase & { event: 'structure_removed'; owner: string; kind: string })
  | (AuditEventBase & { event: 'structure_built'; owner: string; kind: string })
  | (AuditEventBase & { event: 'structure_attacked'; owner: string; kind: string; attackerId?: string; attackerKind?: string })
  | (AuditEventBase & { event: 'structure_destroyed'; owner: string; kind: string; attackerId?: string; attackerKind?: string; x?: number; y?: number })
  | (AuditEventBase & { event: 'base_destroyed'; owner: string; attackerId?: string })
  // ── Combat / ships ──────────────────────────────────────────────────
  | (AuditEventBase & { event: 'ship_destroyed'; playerId: string; attackerId?: string; attackerKind?: string })
  | (AuditEventBase & { event: 'drone_destroyed'; attackerId?: string })
  | (AuditEventBase & { event: 'player_killed'; victim: string; killer: string })
  | (AuditEventBase & { event: 'shield_broken'; entityId: string; owner?: string })
  // ── Lifecycle ───────────────────────────────────────────────────────
  | (AuditEventBase & { event: 'player_joined'; playerId: string })
  | (AuditEventBase & { event: 'player_left'; playerId: string })
  | (AuditEventBase & { event: 'transit_started'; playerId: string; from?: string; to: string })
  | (AuditEventBase & { event: 'transit_arrived'; playerId: string; to: string })
  // #18 — durable record of ANY ship/entity sector change (player transit OR
  // drone hop), so an "I just saw a ship jump A→B" report is checkable from the
  // audit log. `adjacent` is the galaxy-graph watchdog: false ⇒ a non-neighbour
  // (illegal) hop actually happened. Drones were previously only in the volatile
  // RAM ring (`bot_transit_commit`); this is the durable, queryable record.
  | (AuditEventBase & {
      event: 'sector_change';
      entityKind: 'player' | 'drone';
      id: string;
      from?: string;
      to: string;
      adjacent?: boolean;
    })
  | (AuditEventBase & { event: 'ship_lingered'; playerId: string; shipInstanceId: string })
  | (AuditEventBase & { event: 'ship_abandoned'; playerId?: string; shipInstanceId: string });

/** Distributive `Omit` so the union is preserved across the stamped fields. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** What a caller passes to `auditEvent` — everything except the stamp. */
export type AuditEventInput = DistributiveOmit<AuditEvent, keyof AuditEventStamp>;

export type AuditSink = (record: AuditEvent) => void;

// ── Configuration ─────────────────────────────────────────────────────
const RING_MAX = Number(process.env['EQX_AUDIT_RING_MAX'] ?? 2000);
const AUDIT_DIR = process.env['EQX_AUDIT_DIR'] ?? path.resolve(process.cwd(), 'audit-logs');

// ── State ─────────────────────────────────────────────────────────────
const ring: AuditEvent[] = [];
let sinkOverride: AuditSink | null = null;
let defaultSink: AuditSink | null = null;
let defaultLogger: Logger | null = null;

/**
 * Build the durable file sink. Prefers `pino-roll` (rolling daily NDJSON +
 * retention); falls back to a plain appended destination if the transport
 * fails to construct, so the audit trail is never silently lost on a
 * pino-roll API/version hiccup.
 */
function buildLogger(): Logger {
  // `base: null` drops pid/hostname; `timestamp: false` drops pino's own
  // `time` (we carry `ts`/`iso`). We deliberately KEEP pino's `level` field —
  // trying to strip it via a `formatters.level` returning `{}` emits INVALID
  // JSON (a stray leading comma), and the query layer ignores `level` anyway.
  try {
    return pino({
      base: null,
      timestamp: false,
      transport: {
        target: 'pino-roll',
        options: {
          file: path.join(AUDIT_DIR, 'audit'),
          frequency: 'daily',
          dateFormat: 'yyyy-MM-dd',
          size: '20m',
          mkdir: true,
          limit: { count: 30 },
        },
      },
    });
  } catch {
    // Fallback: a single appended NDJSON file, no rotation.
    return pino(
      { base: null, timestamp: false },
      destination({ dest: path.join(AUDIT_DIR, 'audit.ndjson'), mkdir: true, sync: false }),
    );
  }
}

/** Under vitest we must NEVER construct the pino-roll logger — it spawns a
 *  thread-stream worker and writes real files. Any test that transitively calls
 *  `auditEvent` (WaveDirector, structure construction, applyDamage, …) without
 *  opting into `setAuditSink` gets a no-op sink; the in-memory ring still
 *  records, so `getRecentAudit` / `setAuditSink` assertions work. */
function isTestEnv(): boolean {
  return process.env['VITEST'] !== undefined || process.env['NODE_ENV'] === 'test';
}

function ensureDefaultSink(): AuditSink {
  if (!defaultSink) {
    if (isTestEnv()) {
      defaultSink = (): void => { /* no durable sink under test */ };
    } else {
      defaultLogger = buildLogger();
      const l = defaultLogger;
      defaultSink = (record: AuditEvent): void => { l.info(record); };
    }
  }
  return defaultSink;
}

/**
 * Record a discrete gameplay event. Stamps `ts`/`iso`, pushes to the
 * in-memory ring, and writes one NDJSON line via the active sink. Never
 * throws into game logic.
 */
export function auditEvent(input: AuditEventInput): void {
  const ts = Date.now();
  const record = { ...input, ts, iso: new Date(ts).toISOString() } as AuditEvent;
  ring.push(record);
  if (ring.length > RING_MAX) ring.shift();
  try {
    (sinkOverride ?? ensureDefaultSink())(record);
  } catch {
    /* audit logging must never disrupt the simulation */
  }
}

/** Recent events from the in-memory ring (newest last). For `/dev/audit`. */
export function getRecentAudit(limit = 500): AuditEvent[] {
  return ring.slice(-limit);
}

/**
 * Override the durable sink — used by tests to capture records without
 * constructing the pino-roll logger or touching disk. Pass `null` to restore
 * the default file sink. Mirrors `DirectorPersistence`'s injected sink seam.
 */
export function setAuditSink(fn: AuditSink | null): void {
  sinkOverride = fn;
}

/** Test helper — clear the in-memory ring between cases. */
export function clearAuditRing(): void {
  ring.splice(0);
}

/** Where the durable NDJSON files live (for the dev endpoint + tooling). */
export function auditLogDir(): string {
  return AUDIT_DIR;
}

/**
 * Flush the durable logger's worker-thread buffer to disk. Call from the
 * graceful-shutdown drain so the transport drains before `process.exit`.
 */
export async function flushAudit(): Promise<void> {
  const l = defaultLogger;
  if (!l) return;
  await new Promise<void>((resolve) => {
    try {
      l.flush();
    } catch {
      /* best-effort */
    }
    // thread-stream flushes asynchronously; give it a brief tick.
    setTimeout(resolve, 100);
  });
}
