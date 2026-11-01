/**
 * A deterministic, RULE-VALID structure lattice for scale measurement
 * (plan soft-leaping-truffle v2, phase A0; re-laid for the phase-V footprints).
 *
 * Builds N structures the way a player could: a Capital at the origin, a grid
 * of Connector hubs (row chains + a vertical spine through the Capital), up to
 * two leaves per row connector (Solar / Battery / Cargo Bay / Turret mix) sat
 * directly above and below it, and an optional closed Shield Pylon fence ring
 * tapped into the row ends. Every placement passes the real
 * `placementRejection`, and every edge passes the real `canConnect` when the
 * edges are applied in order — locked by `structureLattice.test.ts`.
 *
 * Layout (P = connector pitch, both axes):
 *   - connectors at (i·P, j·P) for |i| ≤ M, |j| ≤ K, the Capital at (0, 0);
 *   - row links (i,j)–(i±1,j); spine links (0,j)–(0,j±1); the Capital links
 *     its four neighbours (capital ↔ connectors only);
 *   - a row connector's leaves sit directly above / below it, clear of the
 *     row line; spine connectors carry no leaves (the spine line stays clear);
 *   - fence pylons ring the lattice, level with each row / column so each row
 *     end taps the pylon beside it.
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

/** Connector pitch. Connector edge distance 640 − 64 = 576 ≤ 600 range. */
export const LATTICE_PITCH = 640;
/** Gap between a connector's box and its leaf's box. */
const LEAF_GAP = 20;
/** Fence clearance beyond the outermost leaves. */
const FENCE_MARGIN = 150;

/** Leaf kind mix (per 20 leaves): 9 solar, 4 battery, 4 cargo bay, 3 turret. */
const LEAF_CYCLE: readonly StructureKindId[] = [
  'solar', 'battery', 'solar', 'cargo_bay', 'solar', 'turret', 'solar', 'battery', 'solar', 'cargo_bay',
  'solar', 'turret', 'solar', 'battery', 'solar', 'cargo_bay', 'solar', 'battery', 'cargo_bay', 'turret',
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
  const connHalf = getStructureKind('connector').footprint.h / 2;

  placements.push({ kind: 'capital', x: 0, y: 0 });
  at.set(key(0, 0), 0);
  const phase = mix(opts.seed, n) % LEAF_CYCLE.length;
  let leafNo = 0;
  let maxLeafReachY = 0;
  let maxLeafReachX = 0;

  // Grow ring by ring (Chebyshev radius). Order matters: every cell's parent
  // must already exist.
  //  1. the spine cells (0, ±r) — parent (0, ±(r-1));
  //  2. the row ends (±r, j) for |j| < r — parent (±(r-1), j), from ring r-1;
  //  3. the new top/bottom rows (±i, ±r) by increasing |i| — parent (±(i-1), ±r).
  for (let r = 1; placements.length < n; r++) {
    const ring: Array<[number, number]> = [[0, r], [0, -r]];
    for (let j = -(r - 1); j <= r - 1; j++) ring.push([r, j], [-r, j]);
    for (let i = 1; i <= r; i++) ring.push([i, r], [-i, r], [i, -r], [-i, -r]);
    for (const [i, j] of ring) {
      if (placements.length >= n) break;
      const parentKey = i === 0 ? key(0, j - Math.sign(j)) : key(i - Math.sign(i), j);
      const parent = at.get(parentKey);
      if (parent === undefined) continue;
      const idx = placements.length;
      const cx = i * LATTICE_PITCH, cy = j * LATTICE_PITCH;
      placements.push({ kind: 'connector', x: cx, y: cy });
      at.set(key(i, j), idx);
      edges.push([parent, idx]);
      if (i === 0) continue; // spine connectors stay bare (keeps the spine line clear)
      // Up to two leaves: directly above, then below. A row connector keeps a
      // free slot for a fence tap (2 row links + 2 leaves + 1 tap ≤ 6).
      for (const side of [1, -1]) {
        if (placements.length >= n) break;
        const kind = LEAF_CYCLE[(phase + leafNo++) % LEAF_CYCLE.length]!;
        const fp = getStructureKind(kind).footprint;
        const dy = side * (connHalf + LEAF_GAP + fp.h / 2);
        const li = placements.length;
        placements.push({ kind, x: cx, y: cy + dy });
        edges.push([idx, li]);
        maxLeafReachY = Math.max(maxLeafReachY, Math.abs(cy + dy) + fp.h / 2);
        maxLeafReachX = Math.max(maxLeafReachX, Math.abs(cx) + fp.w / 2);
      }
    }
  }

  let fencePylons = 0;
  if (opts.fence) {
    let maxI = 0, maxJ = 0;
    for (const k of at.keys()) {
      const [i, j] = k.split(',').map(Number) as [number, number];
      maxI = Math.max(maxI, Math.abs(i));
      maxJ = Math.max(maxJ, Math.abs(j));
    }
    const capHalf = getStructureKind('capital').footprint.w / 2;
    const fx = Math.max(maxI * LATTICE_PITCH + connHalf, maxLeafReachX, capHalf) + FENCE_MARGIN;
    const fy = Math.max(maxJ * LATTICE_PITCH + connHalf, maxLeafReachY, capHalf) + FENCE_MARGIN;
    // Ring points, counter-clockwise from the bottom-left corner: the corners
    // plus one pylon per grid line (pylons level with each row / column).
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
    for (let p = 0; p < ring.length; p++) edges.push([first + p, first + ((p + 1) % ring.length)]);
    // Taps: each row-end connector links the side pylon level with it.
    for (let p = 0; p < ring.length; p++) {
      const [x, y] = ring[p]!;
      if (Math.abs(x) !== fx || y % LATTICE_PITCH !== 0) continue;
      const c = at.get(key(Math.sign(x) * maxI, y / LATTICE_PITCH));
      if (c !== undefined) edges.push([c, first + p]);
    }
  }

  // Power balance: convert non-solar leaves (latest first) to Solars until the
  // base runs.
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
