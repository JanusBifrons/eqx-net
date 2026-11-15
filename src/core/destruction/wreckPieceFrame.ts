/**
 * The two halves of `wreckPieceGeometry`, split out so a wreck piece can be
 * re-fractured (PR 3 of the salvage stream, capital-destruction.md §S4):
 *  - `wreckRootFracture`: the raw `fractureHull` pieces of a wreck, in the
 *    hull's 1× Pixi-up frame (the frame a child fracture starts from);
 *  - `fracturePiecesToGeometry`: those raw pieces → the body-frame shapes the
 *    server body, the client predWorld twin and the drawing share (#15).
 * `wreckChildGeometry` (wreckChildren.ts) runs the same two halves on a
 * piece's own outline. Runs once per wreck (or split) per side; allocates
 * freely.
 */
import { fractureHull, cutDirFromAngle, EDGE_HULL, type FractureEdgeKind, type FractureExtraCut, type FractureKillCut, type FracturePiece } from './fractureHull.js';
import { DESTRUCTION_PROFILES } from '../../shared-types/shipScale/destruction.js';
import type { WreckExtraCut } from '../../shared-types/messages/wreckDescriptor.js';
import { shipHullOutline, shipShapeScale } from '../geometry/shipHullOutline.js';
import { getShipKind, type ShipKindId } from '../../shared-types/shipKinds.js';
import { shipBodyMass, shipTuning } from '../../shared-types/shipScale/tuning.js';
import type { Vec2 } from '../swarm/asteroidShape.js';

/**
 * The fracture inputs of one wreck: everything `wreckPieceGeometry` needs.
 * This is exactly what the S2b `wrecks[]` snapshot descriptor carries, so a
 * client rebuilds the same pieces the server spawned (no vertex on the wire).
 */
export interface WreckFractureInputs {
  kindId: ShipKindId;
  seed: number;
  /** Kill point in the hull's 1× Pixi-up frame, already on the outline. */
  killX: number;
  killY: number;
  killBlowDamage: number;
  recentDamageRate: number;
  snapChance: number;
  /** v9 kill cut (the killing weapon's `killCut`; absent = the normal
   *  break-up). The descriptor carries these three fields as they are, so
   *  both sides feed the fracture the same numbers. */
  cutKind?: 'slice' | 'channel';
  /** The cut line's direction as a u16 angle in the hull's 1× Pixi-up frame
   *  (`hullLocalCutAngle`; decoded by the shared `cutDirFromAngle`). */
  cutAng?: number;
  /** A channel's width in the hull's 1× frame (world width ÷
   *  `shipShapeScale`). */
  cutW?: number;
  /** v12 multi-cut: the other cutting beams' lines (the descriptor's
   *  `extraCuts` as they are; only with a cut). */
  extraCuts?: ReadonlyArray<WreckExtraCut>;
}

/** One piece's shape in its own body frame (math-up, centred on its
 *  centroid). Shared by the server body, the client predWorld twin and the
 *  client drawing (#15). */
export interface WreckPieceGeometry {
  index: number;
  /** Centroid in the ship's scaled math-up frame (before the ship's turn). */
  cx: number;
  cy: number;
  /** Convex parts, body-local math-up, CCW (drawing and weapon hits). */
  parts: Vec2[][];
  /** The physics collider (server body and client twin alike): each part
   *  shrunk by `shipTuning(kind).wreckColliderInset` toward its centre, so
   *  neighbours sharing a cut edge spawn a hair apart (pieces collide with
   *  each other). */
  colliderParts: Vec2[][];
  /** The piece outline, body-local math-up, CCW. */
  outline: Vec2[];
  /** `cutEdges[i]`: the fracture `EDGE_*` kind of outline[i] → outline[i+1]
   *  (`EDGE_HULL` = 0 for the hull's own outline, else a new cut that glows
   *  in S3; `EDGE_CUT` is a weapon's kill cut). */
  cutEdges: FractureEdgeKind[];
  /** World-unit area (scaled). */
  area: number;
  mass: number;
  /** Farthest part vertex from the centre (bounding circle). */
  radius: number;
}

/** The fracture's `cut` from a descriptor's three cut fields (undefined
 *  without a cut). */
export function wreckFractureCut(input: { cutKind?: 'slice' | 'channel'; cutAng?: number; cutW?: number }): FractureKillCut | undefined {
  if (input.cutKind === undefined || input.cutAng === undefined) return undefined;
  const d = cutDirFromAngle(input.cutAng);
  return { kind: input.cutKind, dirX: d.x, dirY: d.y, width: input.cutW ?? 0 };
}

/** The fracture's v12 `extraCuts` from a descriptor's `extraCuts` (undefined
 *  without a main cut or with none). Both sides decode each angle with the
 *  shared trig-free `cutDirFromAngle`. */
