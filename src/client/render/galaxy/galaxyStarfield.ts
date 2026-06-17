/**
 * Zoom-aware LOD parallax starfield for the FULL-PAGE galaxy map (Equinox Phase 9
 * item 3). Ported from eqx-peri's `StarfieldRenderer` (`src/game/rendering/
 * StarfieldRenderer.ts`): each layer owns a world-space tile size tuned for a
 * zoom window plus a fade window keyed to the map's zoom `scale`, so star density
 * stays ~constant across the whole zoom range and the field zooms WITH the map.
 *
 * This replaces, on the galaxy map, the fixed-size `StarfieldBackground`
 * `TilingSprite` parallax (which is tied to the WORLD camera and looked
 * "low-res / aliased when zoomed" — the bug report) — but only there: the
 * gameplay `StarfieldBackground` is untouched. Pure math lives here (the
 * `galaxyTerritories.ts` idiom: logic unit-tested, the Pixi draw stays in
 * `GalaxyMapLayer`).
 */

export interface GalaxyStarLayer {
  /** Camera-pan contribution: 0 = pinned, 1 = moves 1:1 with the map. Smaller =
   *  farther (slower) parallax layer. */
  readonly parallax: number;
  /** World units per tile (bigger = a zoomed-OUT layer). */
  readonly tileSize: number;
  readonly starsPerTile: number;
  /** Star radius in SCREEN pixels (constant, so stars stay crisp at any zoom). */
  readonly radius: number;
  readonly color: number;
  readonly baseAlpha: number;
  readonly seed: number;
  /** scale ≤ this ⇒ alpha 0 (zoom-out kills this layer). */
  readonly fadeInAt: number;
  /** scale ≥ this ⇒ fully faded in. */
  readonly fullAt: number;
  /** scale ≥ this ⇒ alpha starts falling (zoom-in retires this layer). */
  readonly dimAt: number;
  /** scale ≥ this ⇒ alpha 0. */
  readonly fadedAt: number;
}

/**
 * Layers tuned for the galaxy map's zoom range (`clusterRoot.scale` is clamped
 * 0.12–4 by the pan/zoom Camera; the initial fit lands ~0.3–0.7). Adjacent
 * windows overlap so ≥1 layer is always visible and crossfades keep the count
 * roughly constant. Different seed + tileSize per layer ⇒ completely different
 * star patterns at each zoom (no star persists across a layer transition).
 */
export const GALAXY_STAR_LAYERS: readonly GalaxyStarLayer[] = [
  // Overview (zoomed out): sparse bright anchors.
  { parallax: 0.20, tileSize: 1400, starsPerTile: 3, radius: 1.7, color: 0xffffff, baseAlpha: 0.85, seed: 11, fadeInAt: 0.06, fullAt: 0.14, dimAt: 0.45, fadedAt: 0.75 },
  // Mid.
  { parallax: 0.12, tileSize: 620, starsPerTile: 3, radius: 1.4, color: 0xdfe8ff, baseAlpha: 0.85, seed: 23, fadeInAt: 0.22, fullAt: 0.40, dimAt: 1.05, fadedAt: 1.6 },
  // Near.
  { parallax: 0.07, tileSize: 280, starsPerTile: 3, radius: 1.1, color: 0xcfe0ff, baseAlpha: 0.8, seed: 37, fadeInAt: 0.7, fullAt: 1.15, dimAt: 2.4, fadedAt: 3.4 },
  // Closest (zoomed in): fine dust.
  { parallax: 0.04, tileSize: 130, starsPerTile: 3, radius: 0.9, color: 0xbcd0f5, baseAlpha: 0.7, seed: 51, fadeInAt: 1.6, fullAt: 2.5, dimAt: 4.5, fadedAt: 6.0 },
];

/** Safety cap on the per-axis tile half-range (prevents runaway iteration if a
 *  layer is evaluated far outside its intended zoom window). */
export const STAR_MAX_TILE_HALF = 9;

/** Fast deterministic 32-bit Murmur-style hash of four ints → float in [0, 1). */
export function starHash(a: number, b: number, c: number, d: number): number {
  let h = Math.imul(a, 0x9e3779b9) ^ Math.imul(b, 0x6c62272e);
  h = Math.imul(h ^ c, 0x46295a8b) ^ Math.imul(d, 0x7feb352d);
  h = Math.imul(h ^ (h >>> 16), 0x8b76b8c3);
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

/**
 * Per-layer alpha at zoom `scale` — 0 outside the layer's fade window, smoothly
 * ramped in at the low end and out at the high end. Pure; unit-locked.
 */
export function starLayerAlphaAt(layer: GalaxyStarLayer, scale: number): number {
  if (scale <= layer.fadeInAt || scale >= layer.fadedAt) return 0;
  const fadeIn = Math.min(1, (scale - layer.fadeInAt) / (layer.fullAt - layer.fadeInAt));
  const fadeOut = Math.min(1, (layer.fadedAt - scale) / (layer.fadedAt - layer.dimAt));
  return layer.baseAlpha * Math.max(0, Math.min(fadeIn, fadeOut));
}
