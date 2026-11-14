/**
 * RTS review 2026-11-14 — send an owner's `fleet_status` soon after a fleet
 * command instead of waiting for the ~2.5 Hz stream timer (the panel read
 * "Guarding" for up to ~1 s after a move order).
 *
 * A command only sets the brains' orders; their ACTIVITY changes on their next
 * re-plan (staggered over `FLEET_REPLAN_EVERY_TICKS`). So a request is due
 * `delayTicks` later (one re-plan period + 1), when every addressed ship has
 * re-planned and the status tells the truth (#16). One pending send per
 * session (the earliest), so a burst of commands still sends once.
 *
 * `flush` runs every room tick: alloc-free (a reused Map, a bound visitor,
 * #14) and a single size check while nothing is pending.
 */
export class FleetStatusSoon {
  /** sessionId → server tick the send is due at. */
  private readonly due = new Map<string, number>();
  private nowTick = 0;
  private sendFn: ((sessionId: string) => void) | null = null;

  constructor(private readonly delayTicks: number) {}

  /** Ask for `sessionId`'s status `delayTicks` after `nowTick` (keeps an earlier request). */
  request(sessionId: string, nowTick: number): void {
    if (!this.due.has(sessionId)) this.due.set(sessionId, nowTick + this.delayTicks);
  }

  /** Send every request due at `nowTick`. */
  flush(nowTick: number, send: (sessionId: string) => void): void {
    if (this.due.size === 0) return;
    this.nowTick = nowTick;
    this.sendFn = send;
    this.due.forEach(this.visit);
    this.sendFn = null;
  }

  /** Forget a session (leave). */
  clear(sessionId: string): void {
    this.due.delete(sessionId);
  }

  /** Pending requests (tests). */
  get size(): number {
    return this.due.size;
  }

  private readonly visit = (at: number, sessionId: string): void => {
    if (this.nowTick < at) return;
    this.due.delete(sessionId);
    this.sendFn!(sessionId);
  };
}
