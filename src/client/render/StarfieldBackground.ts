import { Application, Graphics } from 'pixi.js';
import type { Camera } from './worker/Camera';
import {
  STAR_MAX_TILE_HALF,
  starHash,
  starLayerAlphaAt,
  starRadiusAt,
  type LodStarLayer,
} from './lodStarfield';

/**
 * Zoom-aware LOD parallax starfield behind the gameplay viewport.
 *
 * Replaces the former fixed-size three-`TilingSprite` field, which read ONLY the
 * camera PAN (`tilePosition`) and never the zoom `scale`, so it didn't respond to
 * zoom at all — and its constant near layer rendered chunky 2-px dots that read
 * as "huge stars in front of the gameplay" at any zoom (the bug report). This is
 * the same LOD mechanism the galaxy map uses (`render/lodStarfield.ts` +
 * `galaxy/galaxyStarfield.ts`), ported from eqx-peri's `StarfieldRenderer`: as
 * you zoom, layers FADE OUT and others FADE IN, density stays ~constant, and the
 * field zooms WITH the world.
 *
 * It's a single `Graphics` on `app.stage` (BEHIND the world container — added
 * before it), redrawn each frame from the camera's `center` (pan) + `scale`
 * (zoom) + screen size. Stars draw at a constant SCREEN radius so they stay
 * crisp and small; the `* scale` on their screen positions is what makes the
 * field zoom.
 */

/**
 * Layers tuned for the GAMEPLAY camera zoom range (`Camera` clamps scale 0.4–4;
 * default ~1.0). Distinct from the galaxy map's 0.12–4 table. Biased toward fine
 * dust (small `radius`, low `parallax` so the backdrop stays "deep"), with
 * overlapping fade windows so ≥1 layer is visible at every zoom and crossfades
 * keep the star count roughly constant. NO permanent chunky near layer.
 */
// `tileSize` is set so the SCREEN-space tile (`tileSize × peakScale`) is ~150 px
// at each layer's peak zoom — small enough that several tiles always cover the
// viewport, so density stays ~constant and the field does NOT thin out when you
// zoom in (zooming in reveals the finer near/dust layers — "fields appear").
export const GAMEPLAY_STAR_LAYERS: readonly LodStarLayer[] = [
  // Far / overview — the field you see zoomed OUT (peak ~0.7).
  { parallax: 0.05, tileSize: 220, starsPerTile: 4, radius: 0.95, color: 0xffffff, baseAlpha: 0.85, seed: 101, fadeInAt: 0.20, fullAt: 0.45, dimAt: 0.95, fadedAt: 1.70 },
  // Mid — full around the default zoom (~1.0; peak ~1.45).
  { parallax: 0.09, tileSize: 110, starsPerTile: 4, radius: 0.90, color: 0xeaf0ff, baseAlpha: 0.80, seed: 202, fadeInAt: 0.65, fullAt: 1.05, dimAt: 1.90, fadedAt: 3.10 },
  // Near — fades in as you zoom in (peak ~2.85).
  { parallax: 0.13, tileSize: 56, starsPerTile: 4, radius: 0.85, color: 0xd7e2ff, baseAlpha: 0.75, seed: 303, fadeInAt: 1.50, fullAt: 2.30, dimAt: 3.40, fadedAt: 4.60 },
  // Closest dust — only at high zoom-in (peak ~3.95).
  { parallax: 0.17, tileSize: 40, starsPerTile: 4, radius: 0.80, color: 0xc7d6f7, baseAlpha: 0.70, seed: 404, fadeInAt: 2.60, fullAt: 3.40, dimAt: 4.50, fadedAt: 6.00 },
];

export class StarfieldBackground {
  private gfx: Graphics | null = null;

  /** Create the backdrop `Graphics` + attach to `app.stage`. Must be called
   *  BEFORE the gameplay world container is added so the starfield is at the
   *  bottom of the z-order. */
  attach(app: Application): void {
    this.gfx = new Graphics();
    app.stage.addChild(this.gfx);
  }

  /** Per-frame redraw: parallax-pan by `camera.center` AND scale by
   *  `camera.scale` (the zoom response), with per-layer fade keyed to the zoom
   *  so layers cross-fade in/out. Drawn in SCREEN space (the field lives on
   *  `app.stage`, outside the zoomed world container). */
  update(camera: Camera): void {
    const g = this.gfx;
    if (!g) return;
    g.clear();
    const scale = camera.scale.x;
    const screenW = camera.screenWidth;
    const screenH = camera.screenHeight;
    if (scale <= 0 || screenW === 0 || screenH === 0) {
      g.visible = false;
      return;
    }
    g.visible = true;
    const scx = screenW / 2;
    const scy = screenH / 2;
    // World point under the screen centre (drives parallax pan). Same sign on
    // both axes — `camera.center` is already in the world-container frame the
    // screen draw shares (the entity-level Y-flip is below the camera).
    const camX = camera.center.x;
    const camY = camera.center.y;
    const hw = screenW / (2 * scale); // half-viewport in world units
    const hh = screenH / (2 * scale);

    for (const layer of GAMEPLAY_STAR_LAYERS) {
      const alpha = starLayerAlphaAt(layer, scale);
      if (alpha <= 0) continue;
      const T = layer.tileSize;
      const p = layer.parallax;
      const bgCx = camX * p;
      const bgCy = camY * p;
      const cTX = Math.round(bgCx / T);
      const cTY = Math.round(bgCy / T);
      const halfX = Math.min(STAR_MAX_TILE_HALF, Math.ceil(hw / T) + 1);
      const halfY = Math.min(STAR_MAX_TILE_HALF, Math.ceil(hh / T) + 1);
      // One fill per layer (single colour + alpha); each star's radius varies so
      // the field reads as fine dust with a few brighter highlights.
      for (let atx = cTX - halfX; atx <= cTX + halfX; atx++) {
        for (let aty = cTY - halfY; aty <= cTY + halfY; aty++) {
          for (let i = 0; i < layer.starsPerTile; i++) {
            const sx = (atx + starHash(atx, aty, layer.seed, i * 2)) * T;
            const sy = (aty + starHash(atx, aty, layer.seed, i * 2 + 1)) * T;
            const r = starRadiusAt(layer, starHash(atx, aty, layer.seed + 101, i + 1));
            g.circle(scx + (sx - bgCx) * scale, scy + (sy - bgCy) * scale, r);
          }
        }
      }
      g.fill({ color: layer.color, alpha });
    }
  }

  /** Canvas resize — no-op: `update()` reads the camera's live screen size each
   *  frame and redraws, so there's nothing to resize. Kept for the call sites. */
  resize(_w: number, _h: number): void {
    // intentionally empty (see docstring)
  }

  destroy(): void {
    this.gfx?.destroy();
    this.gfx = null;
  }
}
