/**
 * Load curtain — the full-canvas dark overlay raised at every join (and
 * on a transit load) to hide the canvas until the destination is ready.
 * INSTANT rise, ~380 ms fade-out (see `curtainAlphaAt`).
 *
 * Lives on its own `curtainStage` container above the world, built lazily
 * on the first `setLoadCurtain` call. It owns NO filter: nothing here may
 * touch `app.stage.filters` (a stage filter renders the frame into a
 * non-MSAA texture and pays full-screen passes).
 *
 * This is what remains of the old shader warp chain (`WarpFilterChain`,
 * the shockwave/zoom-blur ripple + arrival flash), which was removed; the
 * warp visual is now `WarpFx` / `WarpSpoolFx`. See
 * `docs/architecture/warp-visual.md`.
 */

import { Application, Container, Graphics } from 'pixi.js';

/** Markers the curtain writes each tick. PixiRenderer's frameMarkers
 *  object is reused; only `warpTickMs` (the curtain tick cost) is touched. */
export interface CurtainFrameMarkers {
  warpTickMs: number;
}

const BACKGROUND_COLOR = 0x05070f;
// Full opacity: any see-through let bright VFX (laser bolts, missile
// explosions) bleed through the curtain (2026-05-31 smoke "I saw some
// effects happen behind/on the curtain"). The curtain colour matches the
// background so it reads as "starfield dimmed".
const CURTAIN_PEAK_ALPHA = 1.0;
const CURTAIN_FADE_MS = 380;

/**
 * Load-curtain alpha during its tween (WS-14 / R2.26-curtain).
 *
 * The RISE (cover going up, target ≥ from) is **instant**: the curtain must be
 * fully opaque BEFORE the destination sector is revealed, or the destination
 * sprites flash through the still-rising semi-transparent curtain (R2.26
 * "ship-change briefly flashes the sector" — the rise used to tween over 200 ms
 * while the destination's first frame rendered sooner). Only the FADE-OUT (the
 * arrival reveal, target < from) is tweened over `CURTAIN_FADE_MS` so the new
 * sector fades in smoothly.
 */
export function curtainAlphaAt(fromAlpha: number, targetAlpha: number, elapsedMs: number): number {
  if (targetAlpha >= fromAlpha) return targetAlpha; // rising (or no change) → snap opaque
  if (elapsedMs >= CURTAIN_FADE_MS) return targetAlpha; // fade-out complete
  return fromAlpha + (targetAlpha - fromAlpha) * (elapsedMs / CURTAIN_FADE_MS);
}

export class LoadCurtain {
  private curtainStage: Container | null = null;
  private curtain: Graphics | null = null;
  private targetAlpha = 0;
  private tweenStartedAt = 0;
  private tweenFromAlpha = 0;

  constructor(
    private readonly app: Application,
    private readonly frameMarkers: CurtainFrameMarkers,
  ) {}

  setLoadCurtain(active: boolean): void {
    this.ensureStage();
    const target = active ? CURTAIN_PEAK_ALPHA : 0;
    if (target === this.targetAlpha) return;
    this.targetAlpha = target;
    this.tweenFromAlpha = this.curtain?.alpha ?? 0;
    this.tweenStartedAt = performance.now();
  }

  /** Tear down — called by PixiRenderer.dispose. */
  destroy(): void {
    if (this.curtainStage) {
      this.app.ticker.remove(this.tick);
      this.curtainStage.destroy({ children: true });
      this.curtainStage = null;
      this.curtain = null;
    }
  }

  private ensureStage(): void {
    if (this.curtainStage) return;
    this.curtainStage = new Container();
    this.curtainStage.eventMode = 'none';
    this.app.stage.addChild(this.curtainStage);

    this.curtain = new Graphics();
    this.curtain.rect(-2048, -2048, 8192, 8192);
    this.curtain.fill({ color: BACKGROUND_COLOR, alpha: 1 });
    this.curtain.alpha = 0;
    this.curtainStage.addChild(this.curtain);
    this.app.ticker.add(this.tick);
  }

  /** Ticker callback (arrow form so `this` is bound). */
  private readonly tick = (): void => {
    const start = performance.now();
    const curtain = this.curtain;
    // Instant RISE (opaque before the destination reveals), smooth FADE-OUT.
    if (curtain && this.targetAlpha !== curtain.alpha) {
      curtain.alpha = curtainAlphaAt(this.tweenFromAlpha, this.targetAlpha, start - this.tweenStartedAt);
      // Hidden once fully faded so an idle curtain costs no draw.
      if (this.curtainStage) this.curtainStage.visible = curtain.alpha > 0;
    }
    this.frameMarkers.warpTickMs = performance.now() - start;
  };
}
