/**
 * Desktop pointer input that isn't the lock line: right-mouse BOOST, written by
 * MouseLock and read by ColyseusClient's per-tick loop — like TouchInput, a
 * mutable plain class (no Zustand, no events) because it can change every
 * frame. (The manual-aim stick / mouse aim it used to carry is gone: every
 * weapon group now aims and fires at its LOCKED target.)
 */
export class AimInput {
  private enabled = true;
  private boostHeld = false;

  /** Gate like TouchInput.setEnabled (loading curtain / spectating). */
  setEnabled(v: boolean): void {
    if (this.enabled === v) return;
    this.enabled = v;
    if (!v) this.boostHeld = false;
  }

  /** Desktop right-mouse boost (MouseLock). */
  setBoostHeld(v: boolean): void {
    this.boostHeld = this.enabled && v;
  }

  getBoostHeld(): boolean {
    return this.enabled && this.boostHeld;
  }
}

/** The one pointer input for the page. */
export const aimInput = new AimInput();
