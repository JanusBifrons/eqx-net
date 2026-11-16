/**
 * The cut field's ore map (macro terrain plan v2, stage F1; owner 2026-11-15).
 *
 * Ore is a map over space, not a label on a rock: "the exact chunk you split
 * up and grind down will determine what's in it". Deposits are hotspots
 * rolled from the field seed by a loot table: small ice and crystal pockets
 * can turn up anywhere, and huge rich lodes crowd the middle. `oreAt` gives
 * the ice and crystal concentration (0..1) at a point; everything else is
 * plain rock.
 *
 * Coordinates are the field's REST frame (where the rock was cut): a shoved or
 * split rock carries its ore with it, so callers map a world point back
 * through the rock's pose first.
 *
 * Lazy and deterministic: the field is cut into `ORE_CELL` cells and each cell
 * rolls its own hotspots from `(seed, cell)`, so no global table is built and
 * any point is answered on its own. Arithmetic only (no sin/cos/pow), so the
 * server and every browser agree (#15). `oreAt` allocates nothing (#14: the
 * mining laser samples it per hit).
 * docs/architecture/macro-terrain.md "Ore".
 */
import { fnv1a32, fnvMixU32 } from '../random/rng.js';
import { SLICED, vnoise } from './fieldLayout.js';

/** Bump on any change to the ore a seed gives (saved rock pools key on it). */
export const ORE_VERSION = 1;

export type OreResource = 'ice' | 'crystal';

/** Concentrations at a point, 0..1 each (0 = plain rock). */
export interface OreConc { ice: number; crystal: number }

/** One loot-table row: how often a cell rolls this hotspot, and its size. */
export interface OreTableRow {
  resource: OreResource;
  /** Chance per roll at the field's rim and at its centre (lerped by distance). */
  chanceRim: number;
  chanceCore: number;
  /** Rolls per cell. */
  rolls: number;
  /** Radius range (world u) and peak concentration range. */
  radius: readonly [number, number];
  peak: readonly [number, number];
}

/** Cell size (world u). At least any hotspot's reach (radius × (1 + ORE_EDGE_DEPTH)),
 *  so a point only ever needs its own cell and the 8 around it (tested). */
export const ORE_CELL = 8192;

/** The loot table (owner: "smaller random hotspots possible in lots of places,
 *  but lots of huge high yield hotspots in the middle"). */
export const ORE_TABLE: readonly OreTableRow[] = [
  // Pockets: anywhere, a rock or a few wide.
  { resource: 'ice', chanceRim: 0.25, chanceCore: 0.25, rolls: 2, radius: [350, 1400], peak: [0.35, 0.75] },
  { resource: 'crystal', chanceRim: 0.1, chanceCore: 0.14, rolls: 2, radius: [300, 1100], peak: [0.35, 0.85] },
  // Lodes: huge and rich, crowding the middle.
  { resource: 'ice', chanceRim: 0.0, chanceCore: 0.3, rolls: 1, radius: [2800, 6000], peak: [0.8, 1] },
  { resource: 'crystal', chanceRim: 0.0, chanceCore: 0.22, rolls: 1, radius: [2400, 5600], peak: [0.85, 1] },
];

/** The chance is `chanceCore` within ORE_CORE_SHARE of the field radius and
 *  falls linearly to `chanceRim` at ORE_RIM_SHARE (and beyond). */
export const ORE_CORE_SHARE = 0.35;
export const ORE_RIM_SHARE = 0.75;

/** Deposit edges are roughened by value noise of this wavelength (world u) and
 *  depth (share of the radius). */
const EDGE_WAVE = 700;
export const ORE_EDGE_DEPTH = 0.35;

export interface OreOpts {
  seed: string;
  /** Field radius override (tests); default `SLICED.radius`. */
  radius?: number;
}

/** A hotspot, as the client's look and tests see it. */
export interface OreHotspot { x: number; y: number; radius: number; peak: number; resource: OreResource }

function u01(h: number): number { return (h >>> 0) / 4294967296; }

/** Seed base for a field's ore (a different stream from its cuts). */
export function oreSeed(seed: string): number { return fnv1a32(`ore:${seed}`); }

