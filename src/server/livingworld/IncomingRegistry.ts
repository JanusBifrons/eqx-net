/**
 * Phase-4 P0 — the single per-destination-sector registry of ships that have
 * ELECTED to warp into a sector from ANOTHER sector. This is the data feed behind
 * the "incoming" HUD banner (`WarpInWarningBanner`).
 *
 * Why it exists: the banner always read "Nothing incoming" because the server only
 * broadcast a `warp_warning` from the wave step's FINAL-approach branch — roaming
 * squads, lone fighters and players never reached it (3rd failed-fix root cause).
 * The registry is fed off the ONE universal cross-sector hop choke point
 * (`LivingWorldDirector.startSquadMemberTransit`) plus the player-transit path, so
 * EVERY warp decision into an occupied sector is announced + cleared by
 * construction, not by enumerating cases.
 *
 * Owned by the `LivingWorldDirector` — the only object that spans every galaxy
 * room AND sees departures targeting a DIFFERENT room. The player-transit path
 * feeds the same registry through thin director methods so there is ONE banner
 * authority and one clear path (invariant #12).
 *
 * Off the 60 Hz loop: it mutates only at the ~1.5 s control tick + warp/transit
 * callbacks, iterates a tiny map, and clears by key — alloc-light (invariant #14).
 */
import type { LivingWorldRoom } from './LivingWorldRoom.js';
import type { WarpDisposition } from '../../shared-types/messages.js';
import { auditEvent } from '../audit/GameplayAuditLog.js';

export interface IncomingEntry {
  /** Stable id — the `squadId` (bots) or `playerId` (players). The dedup + clear key. */
  id: string;
  /** The sector the inbound is heading INTO (the room whose occupants are warned). */
  destSectorKey: string;
  /** The sector it departed from (diagnostics / future nav). */
  sourceSectorKey: string;
  /** HUD label — "Legionnaire" or the player's display name. */
  label: string;
  /** How many ships (8 for a squad, 1 for a player). */
  count: number;
  /** Threat relation for the banner colour. */
  disposition: WarpDisposition;
  /** Countdown to arrival, ms. */
  etaMs: number;
  /** Optional ship-kind id for an icon. */
  kind?: string;
  /** True for player-initiated transits — `reconcileIncoming` (the bot-arrival
   *  sweep) must NOT clear these; the transit/arrival hooks own them. */
  player?: boolean;
}

/** Campaign 2.3 — the identical-entry dedup is TIME-BOUNDED: a re-register
 *  re-broadcasts once this window has elapsed. Heals a missed clear (a squad
 *  object gone before `reconcileIncoming` swept ⇒ the stale entry used to
 *  suppress every later identical warning FOREVER) and refreshes the banner
 *  for players who joined the destination mid-approach. Well above the
 *  ~1.5 s control-tick re-register cadence, so the 8-members-one-banner
 *  spam guard is preserved. */
export const INCOMING_REBROADCAST_MS = 10_000;

export interface IncomingRegistryOpts {
  /** Injectable clock (deterministic tests). */
  nowMs?: () => number;
  /** Campaign 2.3 — fired when a warning's destination sector has NO live
   *  room in the director's map (room created later / engineering room /
   *  living world disabled). Previously a fully silent drop — the review's
   *  prime suspect for "it STILL says nothing incoming". */
  onUnknownDest?: (destSectorKey: string, id: string) => void;
}

export class IncomingRegistry {
  /** `${destSectorKey}|${id}` → entry. */
  private readonly entries = new Map<string, IncomingEntry>();
  /** `${destSectorKey}|${id}` → last warp_warning broadcast time (ms). */
  private readonly lastBroadcastAt = new Map<string, number>();
  private readonly nowMs: () => number;
  private readonly onUnknownDest: ((destSectorKey: string, id: string) => void) | undefined;

