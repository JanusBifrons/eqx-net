import { Application, Container, Graphics, BlurFilter } from 'pixi.js';

/**
 * Pixi-driven warp-streak visual. Replaces the Phase-1 CSS gradient
 * with a real Pixi `Application` so:
 *   - The aesthetic is seamless with the gameplay renderer (both Pixi).
 *   - Future enhancements (procedural shaders, particle systems, the
 *     in-game ship sprite warping in as the overlay fades) can layer
 *     onto the same canvas without a CSS↔Pixi seam.
 *
 * Pure rendering. No state outside the Pixi handles + a few RAF-driven
 * streak transforms. `dispose()` is idempotent and tears the
 * Application down cleanly so the WarpScreen component can mount /
 * unmount this without GPU leaks.
 *
 * Resource discipline:
 *   - One streak `Graphics` per slot; reused across the animation. No
 *     per-frame allocation in `tick()`.
 *   - A single `BlurFilter` instance applied to the stage for motion
 *     blur. Quality kept low (2) so this never competes meaningfully
 *     with the gameplay renderer during initial-join.
 *   - The Pixi `Application` is constructed with `antialias: false` and
 *     `resolution: 1` — the warp visual is intentionally soft, no
 *     reason to pay DPR cost.
 */

export type WarpEffectIntensity = 'loading' | 'transit' | 'arrived';

interface IntensitySpec {
  /** Streak count. Higher = denser warp. */
  count: number;
  /** Base horizontal velocity in pixels-per-60fps-frame. */
  velocityBase: number;
  /** Random velocity variation added on top of `velocityBase`. */
  velocityRange: number;
  /** Alpha range [min, max] for streak opacity. */
  alphaRange: [number, number];
  /** Streak length range in pixels. */
  lengthRange: [number, number];
  /** Streak vertical thickness in pixels. */
  thickness: number;
  /** Blur amount (Pixi BlurFilter strength). */
  blur: number;
  /** Color tint as 24-bit RGB. */
  color: number;
}

const INTENSITY: Record<WarpEffectIntensity, IntensitySpec> = {
  loading: {
    count: 60,
    velocityBase: 3,
    velocityRange: 4,
    alphaRange: [0.15, 0.45],
    lengthRange: [40, 120],
    thickness: 1.5,
    blur: 1.2,
    color: 0x00ff88,
  },
  transit: {
    count: 120,
    velocityBase: 8,
    velocityRange: 10,
    alphaRange: [0.25, 0.75],
    lengthRange: [80, 220],
    thickness: 2,
    blur: 2.2,
    color: 0x00ff88,
  },
  arrived: {
    count: 12,
    velocityBase: 1,
    velocityRange: 1,
    alphaRange: [0.10, 0.30],
    lengthRange: [60, 140],
    thickness: 2,
    blur: 4,
    color: 0x00ff88,
  },
};

interface Streak {
  gfx: Graphics;
  velocity: number;
  length: number;
}

export class WarpEffect {
  private app: Application | null = null;
  private streaks: Streak[] = [];
  private container: Container | null = null;
  private parent: HTMLElement | null = null;
  private width = 0;
  private height = 0;
  private resizeObserver: ResizeObserver | null = null;
  private spec: IntensitySpec = INTENSITY.loading;
  private disposed = false;

  /** Boot the Pixi Application and start the streak animation. Idempotent
   *  in the sense that calling `init` twice on the same instance is a
   *  bug — wrap in a React `useEffect` with a single mount/unmount pair. */
  async init(parent: HTMLElement, intensity: WarpEffectIntensity): Promise<void> {
    if (this.disposed) return;
    this.parent = parent;
    this.spec = INTENSITY[intensity];

    const w = parent.clientWidth || window.innerWidth;
    const h = parent.clientHeight || window.innerHeight;
    this.width = w;
    this.height = h;

    this.app = new Application();
    await this.app.init({
      width: w,
      height: h,
      background: 0x05070f,
      antialias: false,
      // DPR=1 — the warp visual is soft by intent; no value in paying
      // the device-pixel cost during a transient overlay.
      resolution: 1,
      autoDensity: false,
    });

    // StrictMode safety — if the consumer disposed during init, skip
    // the parent.appendChild + ticker.add so we don't leak the canvas.
    if (this.disposed) {
      this.app.destroy(true, { children: true });
      this.app = null;
      return;
    }

    this.app.canvas.style.position = 'absolute';
    this.app.canvas.style.inset = '0';
    this.app.canvas.style.width = '100%';
    this.app.canvas.style.height = '100%';
    this.app.canvas.style.display = 'block';
    this.app.canvas.style.pointerEvents = 'none';
    parent.appendChild(this.app.canvas);

    this.container = new Container();
    this.app.stage.addChild(this.container);

    // Motion blur on the streak container (not on individual streaks)
    // so the blur cost is paid once per frame regardless of streak
    // count. Quality kept low (2) so this stays cheap.
    const blur = new BlurFilter({ strength: this.spec.blur, quality: 2 });
    this.container.filters = [blur];

    this.spawnStreaks();
    this.app.ticker.add(this.tick);

    // Resize handling — the warp screen is full-screen, so DPR or
    // orientation changes can resize the container.
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(parent);
  }

  /** Recreate the streak set. Cheap — destroys + repopulates the pool. */
  setIntensity(intensity: WarpEffectIntensity): void {
    this.spec = INTENSITY[intensity];
    if (this.container) {
      const blur = new BlurFilter({ strength: this.spec.blur, quality: 2 });
      this.container.filters = [blur];
    }
    this.spawnStreaks();
  }

  private spawnStreaks(): void {
    if (!this.container) return;
    // Clear existing.
    for (const s of this.streaks) s.gfx.destroy();
    this.streaks.length = 0;

    const { color, count, velocityBase, velocityRange, alphaRange, lengthRange, thickness } = this.spec;
    for (let i = 0; i < count; i++) {
      const length = lengthRange[0] + Math.random() * (lengthRange[1] - lengthRange[0]);
      const gfx = new Graphics();
      gfx.rect(0, -thickness / 2, length, thickness).fill({ color, alpha: 1 });
      gfx.alpha = alphaRange[0] + Math.random() * (alphaRange[1] - alphaRange[0]);
      gfx.x = Math.random() * this.width;
      gfx.y = Math.random() * this.height;
      this.container.addChild(gfx);
      this.streaks.push({
        gfx,
        velocity: velocityBase + Math.random() * velocityRange,
        length,
      });
    }
  }

  private tick = (): void => {
    if (!this.app) return;
    // deltaTime is 1.0 at 60 fps; scale velocities accordingly.
    const dt = this.app.ticker.deltaTime;
    const w = this.width;
    const h = this.height;
    for (const s of this.streaks) {
      s.gfx.x += s.velocity * dt;
      if (s.gfx.x > w + s.length) {
        // Recycle: re-emit from off-screen left at a fresh y.
        s.gfx.x = -s.length - Math.random() * w * 0.2;
        s.gfx.y = Math.random() * h;
      }
    }
  };

  private resize(): void {
    if (!this.app || !this.parent) return;
    const w = this.parent.clientWidth || window.innerWidth;
    const h = this.parent.clientHeight || window.innerHeight;
    if (w <= 0 || h <= 0) return;
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.app.renderer.resize(w, h);
  }

  dispose(): void {
    this.disposed = true;
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.app) {
      this.app.ticker.remove(this.tick);
      this.app.destroy(true, { children: true });
      this.app = null;
    }
    this.streaks.length = 0;
    this.container = null;
    this.parent = null;
  }
}
