import { Howl, Howler } from 'howler';
import type { IAudio } from '@core/contracts/IAudio';

/**
 * Howler concretion for `IAudio`. Phase 6 ships the rate-shift hook so the
 * Temporal Anomaly diegetic surface works the moment Phase 4 SFX populate the
 * `howls` array. `playLaserFire` / `playExplosion` are no-ops until then.
 *
 * Howler's `.rate()` floor is 0.5; the TiDi clock floor is 0.7, so the clamp
 * in `setClockRate` is defensive only.
 *
 * Plan: crispy-kazoo, Commit 4 — pause boundary.
 * `suspendAll` / `resumeAll` toggle the underlying Web Audio context so
 * incoming SFX queue up rather than play during the loading curtain.
 *
 * `Howler.ctx` is GLOBAL and `close()` is IRREVERSIBLE — dispose only
 * unloads per-Howl buffers (no ctx mutation). Next service instance
 * reuses the same context, audio still works. Commit 6 audits this.
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

  /** Suspend the global Web Audio context. Fire-and-forget; the
   *  `.catch(() => {})` swallows the iOS Safari path where the
   *  context exists but has no `suspend()` method. */
  async suspendAll(): Promise<void> {
    const ctx = Howler.ctx;
    if (!ctx) return;
    if (typeof ctx.suspend !== 'function') return;
    try {
      await ctx.suspend();
    } catch {
      // Safari may reject; non-fatal.
    }
  }

  async resumeAll(): Promise<void> {
    const ctx = Howler.ctx;
    if (!ctx) return;
    if (typeof ctx.resume !== 'function') return;
    try {
      await ctx.resume();
    } catch {
      // Safari may reject; non-fatal.
    }
  }

  dispose(): void {
    for (const h of this.howls) {
      h.unload();
    }
    this.howls.length = 0;
    // DELIBERATELY DO NOT call Howler.ctx.close() — global state, irreversible.
  }
}