/**
 * Visit every hotspot of cell (gx, gy). Allocation-free: `visit` gets plain
 * numbers. The field centre is the origin, as for the cuts.
 */
export function visitCellHotspots(
  base: number, fieldRadius: number, gx: number, gy: number,
  visit: (x: number, y: number, radius: number, peak: number, resource: OreResource) => void,
): void {
  const cellH = fnvMixU32(fnvMixU32(base, gx | 0), gy | 0);
  const mx = (gx + 0.5) * ORE_CELL, my = (gy + 0.5) * ORE_CELL;
  const r = Math.sqrt(mx * mx + my * my) / fieldRadius;
  if (r > 1.05) return;
  const core = r <= ORE_CORE_SHARE ? 1 : Math.max(0, (ORE_RIM_SHARE - r) / (ORE_RIM_SHARE - ORE_CORE_SHARE));
  for (let t = 0; t < ORE_TABLE.length; t++) {
    const row = ORE_TABLE[t]!;
    const chance = row.chanceRim + (row.chanceCore - row.chanceRim) * core;
    for (let k = 0; k < row.rolls; k++) {
      const h = fnvMixU32(fnvMixU32(cellH, t + 1), k + 1);
      if (u01(h) >= chance) continue;
      const h2 = fnvMixU32(h, 2), h3 = fnvMixU32(h, 3), h4 = fnvMixU32(h, 4), h5 = fnvMixU32(h, 5);
      const x = gx * ORE_CELL + u01(h2) * ORE_CELL;
      const y = gy * ORE_CELL + u01(h3) * ORE_CELL;
      const radius = row.radius[0] + (row.radius[1] - row.radius[0]) * u01(h4);
      const peak = row.peak[0] + (row.peak[1] - row.peak[0]) * u01(h5);
      visit(x, y, radius, peak, row.resource);
    }
  }
}

/** Concentration of one hotspot at (x, y): `peak` at the centre, a smooth
 *  falloff to 0 at its noisy edge. Shared by `oreAt` and the look (#15). */
export function hotspotConc(dx: number, dy: number, radius: number, peak: number, edgeNoise: number): number {
  const rr = radius * (1 + ORE_EDGE_DEPTH * edgeNoise);
  const q = (dx * dx + dy * dy) / (rr * rr);
  if (q >= 1) return 0;
  const s = 1 - q;
  return peak * s * s * (3 - 2 * s);
}

/** The edge noise (-1..1) at a rest-frame point, per field. */
export function oreEdgeNoise(base: number, x: number, y: number): number {
  return vnoise(x / EDGE_WAVE, y / EDGE_WAVE, base | 0);
}

// Scratch for `oreAt` (module-level, so the visit closure is built once).
let sIce = 0, sCrystal = 0, sX = 0, sY = 0, sNoise = 0;
const accumulate = (hx: number, hy: number, radius: number, peak: number, resource: OreResource): void => {
  const c = hotspotConc(sX - hx, sY - hy, radius, peak, sNoise);
  if (resource === 'ice') { if (c > sIce) sIce = c; } else if (c > sCrystal) sCrystal = c;
};

/**
 * Ice and crystal concentration at rest-frame point (x, y), into `out`.
 * Overlapping hotspots of one resource take the strongest. Allocation-free.
 */
export function oreAt(base: number, fieldRadius: number, x: number, y: number, out: OreConc): OreConc {
  sIce = 0; sCrystal = 0; sX = x; sY = y; sNoise = oreEdgeNoise(base, x, y);
  const gx = Math.floor(x / ORE_CELL), gy = Math.floor(y / ORE_CELL);
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) visitCellHotspots(base, fieldRadius, gx + i, gy + j, accumulate);
  out.ice = sIce; out.crystal = sCrystal;
  return out;
}

/** `oreAt` for a field's options (seed hashed each call: tests and tools, not hot paths). */
export function oreAtField(o: OreOpts, x: number, y: number, out: OreConc): OreConc {
  return oreAt(oreSeed(o.seed), o.radius ?? SLICED.radius, x, y, out);
}

