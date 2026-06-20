/**
 * Pure on-screen / dead-zone helpers for the halo radar (WS-B #2 + #4).
 *
 * No Pixi, no DOM — the orchestrator (`HaloRadar`) imports these and
 * applies the result. The bounds rect is in Pixi/world-container space
 * (Y-down), exactly the shape `Camera.getVisibleBounds()` returns:
 * `{ x, y, width, height }`. Entity poses are GAME-space (Y-up), so the
 * helpers flip game-Y → Pixi-Y (`pixiY = -gameY`) before the bounds test —
 * the same `pixiY = -gameY` convention every renderer site obeys.
 *
 * #2 (on-screen exclusion): an entity already on screen needs no off-screen
 *     indicator, so it is filtered at CANDIDATE-BUILD time rather than via a
 *     timer that lets the icon pop in, zoom, then vanish.
 * #4 (dead-zone / hysteresis): the "on screen" rect is shrunk by a fixed
 *     pixel inset (converted to world units) so a contact hovering at the
 *     exact viewport edge doesn't flicker on/off the ring as it jitters
 *     across the precise boundary. See docs/architecture/off-screen-indicators.md.
 */

export interface WorldBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Dead-zone hysteresis band, in SCREEN pixels, inset from each viewport
 * edge. An entity inside the shrunk rect counts as "on screen" (excluded
 * from the ring); an entity in the band between the shrunk rect and the
 * true edge is treated as off-screen so it keeps its ring indicator while
 * it lingers at the edge — no flicker across the boundary.
 *
 * Desktop uses a wider band (more screen real-estate, a larger ring +
 * glyphs); mobile uses a tighter band (smaller screen, smaller glyphs).
 * Values follow common off-screen-indicator practice (~3-5% of the shorter
 * screen dimension) — see docs/architecture/off-screen-indicators.md.
 */
export const DEAD_ZONE_PX_DESKTOP = 48;
export const DEAD_ZONE_PX_MOBILE = 28;

/**
 * True iff a GAME-space entity pose `(gameX, gameY)` falls inside the
 * Pixi-space `bounds` rect. Flips game-Y → Pixi-Y before the test.
 * Allocation-free (scalar comparisons only) — safe in the per-RAF radar
 * candidate-build loop (invariant #14).
 */
export function isEntityOnScreen(gameX: number, gameY: number, bounds: WorldBounds): boolean {
  const pixiY = -gameY;
  return (
    gameX >= bounds.x
    && gameX <= bounds.x + bounds.width
    && pixiY >= bounds.y
    && pixiY <= bounds.y + bounds.height
  );
}

/**
 * Shrinks `bounds` inward by `deadZonePx` screen pixels on every side
 * (converted to world units via `worldPerPx`), writing the result into the
 * caller-owned `out` rect. Allocation-free (invariant #14) — `HaloRadar`
 * holds `out` as a class-field scratch and reuses it every frame.
 *
 * The rect never inverts: if the inset would exceed half a dimension the
 * width/height clamp to 0 (a degenerate zero-area rect, so everything reads
 * as off-screen — the safe direction for an indicator that errs toward
 * SHOWING the contact).
 */
export function getVisibleBoundsWithDeadZone(
  bounds: WorldBounds,
  deadZonePx: number,
  worldPerPx: number,
  out: WorldBounds,
): WorldBounds {
  const insetWorld = deadZonePx * worldPerPx;
  const maxInsetW = bounds.width * 0.5;
  const maxInsetH = bounds.height * 0.5;
  const insetW = insetWorld > maxInsetW ? maxInsetW : insetWorld;
  const insetH = insetWorld > maxInsetH ? maxInsetH : insetWorld;
  out.x = bounds.x + insetW;
  out.y = bounds.y + insetH;
  out.width = bounds.width - 2 * insetW;
  out.height = bounds.height - 2 * insetH;
  return out;
}
