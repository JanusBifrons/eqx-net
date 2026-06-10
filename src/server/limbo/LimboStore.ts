/**
 * LimboStore — Phase 8 sub-phase B.
 *
 * In-memory primary, persistence shadow on every mutation. Holds a player's
 * ship state in two distinct cases:
 *
 *   - **Disconnect** (TTL 5 min): the player's WS dropped. Any reconnect
 *     within the window restores their ship at the last-known pose with
 *     cooldowns and userId binding intact. After the TTL the entry is
 *     pruned and the player would respawn fresh on next connect.
 *
 *   - **Transit-in-flight** (TTL 30 s): the player just spooled out of a
 *     source sector toward a destination. The destination's `onJoin` will
 *     consume the entry within hundreds of ms; the 30 s cap is just enough
 *     to cover seat-reservation + WS handshake jitter.
 *
 * The schema row is identical for both — only `expires_at` differs. Pure
 * Limbo (no Colyseus `allowReconnection`): all (re)entries flow through the
 * same `take` + reconstruct path, which keeps same-sector reconnect and
 * cross-sector transit on one rail.
 *
 * The persistence shadow runs through the existing `IPersistenceSink`
 * CRITICAL lane (50 ms WAB). A server crash between the in-memory put and
 * the WAB flush loses one Limbo entry — bounded, and not a regression vs
 * the pre-Phase-8 baseline of "lose everything on disconnect". On boot,
 * `hydrate()` rehydrates from `SELECT ... WHERE expires_at > now`.
 *
 * Phase-far multi-VM: the in-memory map becomes a Redis-backed analog;
 * the persistence shadow stays as a tertiary recovery path. The `take`
 * primitive is the only one that needs atomic semantics; the in-memory
 * `Map.get + Map.delete` is implicitly atomic, and Redis `WATCH/MULTI/EXEC`
 * (or a Lua script) is the obvious swap.
 *
 * See docs/architecture/persistence-and-migrations.md for the full picture.
 */
import type { IPersistenceSink } from '../../core/contracts/IPersistenceSink.js';

/** Time the player's ship state is held after a disconnect. */
export const LIMBO_DISCONNECT_TTL_MS = 900_000; // 15 min
/** Time a transit-in-flight entry is held while the destination consumes it. */
export const LIMBO_TRANSIT_TTL_MS = 30_000;
/** How often the prune timer evicts expired entries. */
export const LIMBO_PRUNE_INTERVAL_MS = 30_000;
/** Hard cap on live entries — an adversarial disconnect burst can't grow the
 *  map unbounded (S8). On overflow the earliest-expiring entry is evicted. */
export const LIMBO_MAX_ENTRIES = 10_000;

/** All persisted ship state needed to reconstruct a player's ship at the
 *  destination's `onJoin`. Position is preserved exactly across the hop —
 *  per the Phase 8 design, asteroid layouts leave the centre clear so this
 *  is safe. */
export interface LimboPayload {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  angvel: number;
  health: number;
  /** Combat cooldown — must persist so a resumed pilot can't insta-fire. */
  lastFireClientTick: number;
  /** Auth attribution. May be `null` for anonymous players. */
  userId: string | null;
  /** The sector the entry is destined for — the destination room's `onJoin`
   *  only consumes when this matches its own `sectorKey`. For a
   *  same-sector reconnect, it's the source room's key. For transit, it's
   *  the destination key (set by `TransitOrchestrator.commitTransit`). */
  sectorKey: string;
  /** Ship kind id from `SHIP_KINDS`. Optional for back-compat with payloads
   *  written before the ship-kind feature landed — decoders fall back to
   *  `DEFAULT_SHIP_KIND`. Persisted so a transit hop or disconnect/reconnect
   *  preserves the player's chosen ship across the gap. */
  kind?: string;
}

export interface LimboEntry {
  playerId: string;
  payload: LimboPayload;
  /** Unix ms; entry is treated as expired when `now > expiresAt`. */
  expiresAt: number;
  createdAt: number;
}

/** Minimal logger seam so the overflow warning is observable in tests without
 *  pulling pino into this pure-ish store. */
export interface LimboLogger {
  warn(obj: object, msg: string): void;
}

export interface LimboStoreOpts {
  /** When set, every mutation shadows through CRITICAL via the sink. */
  persistence?: IPersistenceSink;
  /** Hard cap on live entries. Defaults to `LIMBO_MAX_ENTRIES`. */
  maxEntries?: number;
  /** Optional logger for the sampled cap-overflow warning. */
  logger?: LimboLogger;
}

export class LimboStore {
  private map = new Map<string, LimboEntry>();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private readonly persistence: IPersistenceSink | undefined;
  private readonly maxEntries: number;
  private readonly logger: LimboLogger | undefined;
  /** Running count of cap-overflow evictions, for the sampled warn. */
  private overflowEvictions = 0;

