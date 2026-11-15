/**
 * Child fracture: a wreck piece breaks again (salvage stream PR 3;
 * docs/architecture/capital-destruction.md §S4 "Re-split").
 *
 * A child fracture is the SAME `fractureHull` run on a piece's own outline
 * (the hull's 1× Pixi-up frame, as `wreckRootFracture` returns it), with the
 * kind profile's `resplit.fracture` options and a derived seed
 * `fnvMixU32(parentSeed, pieceIndex)`. A chain names the root wreck's
 * fracture inputs and one step per break (which piece, where it was hit, and
 * the hitting weapon's kill cut), so both sides rebuild the same children
 * from a few numbers, like the root (#15; no geometry on the wire). The
 * root's output is untouched: a chain with no steps IS `wreckPieceGeometry`.
 *
 * Children come out in the same frame as the root's pieces (centroid in the
 * ship's scaled math-up frame, parts recentred), so a caller places a child
 * from its parent piece's live pose exactly as it placed the parent from the
 * dead hull's.
 *
 * Runs once per split per side (not hot-loop code); allocates freely.
 */
import { fractureHull, FRACTURE_QUANTUM, EDGE_HULL, type FracturePiece } from './fractureHull.js';
import { fnvMixU32 } from '../random/rng.js';
import { DESTRUCTION_PROFILES, type DestructionResplit } from '../../shared-types/shipScale/destruction.js';
import { getShipKind, type ShipKindId } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import { fracturePiecesToGeometry, wreckFractureCut, wreckFractureExtraCuts, wreckRootFracture } from './wreckPieceFrame.js';
import type { WreckExtraCut } from '../../shared-types/messages/wreckDescriptor.js';
import type { WreckFractureInputs, WreckPieceGeometry } from './wreckPieces.js';

/** One break of one piece. */
export interface WreckChildStep {
  /** The piece that breaks: its index in the previous level's pieces (the
   *  root wreck's for the first step). */
  pieceIndex: number;
  /** Where the breaking hit landed, in the hull's 1× Pixi-up frame (the
   *  fracture projects it onto the piece's outline). */
  killX: number;
  killY: number;
  /** The breaking weapon's kill cut, as the root descriptor carries it
   *  (absent = a plain break). */
  cutKind?: 'slice' | 'channel';
  cutAng?: number;
  cutW?: number;
  /** v12 multi-cut: the other cutting beams that burned this piece (the
   *  child descriptor's `extraCuts`; only with a cut). */
  extraCuts?: ReadonlyArray<WreckExtraCut>;
}

/** A root wreck and the breaks that led to one generation of children. */
export interface WreckChildChain {
  root: WreckFractureInputs;
  steps: ReadonlyArray<WreckChildStep>;
}

/** The seed of piece `pieceIndex`'s child fracture (§S4). */
export function wreckChildSeed(parentSeed: number, pieceIndex: number): number {
  return fnvMixU32(parentSeed >>> 0, pieceIndex >>> 0);
}

/** The kind's re-split options (null: its pieces never break again). */
export function wreckResplitOptions(kindId: ShipKindId): DestructionResplit | null {
  return DESTRUCTION_PROFILES[shipTuning(getShipKind(kindId)).destruction].resplit;
}

/**
 * The raw pieces (hull 1× Pixi-up frame) of the chain's last generation: the
 * root wreck's with no steps. Empty when a step names a piece that does not
 * exist or the kind never re-splits.
 */
export function wreckChainFracture(chain: WreckChildChain): FracturePiece[] {
  let pieces = wreckRootFracture(chain.root);
  if (chain.steps.length === 0) return pieces;
  const rs = wreckResplitOptions(chain.root.kindId);
  if (rs === null) return [];
  const o = rs.fracture;
  let seed = chain.root.seed >>> 0;
  for (const step of chain.steps) {
    const parent = pieces[step.pieceIndex];
    if (parent === undefined) return [];
    seed = wreckChildSeed(seed, step.pieceIndex);
    const children = fractureHull({
      hull: parent.outline.map((v) => [v.x, v.y] as const),
      seed,
      killPoint: { x: step.killX, y: step.killY },
      // Fixed-count mode (no damage inputs): the cap is the target.
      maxPieces: o.maxPieces,
      snapChance: o.snapChance,
      fanCracks: o.fanCracks,
      farCrack: o.farCrack,
      chunkyPieces: o.chunkyPieces,
      chunkyMinWidthBeams: o.chunkyMinWidthBeams,
      soundMinShare: o.soundMinShare,
      extraChunkChance: o.extraChunkChance,
      jag: o.jag,
      // Absent on every re-split profile today (children unchanged).
      cutBurnMinShare: o.cutBurnMinShare,
      cut: wreckFractureCut(step),
      extraCuts: wreckFractureExtraCuts(step),
    });
    pieces = children.map((c) => inheritEdgeKinds(c, parent));
  }
  return pieces;
}

/** The chain's last generation as wreck-piece geometry, in the same shape
 *  and frame as `wreckPieceGeometry` (mass from area at the kind's density). */
export function wreckChildGeometry(chain: WreckChildChain): WreckPieceGeometry[] {
  return fracturePiecesToGeometry(chain.root.kindId, wreckChainFracture(chain));
}

/** Largest distance (1× frame) of a child vertex off its parent's edge that
 *  still counts as on it: a cut's crossing is snapped to the quantum grid. */
const ON_EDGE_EPS = FRACTURE_QUANTUM;

/**
 * The fracture marks every edge of its input as `EDGE_HULL`; a child edge
 * that runs along one of its parent's cut edges keeps that edge's kind (so
 * an old crack still glows and still pairs as a seam). First parent edge
 * holding both ends wins. Arithmetic and sqrt only.
 */
function inheritEdgeKinds(child: FracturePiece, parent: FracturePiece): FracturePiece {
  const po = parent.outline;
  const n = child.outline.length;
  const cutEdges = child.cutEdges.slice();
  for (let i = 0; i < n; i++) {
    if (cutEdges[i] !== EDGE_HULL) continue;
    const a = child.outline[i]!;
    const b = child.outline[(i + 1) % n]!;
    for (let j = 0; j < po.length; j++) {
      const k = parent.cutEdges[j] ?? EDGE_HULL;
      if (k === EDGE_HULL) continue;
      const p = po[j]!;
      const q = po[(j + 1) % po.length]!;
      if (onSegment(a.x, a.y, p.x, p.y, q.x, q.y) && onSegment(b.x, b.y, p.x, p.y, q.x, q.y)) {
        cutEdges[i] = k;
        break;
      }
    }
  }
  return { outline: child.outline, cutEdges, convexParts: child.convexParts, area: child.area, centroid: child.centroid };
}

function onSegment(x: number, y: number, ax: number, ay: number, bx: number, by: number): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 <= 0) return false;
  const t = ((x - ax) * dx + (y - ay) * dy) / l2;
  const tl = ON_EDGE_EPS / Math.sqrt(l2);
  if (t < -tl || t > 1 + tl) return false;
  const ex = ax + dx * t - x;
  const ey = ay + dy * t - y;
  return ex * ex + ey * ey <= ON_EDGE_EPS * ON_EDGE_EPS;
}
