/**
 * RTS command layer (slice 10) — double tap / double click on one of your own
 * ships in command view = "take the controls" of that ship. Pure, no Pixi, no
 * DOM, alloc-free (one reused record).
 *
 * Two taps count as a double tap when they land on the SAME ship within
 * `DOUBLE_TAP_MS` and within `DOUBLE_TAP_SLOP_PX` screen pixels of each other.
 * A completed double tap resets, so a third tap starts a new pair.
 */

/** Longest gap between the two taps (ms; the common desktop default ~500). */
export const DOUBLE_TAP_MS = 400;
/** Farthest the second tap may land from the first (CSS px). */
export const DOUBLE_TAP_SLOP_PX = 24;

export class DoubleTapTracker {
  private id: string | null = null;
  private t = 0;
  private x = 0;
  private y = 0;

  /**
   * Record a tap at (x, y) screen px, time `t` ms, on own ship `id` (null =
   * not on an own ship: resets). Returns true when it completes a double tap.
   */
  tap(id: string | null, t: number, x: number, y: number): boolean {
    if (id === null) {
      this.id = null;
      return false;
    }
    const dx = x - this.x;
    const dy = y - this.y;
    const isDouble = this.id === id
      && t - this.t >= 0
      && t - this.t <= DOUBLE_TAP_MS
      && dx * dx + dy * dy <= DOUBLE_TAP_SLOP_PX * DOUBLE_TAP_SLOP_PX;
    if (isDouble) {
      this.id = null;
      return true;
    }
    this.id = id;
    this.t = t;
    this.x = x;
    this.y = y;
    return false;
  }

  reset(): void {
    this.id = null;
  }
}
