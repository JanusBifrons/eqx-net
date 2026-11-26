/**
 * Base-platform deck: pointy-top hexes {@link DECK_HEX_FLAT} wide (flat to
 * flat), grouped into 7-hex "plates" (a centre hex + its 6 neighbours).
 *
 * Plate centres sit on the axial lattice `i·(2,1) + j·(−1,3)`; that lattice
 * has determinant 7, so its 7-hex leaves tile the plane with no gap or
 * overlap. A hex finds its plate by `(q − 2r) mod 7`, which is 0 on every
 * plate centre and distinct for the 6 offsets around one.
 *
 * Neighbouring plate centres are 3 hex steps apart (`flat·√7` ≈ 3440 u at
 * 1300). The hex maths itself lives in `hex.ts`.
 */
import { HEX_DIRS, axialToPixelInto, hexSizeFromFlat, type AxialHex, type HexPoint } from './hex.js';

/** Deck hex width, flat side to flat side (world units). */
export const DECK_HEX_FLAT = 1300;
/** Deck hex circumradius (centre to corner): `DECK_HEX_FLAT / √3` ≈ 750.6. */
export const DECK_HEX_SIZE = hexSizeFromFlat(DECK_HEX_FLAT);

/** A plate's lattice index. */
export interface PlateIndex {
  i: number;
  j: number;
}

/** Lattice basis, axial. */
const A = { q: 2, r: 1 } as const;
const B = { q: -1, r: 3 } as const;

/** Offset of a hex from its plate centre, keyed by `(q − 2r) mod 7`. */
const OFFSET_BY_RESIDUE: ReadonlyArray<Readonly<AxialHex>> = (() => {
  const t: AxialHex[] = new Array(7);
  t[0] = { q: 0, r: 0 };
  for (const d of HEX_DIRS) t[mod7(d.q - 2 * d.r)] = d;
  return t;
})();

function mod7(n: number): number {
  return ((n % 7) + 7) % 7;
}

/**
 * The 6 neighbouring plates, as (Δi, Δj). Their centres are the axial steps
 * (2,1), (−1,3), (−3,2) and their negatives, each 3 hex steps away.
 */
export const PLATE_DIRS: ReadonlyArray<Readonly<PlateIndex>> = [
  { i: 1, j: 0 },
  { i: 0, j: 1 },
  { i: -1, j: 1 },
  { i: -1, j: 0 },
  { i: 0, j: -1 },
  { i: 1, j: -1 },
];

/** Allocation-free: the centre hex of plate (i, j), written into `out`. */
export function plateCentreHexInto(i: number, j: number, out: AxialHex): AxialHex {
  out.q = i * A.q + j * B.q + 0;
  out.r = i * A.r + j * B.r + 0;
  return out;
}

/** The centre hex of plate (i, j). Allocates. */
export function plateCentreHex(i: number, j: number): AxialHex {
  return plateCentreHexInto(i, j, { q: 0, r: 0 });
}

/**
 * Allocation-free: the plate that hex (q, r) belongs to, written into
 * `out`. Pass `centreOut` to also get that plate's centre hex.
 */
export function plateOfHexInto(q: number, r: number, out: PlateIndex, centreOut?: AxialHex): PlateIndex {
  const off = OFFSET_BY_RESIDUE[mod7(q - 2 * r)]!;
  const cq = q - off.q;
  const cr = r - off.r;
  // Invert q = 2i − j, r = i + 3j.
  out.i = (3 * cq + cr) / 7 + 0;
  out.j = (2 * cr - cq) / 7 + 0;
  if (centreOut) {
    centreOut.q = cq;
    centreOut.r = cr;
  }
  return out;
}

/** The plate of `hex` and its centre hex. Allocates. */
export function plateOfHex(hex: AxialHex): { plate: PlateIndex; centre: AxialHex } {
  const centre = { q: 0, r: 0 };
  const plate = plateOfHexInto(hex.q, hex.r, { i: 0, j: 0 }, centre);
  return { plate, centre };
}

/** The 7 hexes of plate (i, j): its centre first, then the ring in
 *  {@link HEX_DIRS} order. Allocates. */
export function plateHexes(i: number, j: number): AxialHex[] {
  const c = plateCentreHex(i, j);
  const out: AxialHex[] = [c];
  for (const d of HEX_DIRS) out.push({ q: c.q + d.q, r: c.r + d.r });
  return out;
}

/** The 6 plates bordering plate (i, j), in {@link PLATE_DIRS} order. Allocates. */
export function plateNeighbours(i: number, j: number): PlateIndex[] {
  return PLATE_DIRS.map((d) => ({ i: i + d.i, j: j + d.j }));
}

/** Allocation-free: world centre of deck hex (q, r) (size {@link DECK_HEX_SIZE}). */
export function deckHexCentreInto(q: number, r: number, out: HexPoint): HexPoint {
  return axialToPixelInto(q, r, DECK_HEX_SIZE, out);
}

/** Allocation-free: world centre of plate (i, j) on the deck. */
export function plateCentreWorldInto(i: number, j: number, out: HexPoint): HexPoint {
  return axialToPixelInto(i * A.q + j * B.q, i * A.r + j * B.r, DECK_HEX_SIZE, out);
}

/** Is hex (q, r) the middle hex of its plate? Allocation-free. */
export function isPlateCentreHex(q: number, r: number): boolean {
  return mod7(q - 2 * r) === 0;
}

/** A safe bound on how far any point of a plate lies from its centre: one
 *  hex step plus a hex circumradius (the true farthest corner is ≈ 1986 u). */
export const PLATE_REACH = DECK_HEX_FLAT + DECK_HEX_SIZE;