  constructor(opts: LimboStoreOpts = {}) {
    this.persistence = opts.persistence;
    this.maxEntries = opts.maxEntries ?? LIMBO_MAX_ENTRIES;
    this.logger = opts.logger;
  }

  /**
   * Enforce the entry cap before inserting a NEW playerId. Evicts the
   * earliest-expiring entry (closest to natural prune) so an adversarial
   * disconnect burst can't grow the map unbounded. Re-puts of an existing
   * playerId don't grow the map, so they skip this. Warning is sampled (1st,
   * then every 100th) to stay quiet under a sustained burst.
   */
  private enforceCap(now: number): void {
    if (this.map.size < this.maxEntries) return;
    let victimId: string | null = null;
    let victimExpiry = Infinity;
    for (const [pid, entry] of this.map) {
      if (entry.expiresAt < victimExpiry) {
        victimExpiry = entry.expiresAt;
        victimId = pid;
      }
    }
    if (victimId === null) return;
    this.map.delete(victimId);
    this.persistence?.enqueueCritical({ type: 'LIMBO_DELETE', playerId: victimId, ts: now });
    this.overflowEvictions += 1;
    if (this.overflowEvictions === 1 || this.overflowEvictions % 100 === 0) {
      this.logger?.warn(
        { evictedPlayerId: victimId, size: this.map.size, totalOverflowEvictions: this.overflowEvictions },
        'LimboStore at capacity — evicted earliest-expiring entry',
      );
    }
  }

  /** In-memory + persistence-shadowed put. Overwrites any existing entry. */
  put(
    playerId: string,
    payload: LimboPayload,
    ttlMs: number,
    now: number = Date.now(),
  ): LimboEntry {
    // Cap is enforced only when inserting a NEW playerId — overwriting an
    // existing entry doesn't grow the map.
    if (!this.map.has(playerId)) this.enforceCap(now);
    const entry: LimboEntry = {
      playerId,
      payload,
      expiresAt: now + ttlMs,
      createdAt: now,
    };
    this.map.set(playerId, entry);
    this.persistence?.enqueueCritical({
      type: 'LIMBO_PUT',
      playerId,
      userId: payload.userId,
      sectorKey: payload.sectorKey,
      payloadJson: JSON.stringify(payload),
      expiresAt: entry.expiresAt,
      ts: now,
    });
    return entry;
  }

  /**
   * Atomic in-memory get + delete + persistence-shadow delete. Returns
   * `null` if no entry, or if the existing entry has expired (the expired
   * entry is also cleared as a side-effect).
   */
  take(playerId: string, now: number = Date.now()): LimboEntry | null {
    const entry = this.map.get(playerId);
    if (!entry) return null;
    this.map.delete(playerId);
    this.persistence?.enqueueCritical({
      type: 'LIMBO_DELETE',
      playerId,
      ts: now,
    });
    if (entry.expiresAt <= now) return null;
    return entry;
  }

  /** Read without delete. Returns `null` for missing or expired entries. */
  peek(playerId: string, now: number = Date.now()): LimboEntry | null {
    const entry = this.map.get(playerId);
    if (!entry) return null;
    if (entry.expiresAt <= now) return null;
    return entry;
  }

  /** Force-delete (e.g. operator clean-up). Shadows through the sink. */
  delete(playerId: string, now: number = Date.now()): void {
    if (!this.map.has(playerId)) return;
    this.map.delete(playerId);
    this.persistence?.enqueueCritical({
      type: 'LIMBO_DELETE',
      playerId,
      ts: now,
    });
  }

  /** Evict all entries with `expiresAt <= now`. Returns count evicted. */
  prune(now: number = Date.now()): number {
    let evicted = 0;
    for (const [pid, entry] of this.map) {
      if (entry.expiresAt <= now) {
        this.map.delete(pid);
        this.persistence?.enqueueCritical({
          type: 'LIMBO_DELETE',
          playerId: pid,
          ts: now,
        });
        evicted += 1;
      }
    }
    return evicted;
  }

  /**
   * Boot-time rehydrate from on-disk rows. Pure in-memory write — does NOT
   * shadow through the sink (the rows already live there).
   */
  hydrate(rows: ReadonlyArray<LimboEntry>): void {
    for (const row of rows) {
      this.map.set(row.playerId, row);
    }
  }

  size(): number {
    return this.map.size;
  }

  startPruneTimer(intervalMs: number = LIMBO_PRUNE_INTERVAL_MS): void {
    if (this.pruneTimer !== null) return;
    this.pruneTimer = setInterval(() => {
      this.prune();
    }, intervalMs);
    // Don't keep the process alive solely on this interval.
    if (typeof this.pruneTimer === 'object' && this.pruneTimer && 'unref' in this.pruneTimer) {
      (this.pruneTimer as { unref: () => void }).unref();
    }
  }

  stopPruneTimer(): void {
    if (this.pruneTimer !== null) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }
}