  constructor(
    private readonly rooms: Map<string, LivingWorldRoom>,
    opts: IncomingRegistryOpts = {},
  ) {
    this.nowMs = opts.nowMs ?? Date.now;
    this.onUnknownDest = opts.onUnknownDest;
  }

  private keyOf(id: string, destSectorKey: string): string {
    return `${destSectorKey}|${id}`;
  }

  /**
   * Register or refresh an inbound and broadcast `warp_warning` to the destination
   * room. If `id` is already inbound to a DIFFERENT sector (a re-tasked squad whose
   * goal changed), the stale destination's entry is cleared first so the banner
   * follows the ship rather than lingering at the abandoned target.
   */
  register(entry: IncomingEntry): void {
    for (const [k, e] of this.entries) {
      if (e.id === entry.id && e.destSectorKey !== entry.destSectorKey) {
        this.entries.delete(k);
        this.lastBroadcastAt.delete(k);
        this.rooms.get(e.destSectorKey)?.broadcastWarpWarningClear({ type: 'warp_warning_clear', id: e.id });
      }
    }
    const key = this.keyOf(entry.id, entry.destSectorKey);
    const existing = this.entries.get(key);
    this.entries.set(key, entry);
    // Skip redundant re-broadcasts: an 8-member squad departing for the SAME
    // destination in one control tick calls register() 8 times — broadcast once.
    // Only a NEW inbound or a meaningfully CHANGED one (count/label/disposition)
    // re-broadcasts; the per-leg countdown self-expires client-side and the
    // arrival/retreat clear fires regardless. Campaign 2.3: the dedup is
    // TIME-BOUNDED (INCOMING_REBROADCAST_MS) — an identical inbound
    // re-broadcasts after the window, healing a missed clear and refreshing
    // players who joined the destination mid-approach.
    const now = this.nowMs();
    const lastAt = this.lastBroadcastAt.get(key);
    if (
      existing &&
      lastAt !== undefined &&
      now - lastAt < INCOMING_REBROADCAST_MS &&
      existing.count === entry.count &&
      existing.label === entry.label &&
      existing.disposition === entry.disposition
    ) {
      return;
    }
    const destRoom = this.rooms.get(entry.destSectorKey);
    if (!destRoom) {
      // Campaign 2.3 — previously a silent optional-chain no-op: the warning
      // vanished with no trace when the destination had no live room.
      this.onUnknownDest?.(entry.destSectorKey, entry.id);
    } else {
      this.lastBroadcastAt.set(key, now);
    }
    destRoom?.broadcastWarpWarning({
      type: 'warp_warning',
      id: entry.id,
      label: entry.label,
      count: entry.count,
      countdownMs: entry.etaMs,
      disposition: entry.disposition,
      ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
    });
    // Audit: something is inbound to this sector (deduped to the same NEW/
    // changed condition as the broadcast above; control-tick cadence).
    auditEvent({
      event: 'wave_incoming',
      sector: entry.destSectorKey,
      disposition: entry.disposition,
      count: entry.count,
      label: entry.label,
    });
  }

  /** Clear an inbound (arrival / retreat / cancel) and broadcast the clear.
   *  Idempotent — clearing an unknown (id, dest) is a no-op (no broadcast). */
  clear(id: string, destSectorKey: string): void {
    const key = this.keyOf(id, destSectorKey);
    if (!this.entries.delete(key)) return;
    this.lastBroadcastAt.delete(key); // next register broadcasts immediately
    this.rooms.get(destSectorKey)?.broadcastWarpWarningClear({ type: 'warp_warning_clear', id });
  }

  /** Whether `id` is currently inbound to `destSectorKey`. */
  has(id: string, destSectorKey: string): boolean {
    return this.entries.has(this.keyOf(id, destSectorKey));
  }

  /** Iterate active entries (the reconcile sweep reads this). */
  all(): IterableIterator<IncomingEntry> {
    return this.entries.values();
  }

  /** Drop every entry without broadcasting (teardown — rooms are going away). */
  reset(): void {
    this.entries.clear();
  }
}
