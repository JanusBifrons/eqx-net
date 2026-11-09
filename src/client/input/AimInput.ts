/**
 * Manual aim input (exp/hud-mobile-first). Mutable, plain-class state written
 * by the HUD (an aim stick / attack button drag) or the desktop mouse, read by
 * ColyseusClient's per-tick loop — like TouchInput, no Zustand, no events,
 * because it can change every frame.
 *
 * While AIMING the client (a) treats it as manual fire wanted (fires
 * continuously, subject to cooldown + energy), (b) sends the aim bearing on
 * every `input` so the server slews the turrets to it, and (c) for a ship
 * whose guns are all fixed, turns the hull toward it.
 *
 * Bearing convention = ship angle: 0 = game +y (screen UP), `atan2(-dx, dy)`.
 */
import { stickToWorldBearing } from '@core/combat/manualAim';

/** A stick pushed less than this is "touching, not aiming". */
export const AIM_STICK_DEADZONE = 0.25;

export class AimInput {
  private touching = false;
  private aiming = false;
  private bearing = 0;
  private enabled = true;
  private boostHeld = false;

  /** Gate like TouchInput.setEnabled (loading curtain / spectating). */
  setEnabled(v: boolean): void {
    if (this.enabled === v) return;
    this.enabled = v;
    if (!v) {
      this.clear();
      this.boostHeld = false;
    }
  }

  /** Desktop right-mouse boost (MouseAim). */
  setBoostHeld(v: boolean): void {
    this.boostHeld = this.enabled && v;
  }

  getBoostHeld(): boolean {
    return this.enabled && this.boostHeld;
  }

  /** Screen-space stick vector: x right, y DOWN, magnitude 0..1. */
  setStick(x: number, y: number): void {
    if (!this.enabled) return;
    this.touching = true;
    if (x * x + y * y < AIM_STICK_DEADZONE * AIM_STICK_DEADZONE) {
      this.aiming = false;
      return;
    }
    this.bearing = stickToWorldBearing(x, y);
    this.aiming = true;
  }

  /** Desktop mouse: a world bearing from ship to cursor. */
  setWorldBearing(b: number): void {
    if (!this.enabled) return;
    this.touching = true;
    this.bearing = b;
    this.aiming = true;
  }

  clear(): void {
    this.touching = false;
    this.aiming = false;
  }

  isAiming(): boolean {
    return this.enabled && this.aiming;
  }

  /** True while a thumb/button is down, even inside the dead zone. */
  isTouching(): boolean {
    return this.enabled && this.touching;
  }

  getBearing(): number {
    return this.bearing;
  }
}

/** The one aim input for the page. */
export const aimInput = new AimInput();
