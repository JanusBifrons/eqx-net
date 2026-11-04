/**
 * Machined art — which two baked sun frames a ship shows, and how much of
 * the second. Pure and alloc-free: called per ship per frame (invariant #14).
 *
 * A ship is baked lit from `steps` sun azimuths spaced evenly round the hull.
 * The sprite rotates freely; the sun stays put in the world, so in the
 * sprite's own frame the sun sits at `sunAz − rotation`. We show the two
 * nearest baked azimuths, the second at alpha `t`, so the light slides
 * smoothly instead of stepping.
 */

export interface SunBlend {
  /** Frame drawn underneath, fully opaque. */
  j0: number;
  /** Frame drawn on top at alpha `t`. */
  j1: number;
  t: number;
}

export function sunFrameBlend(sunAz: number, rotation: number, steps: number, out: SunBlend): SunBlend {
  let u = ((sunAz - rotation) / (Math.PI * 2)) * steps;
  u = ((u % steps) + steps) % steps;
  const j0 = Math.floor(u) % steps;
  out.j0 = j0;
  out.j1 = (j0 + 1) % steps;
  out.t = u - Math.floor(u);
  return out;
}

/** The two layers of a Machined ship sprite (a Pixi Sprite pair in the game). */
export interface LightLayers<T> {
  a: { texture: T };
  b: { texture: T; alpha: number };
}

const _blend: SunBlend = { j0: 0, j1: 0, t: 0 };

/** Point the two layers at the right frames for this rotation. */
export function applySunBlend<T>(layers: LightLayers<T>, frames: readonly T[], sunAz: number, rotation: number): void {
  const n = frames.length;
  if (n === 0) return;
  sunFrameBlend(sunAz, rotation, n, _blend);
  layers.a.texture = frames[_blend.j0]!;
  layers.b.texture = frames[_blend.j1]!;
  layers.b.alpha = _blend.t;
}
