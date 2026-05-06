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

  setJoystick(v: { x: number; y: number }): void {
    this.vector = v;
  }

  setJoystickIdle(): void {
    this.vector = null;
  }

  setFireHeld(v: boolean): void {
    this._fireHeld = v;
  }

  setBoostHeld(v: boolean): void {
    this._boostHeld = v;
  }

  /** Raw normalised joystick vector (each axis -1..1), or null when idle.
   *  nipplejs convention: y positive = DOWN on screen. */
  getJoystickVector(): { x: number; y: number } | null {
    return this.vector;
  }

  getFireHeld(): boolean {
    return this._fireHeld;
  }

  getBoostHeld(): boolean {
    return this._boostHeld;
  }
}

export function isTouchDevice(): boolean {
  return (
    (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) ||
    (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
  );
}