export function wreckFractureExtraCuts(input: { cutKind?: 'slice' | 'channel'; cutAng?: number; extraCuts?: ReadonlyArray<WreckExtraCut> }): FractureExtraCut[] | undefined {
  if (input.cutKind === undefined || input.cutAng === undefined || input.extraCuts === undefined || input.extraCuts.length === 0) return undefined;
  return input.extraCuts.map((c) => {
    const d = cutDirFromAngle(c.ang);
    return { x: c.x, y: c.y, dirX: d.x, dirY: d.y, width: c.w ?? 0 };
  });
}

/** The raw fracture of a wreck (hull 1× Pixi-up frame). The kind's
 *  destruction profile picks the options (a capital's are the fracture
 *  defaults); `none` leaves no pieces. */
export function wreckRootFracture(input: WreckFractureInputs): FracturePiece[] {
  const kind = getShipKind(input.kindId);
  const opts = DESTRUCTION_PROFILES[shipTuning(kind).destruction].fracture;
  if (opts === null) return [];
  return fractureHull({
    hull: shipHullOutline(kind),
    seed: input.seed >>> 0,
    killPoint: { x: input.killX, y: input.killY },
    maxPieces: opts.maxPieces,
    killBlowDamage: input.killBlowDamage,
    recentDamageRate: input.recentDamageRate,
    // The descriptor's snap chance (what the server used) wins.
    snapChance: input.snapChance,
    fanCracks: opts.fanCracks,
    farCrack: opts.farCrack,
    chunkyPieces: opts.chunkyPieces,
    chunkyMinWidthBeams: opts.chunkyMinWidthBeams,
    soundMinShare: opts.soundMinShare,
    extraChunkChance: opts.extraChunkChance,
    jag: opts.jag,
    cutBurnMinShare: opts.cutBurnMinShare,
    cut: wreckFractureCut(input),
    extraCuts: wreckFractureExtraCuts(input),
  });
}

function ringArea(r: ReadonlyArray<readonly [number, number]>): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i]!;
    const q = r[(i + 1) % r.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/**
 * Raw fracture pieces of a `kindId` wreck (hull 1× Pixi-up frame) → body-frame
 * geometry: centroid in the ship's scaled math-up frame, parts and outline
 * recentred there (the Y flip reverses each ring, so walk it backwards to
 * stay CCW), mass from area at the kind's density (hull mass / hull area).
 */
export function fracturePiecesToGeometry(kindId: ShipKindId, fractured: ReadonlyArray<FracturePiece>): WreckPieceGeometry[] {
  const kind = getShipKind(kindId);
  const s = shipShapeScale(kind);
  const hullAreaWorld = ringArea(shipHullOutline(kind)) * s * s;
  const density = hullAreaWorld > 0 ? shipBodyMass(kind) / hullAreaWorld : 0;
  const inset = shipTuning(kind).wreckColliderInset;
  const out: WreckPieceGeometry[] = [];
  for (let i = 0; i < fractured.length; i++) {
    const p = fractured[i]!;
    const cmx = p.centroid.x * s;
    const cmy = -p.centroid.y * s;
    let radius = 0;
    const parts: Vec2[][] = [];
    for (const part of p.convexParts) {
      const ring: Vec2[] = [];
      // The Y flip turns CCW into CW: walk backwards to stay CCW.
      for (let k = part.length - 1; k >= 0; k--) {
        const v = part[k]!;
        const x = v.x * s - cmx;
        const y = -v.y * s - cmy;
        ring.push({ x, y });
        const r = Math.sqrt(x * x + y * y);
        if (r > radius) radius = r;
      }
      parts.push(ring);
    }
    const n = p.outline.length;
    const outline: Vec2[] = [];
    const cutEdges: FractureEdgeKind[] = [];
    for (let j = 0; j < n; j++) {
      const v = p.outline[n - 1 - j]!;
      outline.push({ x: v.x * s - cmx, y: -v.y * s - cmy });
      // Reversed walk: new edge j is old edge (n - 2 - j) mod n.
      cutEdges.push(p.cutEdges[(n - 2 - j + n) % n] ?? EDGE_HULL);
    }
    const area = p.area * s * s;
    const colliderParts = parts.map((ring) => insetRing(ring, inset));
    out.push({ index: i, cx: cmx, cy: cmy, parts, colliderParts, outline, cutEdges, area, mass: Math.max(1e-3, density * area), radius });
  }
  return out;
}

/** A convex ring with every vertex moved `inset` toward the ring's vertex
 *  centre (never more than half way). Every point of a shared cut edge moves
 *  into its own piece, so two neighbours' colliders start apart. */
function insetRing(ring: ReadonlyArray<Vec2>, inset: number): Vec2[] {
  let mx = 0;
  let my = 0;
  for (const v of ring) { mx += v.x; my += v.y; }
  mx /= ring.length;
  my /= ring.length;
  const out: Vec2[] = [];
  for (const v of ring) {
    const dx = v.x - mx;
    const dy = v.y - my;
    const d = Math.sqrt(dx * dx + dy * dy);
    const k = d > 0 ? Math.max(0.5, (d - inset) / d) : 1;
    out.push({ x: mx + dx * k, y: my + dy * k });
  }
  return out;
}
