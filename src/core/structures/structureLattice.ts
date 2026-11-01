/**
 * A deterministic, RULE-VALID structure lattice for scale measurement
 * (plan soft-leaping-truffle v2, phase A0).
 *
 * Builds N structures the way a player could: a Capital at the origin, a grid
 * of Connector hubs (row chains + a vertical spine through the Capital), up to
 * four leaves per connector (Solar / Battery / Cargo Bay / Turret mix), and an
 * optional closed Shield Pylon fence ring tapped into the row ends. Every
 * placement passes the real `placementRejection`, and every edge passes the
 * real `canConnect` when the edges are applied in order — locked by
 * `structureLattice.test.ts`. It is the seed of the phase-D generator.
 *
 * Layout (S = connector pitch):
 *   - connectors at (i·S, j·S) for |i| ≤ M, |j| ≤ K, the Capital at (0, 0);
 *   - row links (i,j)–(i±1,j); spine links (0,j)–(0,j±1); the Capital links
 *     its four neighbours (capital ↔ connectors only);
 *   - leaves sit at (±LEAF_DX, ±LEAF_DY) off their connector — clear of both
 *     the row line and the spine line, so no link's line of sight is blocked;
 *   - fence pylons ring the lattice at FENCE_MARGIN, aligned with rows on the
 *     left/right sides so each row-end connector taps one pylon.
 *
 * Pure + zone-blind (no I/O). Not on a hot path (built once per room create).
 */
import { getStructureKind, type StructureKindId } from '../../shared-types/structureKinds.js';

export interface LatticePlacement {
  kind: StructureKindId;
  x: number;
  y: number;
}

export interface StructureLattice {
  placements: LatticePlacement[];
  /** Index pairs into `placements`, in an order every `canConnect` passes. */
  edges: Array<readonly [number, number]>;
  /** Number of fence pylons (the tail of `placements`). */
  fencePylons: number;
}

export interface LatticeOptions {
  /** Structures in the connector+leaf lattice (Capital included; fence extra). */
  n: number;
  seed: number;
  /** Ring the lattice with a closed shield-pylon fence. */
  fence?: boolean;
}

/** Connector pitch. Edge distance 400 − 2·10 = 380 < 600 range. */
export const LATTICE_PITCH = 400;
const LEAF_DX = 100;
const LEAF_DY = 130;
/** Fence ring distance beyond the outermost connector. */
const FENCE_MARGIN = 300;

/** Leaf kind mix (per 20 leaves): 9 solar, 4 battery, 4 cargo bay, 3 turret.
 *  Net ≈ +11 power per leaf, so a fenced lattice stays powered. */
const LEAF_CYCLE: readonly StructureKindId[] = [
  'solar', 'battery', 'solar', 'cargo_bay', 'solar', 'turret', 'solar', 'battery', 'solar', 'cargo_bay',
  'solar', 'turret', 'solar', 'battery', 'solar', 'cargo_bay', 'solar', 'battery', 'cargo_bay', 'turret',
];

const LEAF_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-LEAF_DX, LEAF_DY], [LEAF_DX, LEAF_DY], [-LEAF_DX, -LEAF_DY], [LEAF_DX, -LEAF_DY],
];

/** Integer mix (FNV-style) so the leaf-kind phase is seed-dependent. */
function mix(seed: number, a: number): number {
  let h = (seed ^ 0x811c9dc5) >>> 0;
  h = Math.imul(h ^ a, 0x01000193) >>> 0;
  return h;
}

