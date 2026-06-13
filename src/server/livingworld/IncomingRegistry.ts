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

export class IncomingRegistry {
  /** `${destSectorKey}|${id}` → entry. */
  private readonly entries = new Map<string, IncomingEntry>();

  constructor(private readonly rooms: Map<string, LivingWorldRoom>) {}

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
    // arrival/retreat clear fires regardless.
    if (
      existing &&
      existing.count === entry.count &&
      existing.label === entry.label &&
      existing.disposition === entry.disposition
    ) {
      return;
    }
    this.rooms.get(entry.destSectorKey)?.broadcastWarpWarning({
      type: 'warp_warning',
      id: entry.id,
      label: entry.label,
      count: entry.count,
      countdownMs: entry.etaMs,
      disposition: entry.disposition,
      ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
    });
  }

  /** Clear an inbound (arrival / retreat / cancel) and broadcast the clear.
   *  Idempotent — clearing an unknown (id, dest) is a no-op (no broadcast). */
  clear(id: string, destSectorKey: string): void {
    if (!this.entries.delete(this.keyOf(id, destSectorKey))) return;
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
