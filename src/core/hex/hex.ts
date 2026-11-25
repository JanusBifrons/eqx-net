/**
 * Pointy-top axial hex maths (pure, blind core). One home for the hex
 * projection used by the galaxy map (`galaxy/galaxy.ts` re-exports
 * {@link axialToPixel}; the client's `galaxyHexDraw.ts` re-exports
 * {@link hexVertices}) and by the base-platform deck (`hex/plates.ts`).
 *
 * Conventions:
 * - Axial (q, r): q runs east, r runs south-east; cube s = -q - r.
 * - `size` is the hex CIRCUMRADIUS (centre to corner). Flat-to-flat width is
 *   `size * sqrt(3)`; see {@link hexSizeFromFlat}.
 * - Pixel y grows with r (map pixels are south-down), exactly as the galaxy
 *   map has always projected.
 * - Corners are at 30°, 90°, …, 330°: corner `i` → edge `i` runs to corner
 *   `i + 1`, and edge `i` faces neighbour {@link HEX_DIRS}`[i]`.
 *
 * Hot-loop rule (invariant 14): every `…Into` function writes into a
 * caller-owned scratch object / array and allocates nothing.
 */

/** Axial hex coordinates. q runs east, r runs south-east. (0,0) = centre. */
export interface AxialHex {
  q: number;
  r: number;
}

/** A mutable 2-D point, used as an out-param by the `…Into` functions. */
export interface HexPoint {
  x: number;
  y: number;
}

const SQRT3 = Math.sqrt(3);

/** Circumradius of a pointy-top hex whose flat-to-flat width is `flat`. */
export function hexSizeFromFlat(flat: number): number {
  return flat / SQRT3;
}

/**
 * The 6 axial neighbour offsets, in EDGE order: entry `i` is across edge `i`
 * (corner `i` → corner `i + 1` of {@link hexVertices}). Locked by
 * `galaxyTerritories.test.ts` against the projection.
 */
export const HEX_DIRS: ReadonlyArray<Readonly<AxialHex>> = [
  { q: 0, r: 1 }, // edge 0 (30°→90°): lower-right
  { q: -1, r: 1 }, // edge 1 (90°→150°): lower-left
  { q: -1, r: 0 }, // edge 2 (150°→210°): left
  { q: 0, r: -1 }, // edge 3 (210°→270°): upper-left
  { q: 1, r: -1 }, // edge 4 (270°→330°): upper-right
  { q: 1, r: 0 }, // edge 5 (330°→30°): right
];

// ---------------------------------------------------------------------------
// axial <-> pixel

/** Standard pointy-top axial→pixel projection (hex centre). Used by the map renderer. */
export function axialToPixel(hex: AxialHex, size: number): { x: number; y: number } {
  const x = size * Math.sqrt(3) * (hex.q + hex.r / 2);
  const y = size * (3 / 2) * hex.r;
  return { x, y };
}

/** Allocation-free {@link axialToPixel}: writes the centre of (q, r) into `out`. */
export function axialToPixelInto(q: number, r: number, size: number, out: HexPoint): HexPoint {
  out.x = size * SQRT3 * (q + r / 2);
  out.y = size * (3 / 2) * r;
  return out;
}

/**
 * Round fractional axial (fq, fr) to the containing hex (cube rounding: round
 * all three cube coords, then fix the one with the largest error). Writes into
 * `out`; never yields -0.
 */
export function axialRoundInto(fq: number, fr: number, out: AxialHex): AxialHex {
  const fs = -fq - fr;
  let q = Math.round(fq);
  let r = Math.round(fr);
  const s = Math.round(fs);
  const dq = Math.abs(q - fq);
  const dr = Math.abs(r - fr);
  const ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  out.q = q + 0;
  out.r = r + 0;
  return out;
}