export function buildStructureLattice(opts: LatticeOptions): StructureLattice {
  const n = Math.max(1, Math.floor(opts.n));
  const placements: LatticePlacement[] = [];
  const edges: Array<readonly [number, number]> = [];
  const at = new Map<string, number>(); // "i,j" → connector/capital index
  const key = (i: number, j: number): string => `${i},${j}`;

  placements.push({ kind: 'capital', x: 0, y: 0 });
  at.set(key(0, 0), 0);
  const phase = mix(opts.seed, n) % LEAF_CYCLE.length;
  let leafNo = 0;

  // Grow ring by ring (Chebyshev radius) so any N is a compact, centred base.
  // Within a ring, cells are visited in a fixed order; a cell is only added
  // once a neighbour toward the centre exists (so every link is to an existing
  // node — applying edges in order keeps the graph connected).
  for (let r = 1; placements.length < n; r++) {
    // Order matters: every cell's parent must already exist.
    //  1. the spine cells (0, ±r) — parent (0, ±(r-1));
    //  2. the row ends (±r, j) for |j| < r — parent (±(r-1), j), from ring r-1;
    //  3. the new top/bottom rows (±i, ±r) by increasing |i| — parent (±(i-1), ±r).
    const ring: Array<[number, number]> = [[0, r], [0, -r]];
    for (let j = -(r - 1); j <= r - 1; j++) ring.push([r, j], [-r, j]);
    for (let i = 1; i <= r; i++) ring.push([i, r], [-i, r], [i, -r], [-i, -r]);
    for (const [i, j] of ring) {
      if (placements.length >= n) break;
      // Parent: toward the centre along the row; the spine column links up/down.
      const parentKey = i === 0 ? key(0, j - Math.sign(j)) : key(i - Math.sign(i), j);
      const parent = at.get(parentKey);
      if (parent === undefined) continue; // not reachable yet at this radius
      const idx = placements.length;
      placements.push({ kind: 'connector', x: i * LATTICE_PITCH, y: j * LATTICE_PITCH });
      at.set(key(i, j), idx);
      edges.push([parent, idx]);
      // Leaves: a spine connector carries up/down + left/right row links (4),
      // so 2 leaves; a row connector carries ≤ 2 chain links + 3 leaves,
      // keeping its 6th slot for a fence tap.
      const maxLeaves = i === 0 ? 2 : 3;
      for (let l = 0; l < maxLeaves && placements.length < n; l++) {
        const [dx, dy] = LEAF_OFFSETS[l]!;
        const kind = LEAF_CYCLE[(phase + leafNo++) % LEAF_CYCLE.length]!;
        const li = placements.length;
        placements.push({ kind, x: i * LATTICE_PITCH + dx, y: j * LATTICE_PITCH + dy });
        edges.push([idx, li]);
      }
    }
  }

  let fencePylons = 0;
  if (opts.fence) {
    // Bounds of the connector grid actually built.
    let maxI = 0, maxJ = 0;
    for (const k of at.keys()) {
      const [i, j] = k.split(',').map(Number) as [number, number];
      maxI = Math.max(maxI, Math.abs(i));
      maxJ = Math.max(maxJ, Math.abs(j));
    }
    const fx = maxI * LATTICE_PITCH + FENCE_MARGIN;
    const fy = maxJ * LATTICE_PITCH + FENCE_MARGIN;
    // Ring points, counter-clockwise from the bottom-left corner: the corners
    // plus one pylon per grid line, so side pylons sit level with each row
    // (≤ 400 u apart — every adjacent pair is in connection range).
    const ring: Array<[number, number]> = [];
    ring.push([-fx, -fy]);
    for (let i = -maxI; i <= maxI; i++) ring.push([i * LATTICE_PITCH, -fy]);
    ring.push([fx, -fy]);
    for (let j = -maxJ; j <= maxJ; j++) ring.push([fx, j * LATTICE_PITCH]);
    ring.push([fx, fy]);
    for (let i = maxI; i >= -maxI; i--) ring.push([i * LATTICE_PITCH, fy]);
    ring.push([-fx, fy]);
    for (let j = maxJ; j >= -maxJ; j--) ring.push([-fx, j * LATTICE_PITCH]);
    const first = placements.length;
    for (const [x, y] of ring) placements.push({ kind: 'shield_pylon', x, y });
    fencePylons = ring.length;
    // Pylon chain (closed loop).
    for (let p = 0; p < ring.length; p++) edges.push([first + p, first + ((p + 1) % ring.length)]);
    // Taps: each row-end connector on the left/right edge links the pylon
    // level with it (same y). One tap per pylon at most (pylon ≤ 1 connector).
    for (let p = 0; p < ring.length; p++) {
      const [x, y] = ring[p]!;
      if (Math.abs(x) !== fx || y % LATTICE_PITCH !== 0) continue;
      const j = y / LATTICE_PITCH;
      // Only a connector at the grid edge is within range of the fence.
      const c = at.get(key(Math.sign(x) * maxI, j));
      if (c !== undefined) edges.push([c, first + p]);
    }
  }

  // Power balance: a builder adds generation until the base runs. Convert
  // non-solar leaves (latest first) to Solars until net power ≥ 0.
  let net = 0;
  for (const p of placements) {
    const k = getStructureKind(p.kind);
    net += k.powerOutput - k.powerConsumption;
  }
  for (let i = placements.length - 1; i >= 0 && net < 0; i--) {
    const p = placements[i]!;
    if (p.kind === 'battery' || p.kind === 'cargo_bay' || p.kind === 'turret') {
      const before = getStructureKind(p.kind);
      const solar = getStructureKind('solar');
      net += solar.powerOutput - before.powerOutput + before.powerConsumption;
      p.kind = 'solar';
    }
  }

  return { placements, edges, fencePylons };
}