/**
 * The ore at every vertex of a chunk's packed outlines (`[n, x0, y0, …]` per
 * rock, rest frame), in the draw order of a rock fan: the centre (the vertex
 * mean) first, then the n outline vertices; `[ice, crystal]` per vertex. The
 * look tints by it (F1c), so a rock shows ore where the map has it. Hotspots
 * are gathered once for the chunk's box, then each vertex reads only those.
 * Generation-time (a chunk load): allocates its result.
 */
export function oreForOutlines(base: number, fieldRadius: number, outlines: Float32Array): Float32Array {
  let verts = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < outlines.length;) {
    const n = outlines[i]!;
    verts += n + 1;
    for (let k = 0; k < n; k++) {
      const x = outlines[i + 1 + k * 2]!, y = outlines[i + 2 + k * 2]!;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    i += 1 + n * 2;
  }
  const out = new Float32Array(verts * 2);
  if (verts === 0) return out;
  // Every hotspot that can reach the box: x, y, radius, peak, ice (1) / crystal (0).
  const spots: number[] = [];
  for (let gy = Math.floor(y0 / ORE_CELL) - 1; gy <= Math.floor(y1 / ORE_CELL) + 1; gy++) {
    for (let gx = Math.floor(x0 / ORE_CELL) - 1; gx <= Math.floor(x1 / ORE_CELL) + 1; gx++) {
      visitCellHotspots(base, fieldRadius, gx, gy, (x, y, radius, peak, resource) => {
        const reach = radius * (1 + ORE_EDGE_DEPTH);
        if (x + reach < x0 || x - reach > x1 || y + reach < y0 || y - reach > y1) return;
        spots.push(x, y, radius, peak, resource === 'ice' ? 1 : 0);
      });
    }
  }
  if (spots.length === 0) return out;
  let v = 0;
  const at = (x: number, y: number): void => {
    const noise = oreEdgeNoise(base, x, y);
    let ice = 0, crystal = 0;
    for (let s = 0; s < spots.length; s += 5) {
      const c = hotspotConc(x - spots[s]!, y - spots[s + 1]!, spots[s + 2]!, spots[s + 3]!, noise);
      if (spots[s + 4] === 1) { if (c > ice) ice = c; } else if (c > crystal) crystal = c;
    }
    out[v * 2] = ice; out[v * 2 + 1] = crystal; v++;
  };
  for (let i = 0; i < outlines.length;) {
    const n = outlines[i]!;
    let mx = 0, my = 0;
    for (let k = 0; k < n; k++) { mx += outlines[i + 1 + k * 2]!; my += outlines[i + 2 + k * 2]!; }
    at(mx / n, my / n);
    for (let k = 0; k < n; k++) at(outlines[i + 1 + k * 2]!, outlines[i + 2 + k * 2]!);
    i += 1 + n * 2;
  }
  return out;
}

/** Every hotspot that reaches into the box (tests, the look's per-rock pick).
 *  Generation-time, allocates its result. */
export function hotspotsInBox(o: OreOpts, x0: number, y0: number, x1: number, y1: number): OreHotspot[] {
  const base = oreSeed(o.seed), R = o.radius ?? SLICED.radius, out: OreHotspot[] = [];
  for (let gy = Math.floor((y0 - ORE_CELL) / ORE_CELL); gy <= Math.floor((y1 + ORE_CELL) / ORE_CELL); gy++) {
    for (let gx = Math.floor((x0 - ORE_CELL) / ORE_CELL); gx <= Math.floor((x1 + ORE_CELL) / ORE_CELL); gx++) {
      visitCellHotspots(base, R, gx, gy, (x, y, radius, peak, resource) => {
        if (x + radius * (1 + ORE_EDGE_DEPTH) < x0 || x - radius * (1 + ORE_EDGE_DEPTH) > x1) return;
        if (y + radius * (1 + ORE_EDGE_DEPTH) < y0 || y - radius * (1 + ORE_EDGE_DEPTH) > y1) return;
        out.push({ x, y, radius, peak, resource });
      });
    }
  }
  return out;
}
