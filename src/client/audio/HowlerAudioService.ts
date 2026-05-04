import { Howl } from 'howler';
import type { IAudio } from '@core/contracts/IAudio';

/**
 * Howler concretion for `IAudio`. Phase 6 ships the rate-shift hook so the
 * Temporal Anomaly diegetic surface works the moment Phase 4 SFX populate the
 * `howls` array. `playLaserFire` / `playExplosion` are no-ops until then.
 *
 * Howler's `.rate()` floor is 0.5; the TiDi clock floor is 0.7, so the clamp
 * in `setClockRate` is defensive only.
 */
export class HowlerAudioService implements IAudio {
  private readonly howls: Howl[] = [];

  playLaserFire(_x: number, _y: number): void {}

  playExplosion(_x: number, _y: number): void {}

  setClockRate(rate: number): void {
    const clamped = Math.max(0.5, rate);
    for (const h of this.howls) {
      h.rate(clamped);
    }
  }

  dispose(): void {
    for (const h of this.howls) {
      h.unload();
    }
    this.howls.length = 0;
  }
}
