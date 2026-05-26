/**
 * Single-pointer drag (pan) gesture state machine.
 *
 * Tracks pointerdown→move→up for a single active pointer. The Camera
 * orchestrator owns the pointer Map (so it can detect pinch) and
 * forwards the relevant events here. This class owns:
 *   - pan-start position + timestamp (for tap-vs-drag classification)
 *   - last-known position (for delta computation)
 *   - isPanning flag (gated on pinch start)
 */

export class DragGesture {
  private panning = false;
  private panStartX = 0;
  private panStartY = 0;
  private panStartStamp = 0;
  private lastX = 0;
  private lastY = 0;

  /** True while a single pointer is panning (suspended during pinch). */
  isPanning(): boolean {
    return this.panning;
  }

  /** Return the pan-start position + timestamp (for tap-classify on release). */
  startState(): { x: number; y: number; stamp: number } {
    return { x: this.panStartX, y: this.panStartY, stamp: this.panStartStamp };
  }

  /** Begin a fresh pan (pointerdown OR pinch-end → single pointer left). */
  begin(screenX: number, screenY: number, stamp: number): void {
    this.panning = true;
    this.panStartX = screenX;
    this.panStartY = screenY;
    this.lastX = screenX;
    this.lastY = screenY;
    this.panStartStamp = stamp;
  }

  /** Suspend pan (pinch began with a second pointer). */
  suspend(): void {
    this.panning = false;
  }

  /** End the pan (pointerup or cancel). */
  end(): void {
    this.panning = false;
  }

  /**
   * Move event for the panning pointer. Returns the per-event delta —
   * caller adds it to the camera's target.x/y and to the momentum
   * controller's seed.
   */
  step(screenX: number, screenY: number): { dx: number; dy: number } {
    const dx = screenX - this.lastX;
    const dy = screenY - this.lastY;
    this.lastX = screenX;
    this.lastY = screenY;
    return { dx, dy };
  }
}
