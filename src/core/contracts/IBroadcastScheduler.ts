/**
 * Snapshot broadcast scheduling surface (server-side). Owns per-client
 * snapshot cadence, the join-grace extension window, idle-sector
 * suppression, and the binary swarm-broadcast pacing. The core zone
 * declares the contract; the server zone supplies the concretion.
 *
 * Today (pre-refactor) this logic lives inline in `SectorRoom.update()`
 * (the per-client loop + `forceBroadcastUntilTick` field). Commit 22 of
 * the god-file refactor extracts it into `BroadcastScheduler.ts`. The
 * `extendGrace` entry point replaces the scattered set-sites in join /
 * spawn / transit-arrival paths.
 */

export interface IBroadcastScheduler {
  /** Mark this tick as one where snapshots should be evaluated. */
  scheduleSnapshot(tick: number): void;
  /** Flush any pending snapshots to recipients; returns count sent. */
  flush(): number;
  /** Override the default broadcast cadence (Hz). */
  setCadence(hz: number): void;
  /**
   * Extend the join-grace window for all clients up to (and including)
   * `untilTick`. Callers: join handler, spawn handler, transit-arrival
   * handler. Single owner of `forceBroadcastUntilTick` per the refactor
   * plan's "no shared mutable field across collaborators" rule.
   */
  extendGrace(untilTick: number): void;
}
