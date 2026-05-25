/**
 * Pure-math helpers for halo radar arrow projection. Extracted from
 * the monolithic `HaloRadar.ts` per the god-file refactor plan
 * (`docs/plans/refactor-god-files.md`, commit 7). No Pixi, no DOM —
 * the orchestrator imports these and applies the result.
 */

export interface HaloProjectionParams {
  /** Inner ring radius in **screen pixels**. */
  innerRadiusPx: number;
  /** Outer ring radius in **screen pixels**. */
  outerRadiusPx: number;
  /** World-unit distances bracketing the ring radius lerp. */
  distMin: number;
  distMax: number;
  scaleNear: number;
  scaleFar: number;
}

export interface HaloProjection {
  /** True only for the degenerate case where the POI overlaps the player
   *  position exactly (no defined bearing). The radar no longer hides
   *  arrows based on viewport visibility or near-cutoff — every in-range
   *  entity gets a continuously-tracked arrow regardless of on-screen
   *  status, so the only "hide me" case is the divide-by-zero one. */
  hidden: boolean;
  /** Bearing from the player to the POI in **world space** (atan2
   *  convention: 0 = east, +π/2 = north, −π/2 = south). Caller composes the
   *  arrow's screen position via `playerScreenX + cos(theta) * radiusPx` and
   *  `playerScreenY − sin(theta) * radiusPx` (screen y points down, so y is
   *  negated). */
  theta: number;
  /** Screen-space radius from the player, in pixels. */
  radiusPx: number;
  /** Arrow scale factor (1.0 = built size). */
  scale: number;
}

// Phase M — exponent for the exp-saturation distance curve in
// `projectArrow`. Higher = more aggressive push toward the outer ring.
// 12 is intentionally steep: entities past the interest-shedding
// boundary (~2000 u) are essentially glued to the outer ring (t > 0.95),
// and only entities within close-engagement range (900–~1500 u)
// actually traverse the band. Matches the user's mental model: arrows
// fly in to the edge at max radar range, sit there, then become
// reactive when entities get within realistic close range.
const EXP_CURVE_K = 12;

export function clamp(t: number, lo: number, hi: number): number {
  return t < lo ? lo : t > hi ? hi : t;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Pure helper. Computes the bearing, screen-pixel ring radius, and arrow
 * scale for a POI relative to the player. Both positions are in world
 * coordinates. The arrow is rendered for EVERY in-range entity regardless
 * of on-screen status — the user explicitly wanted continuous tracking
 * during high-speed flybys, so there's no visibility hide and no
 * near-cutoff. The only "hidden" case is the degenerate zero-distance one.
 *
 * Pre-Phase E the function returned a Pixi-coord arrow position (world
 * coords with y flipped). The radar drew into the viewport, so the arrow
 * went through the viewport's camera-follow transform each frame — making
 * arrows drift behind the player during fast motion. The current shape
 * returns only the bearing + radius; the caller composes a screen-space
 * position using the player's current screen-pixel coordinates.
 */
export function projectArrow(
  local: { x: number; y: number },
  poi: { x: number; y: number },
  params: HaloProjectionParams,
): HaloProjection {
  const dx = poi.x - local.x;
  const dy = poi.y - local.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return { hidden: true, theta: 0, radiusPx: 0, scale: 0 };

  const theta = Math.atan2(dy, dx);
  // Phase L — exponential-saturation distance curve. The OUTER ring (screen
  // edge) is the default: a 1 - exp(-k·normalized) curve pulls most
  // distances close to t=1 (outer) and only entities very close to
  // distMin drop toward t=0 (inner). normalized < 0 (dist < distMin)
  // clamps to t=0, so very-close entities sit at the inner ring instead
  // of disappearing — Phase O kept the curve but dropped the hard hide.
  const normalized = (dist - params.distMin) / (params.distMax - params.distMin);
  const k = EXP_CURVE_K;
  const tRaw = (1 - Math.exp(-k * normalized)) / (1 - Math.exp(-k));
  const t = clamp(tRaw, 0, 1);
  const radiusPx = lerp(params.innerRadiusPx, params.outerRadiusPx, t);
  const scale = lerp(params.scaleNear, params.scaleFar, t);

  return { hidden: false, theta, radiusPx, scale };
}
