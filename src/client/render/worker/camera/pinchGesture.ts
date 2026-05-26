/**
 * Two-pointer pinch-zoom gesture state machine.
 *
 * Captures the initial pointer-pair distance + scale at pinch start;
 * every move thereafter returns the running ratio. Caller applies
 * `pinchInitialScale * ratio` (clamped) at the midpoint of the two
 * pointers via `zoomAround`.
 */

export interface PinchPointer {
  x: number;
  y: number;
}

export interface PinchStep {
  /** Multiplier to apply to `pinchInitialScale` to get the current target scale. */
  ratio: number;
  /** Midpoint X between the two pointers (screen space). */
  midX: number;
  /** Midpoint Y between the two pointers (screen space). */
  midY: number;
}

export class PinchGesture {
  private initialDistance = 0;
  private initialScale = 1;

  /** Initial scale captured at `begin()`. Caller multiplies by ratio for final scale. */
  startScale(): number {
    return this.initialScale;
  }

  /**
   * Begin a pinch — record the initial pointer separation + camera scale.
   * Returns `false` when the pointers coincide (degenerate; the caller
   * must wait for separation before applying ratio math).
   */
  begin(a: PinchPointer, b: PinchPointer, currentScale: number): boolean {
    this.initialDistance = Math.hypot(b.x - a.x, b.y - a.y);
    this.initialScale = currentScale;
    return this.initialDistance > 0;
  }

  /**
   * Compute the current pinch ratio + midpoint. Returns `null` when
   * the gesture hasn't been validly begun (zero-distance start).
   */
  step(a: PinchPointer, b: PinchPointer): PinchStep | null {
    if (this.initialDistance === 0) return null;
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const ratio = dist / this.initialDistance;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    return { ratio, midX, midY };
  }
}
