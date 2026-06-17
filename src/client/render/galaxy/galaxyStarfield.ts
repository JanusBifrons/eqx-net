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
 *
 * `tileSize` is set so the SCREEN-space tile (`tileSize × peakScale`) is ~120 px
 * at each layer's peak — small enough that several tiles always cover the
 * viewport, so density stays ~constant and the field never thins out when you
 * zoom in (the 2026-06-17 "looks empty zoomed in" report; the old tiles were
 * 130–1400 world units → only ~1 tile of stars fit on screen at high zoom).
 * `radius` is the BASE; each star varies 0.5×–1.3× via {@link starRadiusAt} so
 * most are fine dust with a few brighter — no chunky "too-big" stars (the old
 * uniform 1.7 px overview layer read as oversized at DPR ≥ 2).
 */
export const GALAXY_STAR_LAYERS: readonly GalaxyStarLayer[] = [
  // Overview (zoomed out): the background field.
  { parallax: 0.08, tileSize: 460, starsPerTile: 4, radius: 1.0, color: 0xffffff, baseAlpha: 0.9, seed: 11, fadeInAt: 0.05, fullAt: 0.13, dimAt: 0.50, fadedAt: 0.95 },
  // Mid.
  { parallax: 0.12, tileSize: 200, starsPerTile: 4, radius: 0.95, color: 0xeaf0ff, baseAlpha: 0.85, seed: 23, fadeInAt: 0.30, fullAt: 0.55, dimAt: 1.20, fadedAt: 2.10 },
  // Near.
  { parallax: 0.16, tileSize: 80, starsPerTile: 4, radius: 0.9, color: 0xd7e2ff, baseAlpha: 0.8, seed: 37, fadeInAt: 0.95, fullAt: 1.60, dimAt: 3.00, fadedAt: 4.60 },
  // Closest (zoomed in): fine dust.
  { parallax: 0.20, tileSize: 40, starsPerTile: 4, radius: 0.85, color: 0xc7d6f7, baseAlpha: 0.75, seed: 51, fadeInAt: 2.40, fullAt: 3.40, dimAt: 5.50, fadedAt: 8.00 },
];

/** Safety cap on the per-axis tile half-range (prevents runaway iteration if a
 *  layer is evaluated far outside its intended zoom window). Larger than before
 *  because the smaller tiles need more of them to cover the viewport. */
export const STAR_MAX_TILE_HALF = 12;

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

/**
 * Per-star screen radius from a [0,1) hash. Squaring the hash biases the
 * distribution toward the LOW end, so most stars are fine dust (~0.5×) with a
 * few brighter highlights (up to ~1.3×) — no uniform chunky dots. Pure.
 */
export function starRadiusAt(layer: GalaxyStarLayer, hash01: number): number {
  return layer.radius * (0.5 + 0.8 * hash01 * hash01);
}
