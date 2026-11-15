/**
 * A beam's look ACROSS its width (the capital heavy beam): a colour/alpha
 * profile from the centre line out to the soft edge, baked into one tiny
 * shared texture per profile (`BeamSpritePool`). Pure data + a pure pixel
 * builder, no Pixi, so the profile is unit-lockable headless.
 */

/** One stop of a cross-section: at `at` (0 = the centre line, 1 = the drawn
 *  edge), colour `color` (0xRRGGBB) at `alpha` (straight, 0..1). */
export interface BeamCrossSectionStop {
  readonly at: number;
  readonly color: number;
  readonly alpha: number;
}

/**
 * A beam drawn with a baked colour cross-section instead of a tinted flat
 * texture. `stops` run centre (at 0) to edge (at 1), sorted. `span`: the drawn
 * sprite is this many times the style's core `width` wide, so the opaque body
 * (alpha 1 out to `1 / span`) is the core width and the glow falls off beyond
 * it. The sprite is drawn untinted (white): the colours are in the texture.
 */
export interface BeamCrossSection {
  readonly stops: readonly BeamCrossSectionStop[];
  readonly span: number;
}

/** Rows in a cross-section texture (linear filtering smooths between them). */
export const CROSS_SECTION_ROWS = 32;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** The profile's straight-alpha colour at distance `d` (0 centre .. 1 edge),
 *  as [r, g, b, a] (0..255 / 0..1) into `out`. */
export function crossSectionAt(cs: BeamCrossSection, d: number, out: number[]): number[] {
  const s = cs.stops;
  let i = 0;
  while (i < s.length - 1 && s[i + 1]!.at < d) i++;
  const a = s[i]!, b = s[Math.min(i + 1, s.length - 1)]!;
  const t = b.at > a.at ? Math.min(1, Math.max(0, (d - a.at) / (b.at - a.at))) : 0;
  out[0] = lerp((a.color >> 16) & 255, (b.color >> 16) & 255, t);
  out[1] = lerp((a.color >> 8) & 255, (b.color >> 8) & 255, t);
  out[2] = lerp(a.color & 255, b.color & 255, t);
  out[3] = lerp(a.alpha, b.alpha, t);
  return out;
}

/**
 * The texture pixels of a cross-section: `w` × `rows` RGBA, PREMULTIPLIED
 * alpha, row 0 and the last row at the edge, the centre line between the two
 * middle rows. Each column is the same profile × `colAlpha(x)` (a fade tail
 * passes a ramp; the solid body 1).
 */
export function crossSectionPixels(
  cs: BeamCrossSection, w: number, rows: number, colAlpha: (x: number) => number = () => 1,
): Uint8Array {
  const px = new Uint8Array(w * rows * 4);
  const c: number[] = [0, 0, 0, 0];
  for (let y = 0; y < rows; y++) {
    const d = Math.abs((y + 0.5) / rows - 0.5) * 2;
    crossSectionAt(cs, d, c);
    for (let x = 0; x < w; x++) {
      const a = c[3]! * colAlpha(x);
      const o = (y * w + x) * 4;
      px[o] = Math.round(c[0]! * a);
      px[o + 1] = Math.round(c[1]! * a);
      px[o + 2] = Math.round(c[2]! * a);
      px[o + 3] = Math.round(a * 255);
    }
  }
  return px;
}
