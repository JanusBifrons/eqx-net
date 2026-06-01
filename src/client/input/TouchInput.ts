/**
 * Mutable input state written by MobileControls (React) and consumed by
 * ColyseusClient (game loop). Plain class — no Zustand, no event bus —
 * because it is updated every frame.
 *
 * The joystick stores the raw normalised vector. ColyseusClient resolves
 * it to turn/thrust booleans using the ship's current heading: the stick
 * angle is the desired heading, and rotation/thrust are derived from the
 * angular delta + magnitude.
 */
export class TouchInput {
  private vector: { x: number; y: number } | null = null;
  private _fireHeld = false;
  private _boostHeld = false;
  /**
   * Plan: crispy-kazoo, Commit 4 — pause boundary.
   * When false, every setter is masked and every getter returns the
   * idle value. The MobileControls React listeners keep posting (so
   * the touch-bleed during curtain rise is captured + dropped), but
   * no input crosses to the game loop.
   */
  private enabled = true;

  setEnabled(v: boolean): void {
    if (this.enabled === v) return;
    this.enabled = v;
    if (!v) {
      // Zero held bools on disable so the joiner can't "auto-thrust /
      // auto-fire on curtain lift" if a touch was active when they
      // died.
      this.vector = null;
      this._fireHeld = false;
      this._boostHeld = false;
    }
  }

  setJoystick(v: { x: number; y: number }): void {
    if (!this.enabled) return;
    this.vector = v;
  }

  setJoystickIdle(): void {
    if (!this.enabled) return;
    this.vector = null;
  }

  setFireHeld(v: boolean): void {
    if (!this.enabled) return;
    this._fireHeld = v;
  }

  setBoostHeld(v: boolean): void {
    if (!this.enabled) return;
    this._boostHeld = v;
  }

  /** Raw normalised joystick vector (each axis -1..1), or null when idle.
   *  nipplejs convention: y positive = DOWN on screen. */
  getJoystickVector(): { x: number; y: number } | null {
    if (!this.enabled) return null;
    return this.vector;
  }

  getFireHeld(): boolean {
    if (!this.enabled) return false;
    return this._fireHeld;
  }

  getBoostHeld(): boolean {
    if (!this.enabled) return false;
    return this._boostHeld;
  }
}

export function isTouchDevice(): boolean {
  return (
    (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) ||
    (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
  );
}
