import { Application, Graphics, TilingSprite } from 'pixi.js';
import type { Camera } from './worker/Camera';

/**
 * Three-layer parallax starfield rendered behind the gameplay viewport.
 * Each layer is a `TilingSprite` filled with a procedurally-generated
 * star texture; per-frame, the tile origin shifts opposite to the camera
 * by a layer-specific `parallaxFactor`, producing the "deeper layers
 * move less" effect.
 *
 * Layers are attached directly to `app.stage` BEFORE the viewport is
 * added, so insertion order puts them under all gameplay content. They
 * are NOT inside the viewport — the viewport's world transform would
 * cancel the parallax we want.
 *
 * Density: ~100 stars per 2048² tile × 3 layers ≈ ~150 visible per
 * 1920×1080 view, matching the "medium" density the user picked.
 */

const TILE_SIZE = 2048;

interface LayerSpec {
  /** 0 = fixed in world (full counter-camera motion), 1 = fixed in screen
   *  (zero relative motion). Smaller = "deeper". */
  factor: number;
  stars: number;
  /** Radius in pixels of each star dot. */
  size: number;
  /** 0..1 base alpha for the star dot in the texture. */
  alpha: number;
}

const LAYERS: readonly LayerSpec[] = [
  { factor: 0.10, stars: 100, size: 1, alpha: 0.45 }, // far  — barely moves
  { factor: 0.25, stars:  80, size: 1, alpha: 0.65 }, // mid
  { factor: 0.50, stars:  60, size: 2, alpha: 0.85 }, // near — moves most
];

interface Layer {
  spec: LayerSpec;
  sprite: TilingSprite;
}

export class StarfieldBackground {
  private layers: Layer[] = [];

  /** Build textures + tiling sprites and attach to `app.stage`. Must be
   *  called BEFORE the gameplay viewport is added to the stage so the
   *  starfield ends up at the bottom of the z-order. */
  attach(app: Application): void {
    const w = app.renderer.width;
    const h = app.renderer.height;
    for (const spec of LAYERS) {
      const texture = this.buildStarTexture(app, spec);
      const sprite = new TilingSprite({ texture, width: w, height: h });
      app.stage.addChild(sprite);
      this.layers.push({ spec, sprite });
    }
  }

  private buildStarTexture(app: Application, spec: LayerSpec): ReturnType<Application['renderer']['generateTexture']> {
    const g = new Graphics();
    // Deterministic-feeling but uncorrelated PRNG seeded per-layer so the
    // three textures don't share star positions. Math.random is fine
    // here — the tile is only generated once at init.
    for (let i = 0; i < spec.stars; i++) {
      const x = Math.random() * TILE_SIZE;
      const y = Math.random() * TILE_SIZE;
      g.circle(x, y, spec.size).fill({ color: 0xffffff, alpha: spec.alpha });
    }
    const texture = app.renderer.generateTexture(g);
    g.destroy();
    return texture;
  }

  /** Per-frame update. Stars slide opposite to the camera at the layer's
   *  parallax factor; same sign on both axes since `camera.center` is
   *  already in Pixi screen-space (the Y-flip happens at the entity
   *  level, not at the camera level). */
  update(camera: Camera): void {
    const cx = camera.center.x;
    const cy = camera.center.y;
    for (const layer of this.layers) {
      layer.sprite.tilePosition.x = -cx * layer.spec.factor;
      layer.sprite.tilePosition.y = -cy * layer.spec.factor;
    }
  }

  /** Canvas resize — stretch each tiling sprite to cover the new size.
   *  The texture itself stays at TILE_SIZE; TilingSprite just repeats it
   *  as needed. */
  resize(w: number, h: number): void {
    for (const layer of this.layers) {
      layer.sprite.width = w;
      layer.sprite.height = h;
    }
  }

  destroy(): void {
    for (const layer of this.layers) {
      layer.sprite.destroy();
    }
    this.layers.length = 0;
  }
}
