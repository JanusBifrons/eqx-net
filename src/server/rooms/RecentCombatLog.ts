import type { RecentCombat } from '../../shared-types/galaxySnapshot.js';

/** Default recent-combat window — "fighting/kills in the last ~5 min" (Equinox
 *  Phase 9 item 5). Tunable. */
export const RECENT_COMBAT_WINDOW_MS = 5 * 60 * 1000;

/** What kind of destruction a sector saw — drives the drawer event breakdown. */
export type RecentCombatKind = 'ship' | 'structure';

interface CombatEntry {
  ts: number;
  kind: RecentCombatKind;
}

/**
 * Per-room sliding-window tally of recent destruction events, for the galaxy
 * map's "recent combat" indicator + the drawer event breakdown (Equinox Phase 9
 * item 5).
 *
 * SRP: it ONLY records discrete destruction events and reports a windowed
 * summary. It is fed from the discrete combat-death hooks (`auditCombatDestruction`
 * + the `SHIP_DESTROYED` handler) — NEVER the 60 Hz loop — and read on the
 * LivingWorldDirector's ~1.5 s control tick, so the small per-event push + linear
 * prune are fine (no hot-loop allocation concern). Drones count as `ship`
 * (NPC hulls); structures + bases count as `structure`.
 */
export class RecentCombatLog {
  private readonly entries: CombatEntry[] = [];

  constructor(private readonly windowMs: number = RECENT_COMBAT_WINDOW_MS) {}

  /** Record a destruction at `nowMs` (epoch ms). Prunes expired entries. */
  record(kind: RecentCombatKind, nowMs: number): void {
    this.entries.push({ ts: nowMs, kind });
    this.prune(nowMs);
  }

  /**
   * Windowed summary at `nowMs`, or `null` when nothing happened within the
   * window (the galaxy map shows the combat icon purely on a non-null result).
   */
  summary(nowMs: number): RecentCombat | null {
    this.prune(nowMs);
    if (this.entries.length === 0) return null;
    let shipsDestroyed = 0;
    let structuresDestroyed = 0;
    let lastEventMs = 0;
    for (const e of this.entries) {
      if (e.kind === 'ship') shipsDestroyed++;
      else structuresDestroyed++;
      if (e.ts > lastEventMs) lastEventMs = e.ts;
    }
    return { shipsDestroyed, structuresDestroyed, lastEventMs };
  }

  /** Drop entries older than the window. Entries are pushed in ~time order, so
   *  expired ones cluster at the front — splice them in one shot. */
  private prune(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    let firstLive = 0;
    while (firstLive < this.entries.length && this.entries[firstLive]!.ts < cutoff) firstLive++;
    if (firstLive > 0) this.entries.splice(0, firstLive);
  }
}
