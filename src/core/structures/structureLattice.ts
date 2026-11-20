/**
 * A deterministic, RULE-VALID structure lattice for scale measurement
 * (plan soft-leaping-truffle v2, phase A0; re-laid for the phase-V footprints).
 *
 * Builds N structures the way a player could: a Capital at the origin, a grid
 * of Connector hubs (row chains + a vertical spine through the Capital), one
 * leaf per row connector (Solar / Battery / Cargo Bay / Turret mix) sat
 * directly above or below it, and an optional closed rectangular shield fence
 * around the base's extent, with a Shield Gate in the middle of each side,
 * tapped into the row ends. Every placement passes the real
 * `placementRejection`, and every edge passes the real `canConnect` when the
 * edges are applied in order — locked by `structureLattice.test.ts`.
 *
 * Layout (P = connector pitch, both axes):
 *   - spine connectors at (0, j·P) for |j| ≤ K, the Capital at (0, 0); row
 *     connectors at (i·P, j·P) for |i| ≤ M on EVEN j only (odd j are spine
 *     relays, so tall leaves of neighbouring rows never meet);
 *   - row links (i,j)–(i±1,j); spine links (0,j)–(0,j±1); the Capital links
 *     its neighbours (capital ↔ connectors only);
 *   - a row connector's one leaf sits directly above it (even i) or below it
 *     (odd i), clear of the row line, so same-side leaves stand 2·P apart (a
 *     700 u Solar fits); spine connectors carry no leaves (the spine line
 *     stays clear);
 *   - the fence is a rectangle around the base (not a circle): pylons level
 *     with each row / column so each row end taps the emitter beside it, and
 *     the middle emitter of each side is a Shield Gate lying along that side
 *     (rot 0 on the top/bottom, 90 on the left/right), so the fence runs post
 *     to post and ships can come and go.
 *
 * Pure + zone-blind (no I/O). Not on a hot path (built once per room create).
 */
import { getStructureKind, type StructureKindId } from '../../shared-types/structureKinds.js';
import { MIN_CABLE_LENGTH } from './structureGridConstants.js';

export interface LatticePlacement {
  kind: StructureKindId;
  x: number;
  y: number;
  /** Quarter-turn rotation in degrees (gates on the left/right sides: 90). */
  rot?: number;
}

export interface StructureLattice {
  placements: LatticePlacement[];
  /** Index pairs into `placements`, in an order every `canConnect` passes. */
  edges: Array<readonly [number, number]>;
  /** Number of fence emitters, pylons and gates (the tail of `placements`). */
  fencePylons: number;
  /** How many of those are Shield Gates (one per side). */
  fenceGates: number;
}

export interface LatticeOptions {
  /** Structures in the connector+leaf lattice (Capital included; fence extra). */
  n: number;
  seed: number;
  /** Ring the lattice with a closed rectangular shield fence (with gates). */
  fence?: boolean;
}

/** Connector pitch. Connector edge distance 640 − 64 = 576 ≤ 600 range. */
export const LATTICE_PITCH = 640;
/** Gap between a connector's box and its leaf's box: the shortest cable
 *  (`MIN_CABLE_LENGTH`), so every leaf link is a real run. */
const LEAF_GAP = MIN_CABLE_LENGTH;
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
      // Rows sit on every OTHER grid line (odd lines are spine relays only),
      // so a 300 u-tall Solar above one row clears the leaves below the next.
      if (i !== 0 && j % 2 !== 0) continue;
      const parentKey = i === 0 ? key(0, j - Math.sign(j)) : key(i - Math.sign(i), j);
      const parent = at.get(parentKey);
      if (parent === undefined) continue;
      const idx = placements.length;
      const cx = i * LATTICE_PITCH, cy = j * LATTICE_PITCH;
      placements.push({ kind: 'connector', x: cx, y: cy });
      at.set(key(i, j), idx);
      edges.push([parent, idx]);
      if (i === 0) continue; // spine connectors stay bare (keeps the spine line clear)
      // One leaf, alternating sides along the row (even columns above, odd
      // below), so same-side leaves stand two pitches apart: a 700 u-wide
      // Solar never meets its neighbour. A row connector keeps free slots for
      // a fence tap (2 row links + 1 leaf + 1 tap ≤ 6).
      if (placements.length < n) {
        const side = i % 2 === 0 ? 1 : -1;
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
  let fenceGates = 0;
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
    for (const [x, y] of ring) {
      // The middle of each side is a gate lying along the side.
      if (x === 0 && Math.abs(y) === fy) { placements.push({ kind: 'shield_gate', x, y, rot: 0 }); fenceGates++; continue; }
      if (y === 0 && Math.abs(x) === fx) { placements.push({ kind: 'shield_gate', x, y, rot: 90 }); fenceGates++; continue; }
      placements.push({ kind: 'shield_pylon', x, y });
    }
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

  return { placements, edges, fencePylons, fenceGates };
}
