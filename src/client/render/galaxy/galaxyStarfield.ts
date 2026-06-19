/**
 * Zoom-aware LOD parallax starfield LAYER TABLE for the FULL-PAGE galaxy map
 * (Equinox Phase 9 item 3). The pure LOD core (`LodStarLayer`, `starHash`,
 * `starLayerAlphaAt`, `starRadiusAt`, `STAR_MAX_TILE_HALF`) now lives in the
 * shared, render-agnostic `render/lodStarfield.ts` (so the gameplay backdrop
 * `StarfieldBackground.ts` reuses the SAME math); this module keeps only the
 * galaxy-map-tuned layer table + re-exports the core so existing
 * `./galaxyStarfield` importers (`GalaxyMapLayer`, `galaxyStarfield.test.ts`)
 * are unchanged.
 *
 * The Pixi draw stays in `GalaxyMapLayer.drawStarfield` (the `galaxyTerritories`
 * idiom: logic unit-tested, the draw in the layer).
 */

export {
  STAR_MAX_TILE_HALF,
  starHash,
  starLayerAlphaAt,
  starRadiusAt,
} from '../lodStarfield';
// Back-compat alias: the galaxy map's historical type name for a star layer.
export type { LodStarLayer as GalaxyStarLayer } from '../lodStarfield';

import type { LodStarLayer } from '../lodStarfield';

/**
 * Layers tuned for the galaxy map's zoom range (`clusterRoot.scale` is clamped
 * 0.12–4 by the pan/zoom Camera; the initial fit lands ~0.3–0.7). Adjacent
 * windows overlap so ≥1 layer is always visible and crossfades keep the count
 * roughly constant. Different seed + tileSize per layer ⇒ completely different
 * star patterns at each zoom (no star persists across a layer transition).
 *
 * `tileSize` is set so the SCREEN-space tile (`tileSize × peakScale`) is ~120 px
 * at each layer's peak — small enough that several tiles always cover the
 * viewport, so density stays ~constant and the field never thins out when you
 * zoom in. `radius` is the BASE; each star varies 0.5×–1.3× via `starRadiusAt`
 * so most are fine dust with a few brighter — no chunky "too-big" stars.
 */
export const GALAXY_STAR_LAYERS: readonly LodStarLayer[] = [
  // Overview (zoomed out): the background field.
  { parallax: 0.08, tileSize: 460, starsPerTile: 4, radius: 1.0, color: 0xffffff, baseAlpha: 0.9, seed: 11, fadeInAt: 0.05, fullAt: 0.13, dimAt: 0.50, fadedAt: 0.95 },
  // Mid.
  { parallax: 0.12, tileSize: 200, starsPerTile: 4, radius: 0.95, color: 0xeaf0ff, baseAlpha: 0.85, seed: 23, fadeInAt: 0.30, fullAt: 0.55, dimAt: 1.20, fadedAt: 2.10 },
  // Near.
  { parallax: 0.16, tileSize: 80, starsPerTile: 4, radius: 0.9, color: 0xd7e2ff, baseAlpha: 0.8, seed: 37, fadeInAt: 0.95, fullAt: 1.60, dimAt: 3.00, fadedAt: 4.60 },
  // Closest (zoomed in): fine dust.
  { parallax: 0.20, tileSize: 40, starsPerTile: 4, radius: 0.85, color: 0xc7d6f7, baseAlpha: 0.75, seed: 51, fadeInAt: 2.40, fullAt: 3.40, dimAt: 5.50, fadedAt: 8.00 },
];
