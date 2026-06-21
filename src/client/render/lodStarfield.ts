/**
 * Zoom-aware LOD parallax starfield — the PURE, render-agnostic core, shared by
 * the full-page galaxy map (`galaxy/galaxyStarfield.ts` → `GalaxyMapLayer`) AND
 * the in-game gameplay backdrop (`StarfieldBackground.ts`).
 *
 * Each layer owns a world-space tile size tuned for a zoom window plus a fade
 * window keyed to the camera's zoom `scale`, so as you zoom some layers FADE OUT
 * and others FADE IN (the eqx-peri `StarfieldRenderer` concept), star density
 * stays ~constant across the whole zoom range, and the field zooms WITH the
 * camera instead of sitting as a fixed-size screen overlay.
 *
 * NO Pixi import here on purpose — these are scalar helpers the (node-env) unit
 * tests import directly; the actual Pixi `Graphics` draw lives in each consumer
 * (one screen-space draw per surface), which differs only in how it sources the
 * camera centre / scale.
 */

export interface LodStarLayer {
  /** Camera-pan contribution: 0 = pinned, 1 = moves 1:1 with the camera. Smaller
   *  = farther (slower) parallax layer. */
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

/** Absolute backstop on the per-axis tile half-range — a runaway-iteration guard
 *  for the degenerate case (a layer somehow evaluated far outside its zoom
 *  window, where `alpha <= 0` would already have skipped it). It is NOT the
 *  coverage limiter: `starTileHalfRange` sizes the range to the live viewport and
 *  only clamps to this backstop, which sits comfortably above any real device at
 *  the zoom-out floor (a 4K screen needs ~39 half-tiles for the coarsest layer). */
export const STAR_MAX_TILE_HALF = 64;

/**
 * Per-axis tile half-range needed to TILE `halfViewportWorld` world-units with
 * `tileSize`-sized tiles, plus a one-tile pad so the field never shows a hard
 * edge, clamped to the `STAR_MAX_TILE_HALF` backstop. This is the single source
 * of truth for BOTH starfield draw loops (gameplay `StarfieldBackground` + the
 * galaxy map `GalaxyMapLayer.drawStarfield`).
 *
 * The square-cutoff bug (Phase 5; the user's "literally zero change" report): a
 * static `STAR_MAX_TILE_HALF = 12` clamped coverage to ±12 tiles, which at the
 * zoom-out floor is far narrower than a wide/tall viewport in world units — so
 * tiles stopped and a hard square edge appeared. The prior fix (#11) only raised
 * the layer *alpha* at the floor; it never touched tile COVERAGE. Sizing the
 * range to the viewport (and only clamping to a generous backstop) is the
 * coverage fix. Pure; unit-locked.
 */
export function starTileHalfRange(halfViewportWorld: number, tileSize: number): number {
  return Math.min(STAR_MAX_TILE_HALF, Math.ceil(halfViewportWorld / tileSize) + 1);
}

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
export function starLayerAlphaAt(layer: LodStarLayer, scale: number): number {
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
export function starRadiusAt(layer: LodStarLayer, hash01: number): number {
  return layer.radius * (0.5 + 0.8 * hash01 * hash01);
}
