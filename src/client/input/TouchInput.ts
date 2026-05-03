import type { InputState } from './Keyboard';

const JOYSTICK_THRESHOLD = 0.3;

/**
 * Mutable input state written by MobileControls (React) and read by
 * ColyseusClient (game loop). Plain class — no Zustand, no event bus —
 * because it is updated every frame.
 */
export class TouchInput {
  private _thrust = false;
  private _turnLeft = false;
  private _turnRight = false;
  private _fireHeld = false;

  /**
   * Called by the nipplejs `move` event with the normalised vector.
   * nipplejs screen-space convention: y positive = DOWN, so y < 0 = stick
   * pushed up = thrust forward.
   */
  setJoystick(vector: { x: number; y: number }): void {
    this._thrust    = vector.y < -JOYSTICK_THRESHOLD;
    this._turnLeft  = vector.x < -JOYSTICK_THRESHOLD;
    this._turnRight = vector.x >  JOYSTICK_THRESHOLD;
  }

  setJoystickIdle(): void {
    this._thrust    = false;
    this._turnLeft  = false;
    this._turnRight = false;
  }

  setFireHeld(v: boolean): void {
    this._fireHeld = v;
  }

  read(): InputState {
    return {
      thrust:    this._thrust,
      turnLeft:  this._turnLeft,
      turnRight: this._turnRight,
      fireHeld:  this._fireHeld,
    };
  }
}

export function isTouchDevice(): boolean {
  return (
    (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) ||
    (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
  );
}