/** Allocation-free world→axial: the hex (at circumradius `size`) containing (x, y). */
export function pixelToAxialInto(x: number, y: number, size: number, out: AxialHex): AxialHex {
  const fq = ((SQRT3 / 3) * x - y / 3) / size;
  const fr = ((2 / 3) * y) / size;
  return axialRoundInto(fq, fr, out);
}

/** World→axial: the hex (at circumradius `size`) containing (x, y). Allocates. */
export function pixelToAxial(x: number, y: number, size: number): AxialHex {
  return pixelToAxialInto(x, y, size, { q: 0, r: 0 });
}

// ---------------------------------------------------------------------------
// corners

/** Pointy-top hex corners at angles 30°, 90°, …, 330° (corner `i` → edge `i`
 *  runs to corner `i+1`; locked against {@link HEX_DIRS}). Allocates. */
export function hexVertices(size: number): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 6 + (i * Math.PI) / 3;
    out.push({ x: size * Math.cos(angle), y: size * Math.sin(angle) });
  }
  return out;
}

/** Allocation-free: corner `i` (0..5, same order as {@link hexVertices}) of the
 *  hex centred at (cx, cy), written into `out`. */
export function hexCornerInto(cx: number, cy: number, size: number, i: number, out: HexPoint): HexPoint {
  const angle = Math.PI / 6 + (i * Math.PI) / 3;
  out.x = cx + size * Math.cos(angle);
  out.y = cy + size * Math.sin(angle);
  return out;
}

/**
 * Allocation-free: all 6 corners of the hex centred at (cx, cy) as flat
 * `x0,y0,…,x5,y5` written into `out` from index `offset` (needs 12 slots).
 */
export function hexCornersInto(
  cx: number, cy: number, size: number, out: { [i: number]: number }, offset = 0,
): void {
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 6 + (i * Math.PI) / 3;
    out[offset + 2 * i] = cx + size * Math.cos(angle);
    out[offset + 2 * i + 1] = cy + size * Math.sin(angle);
  }
}

// ---------------------------------------------------------------------------
// distance, neighbours, rings

/** Hex (step) distance between (aq, ar) and (bq, br). */
export function hexDistance(aq: number, ar: number, bq: number, br: number): number {
  const dq = aq - bq;
  const dr = ar - br;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

/** Allocation-free: neighbour `dir` (0..5, {@link HEX_DIRS} order) of (q, r). */
export function hexNeighbourInto(q: number, r: number, dir: number, out: AxialHex): AxialHex {
  const d = HEX_DIRS[((dir % 6) + 6) % 6]!;
  out.q = q + d.q;
  out.r = r + d.r;
  return out;
}

/** The 6 neighbours of `hex`, in {@link HEX_DIRS} order. Allocates. */
export function hexNeighbours(hex: AxialHex): AxialHex[] {
  return HEX_DIRS.map((d) => ({ q: hex.q + d.q, r: hex.r + d.r }));
}

/** The hexes exactly `radius` steps from `centre` (6·radius of them; just the
 *  centre at radius 0), walking the ring once. Allocates. */
export function hexRing(centre: AxialHex, radius: number): AxialHex[] {
  if (radius <= 0) return [{ q: centre.q, r: centre.r }];
  const out: AxialHex[] = [];
  // Start `radius` steps along dir 4 (upper-right), then walk each side.
  let q = centre.q + HEX_DIRS[4]!.q * radius;
  let r = centre.r + HEX_DIRS[4]!.r * radius;
  for (let side = 0; side < 6; side++) {
    const d = HEX_DIRS[side]!;
    for (let k = 0; k < radius; k++) {
      out.push({ q, r });
      q += d.q;
      r += d.r;
    }
  }
  return out;
}

/** Every hex within `radius` steps of `centre` (1 + 3r(r+1) of them). Allocates. */
export function hexSpiral(centre: AxialHex, radius: number): AxialHex[] {
  const out: AxialHex[] = [];
  for (let k = 0; k <= radius; k++) for (const h of hexRing(centre, k)) out.push(h);
  return out;
}
