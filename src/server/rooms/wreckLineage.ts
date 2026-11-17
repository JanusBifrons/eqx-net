/** Wreck lineage (rock cut / laser spread): every wreck carries the id of the
 *  root wreck it descends from (`LiveWreck.root`). These walk the
 *  CapitalWreckSubsystem's maps; split out of it for its size cap. */
import { wreckSalvageQty } from '../../core/destruction/wreckIntegrity.js';
import { GOOD_DEFS } from '../../shared-types/goods.js';
import { rockChunkWeight } from '../../core/combat/salvageTargeting.js';
import type { LiveWreck, PieceKnock, WreckOre } from './capitalWreckTypes.js';
import { pieceOreUnits, type WreckPiecePose } from './wreckResplit.js';

/** What a live piece is worth taken into a hold WHOLE (`pieceStoreOf`). */
export interface PieceStoreView {
  /** Body mass and bounding radius (world units). */
  mass: number;
  radius: number;
  /** Units it stores as: salvage (a ship's wreck), or for a rock piece
   *  (`ore` set) its share of the rock's ore, > 0 while the rock had any
   *  left (it goes in as one chunk, `OreDraw.chunkYield`). 0: nothing. */
  qty: number;
  ore: WreckOre | undefined;
  /** Hold weight: the salvage's, or a rock chunk's (`rockChunkWeight`). */
  holdWeight: number;
}

/** Visit every live piece id descended from root wreck `root` (the root's
 *  own pieces and every re-split generation below it). Allocates nothing
 *  (#14). */
export function forEachLineagePiece(
  wrecks: ReadonlyMap<number, LiveWreck>, pieceWreck: ReadonlyMap<string, number>,
  root: number, visit: (pieceId: string) => void,
): void {
  for (const w of wrecks.values()) {
    if (w.root !== root || w.pieces <= 0) continue;
    const wreckId = w.desc.wreckId;
    for (let i = 0; i < w.ids.length; i++) {
      const id = w.ids[i]!;
      if (pieceWreck.get(id) === wreckId) visit(id);
    }
  }
}

/** The lineage root of the live wreck piece `pieceId`, or null. */
export function lineageRootOf(
  wrecks: ReadonlyMap<number, LiveWreck>, pieceWreck: ReadonlyMap<string, number>, pieceId: string,
): number | null {
  const wreckId = pieceWreck.get(pieceId);
  const w = wreckId !== undefined ? wrecks.get(wreckId) : undefined;
  return w !== undefined ? w.root : null;
}

/** `CapitalWreckSubsystem.pieceSalvageQty`: a live piece's salvage if stored
 *  whole, what it would leave as a pod when worn out (`wreckSalvageQty` of
 *  its mass). 0: not a live ship-wreck piece (rock pieces store as ore later). */
export function pieceSalvageQtyOf(
  wrecks: ReadonlyMap<number, LiveWreck>, pieceWreck: ReadonlyMap<string, number>,
  knock: ReadonlyMap<string, PieceKnock>, id: string,
): number {
  const k = knock.get(id);
  const wreckId = pieceWreck.get(id);
  const w = wreckId !== undefined ? wrecks.get(wreckId) : undefined;
  return k === undefined || w === undefined || w.src.rock !== null ? 0 : wreckSalvageQty(w.src, k.mass);
}

/** `CapitalWreckSubsystem.pieceStore`: a live piece's mass, radius and what
 *  it stores as whole: the salvage it would leave worn out (`wreckSalvageQty`)
 *  for a ship's wreck; for a rock's, one chunk of `rockChunkWeight` while
 *  its ore share (`pieceOreUnits`) is not empty. Read by the lock salvage bits (haul + consume tests,
 *  lockSalvage.ts) and the loot piece store. False when `id` is not a live
 *  piece. Allocates nothing (#14). */
export function pieceStoreOf(
  wrecks: ReadonlyMap<number, LiveWreck>, pieceWreck: ReadonlyMap<string, number>,
  knock: ReadonlyMap<string, PieceKnock>, id: string, out: PieceStoreView,
): boolean {
  const k = knock.get(id);
  const w = k === undefined ? undefined : wrecks.get(pieceWreck.get(id) ?? -1);
  if (k === undefined || w === undefined) return false;
  out.mass = k.mass;
  out.radius = k.radius;
  if (w.ore !== undefined) {
    // A piece's mass is its area at the source's density (fracturePiecesToGeometry).
    const area = w.src.bodyMass > 0 ? (k.mass * w.src.area) / w.src.bodyMass : 0;
    out.qty = pieceOreUnits(w.ore, area);
    out.ore = w.ore;
    out.holdWeight = rockChunkWeight(k.mass);
  } else {
    out.qty = wreckSalvageQty(w.src, k.mass);
    out.ore = undefined;
    out.holdWeight = out.qty * GOOD_DEFS.salvage.weight;
  }
  return true;
}

const _near: WreckPiecePose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };

/** `CapitalWreckSubsystem.forEachPieceNear`: visit each live piece (ship
 *  wreck) with a mass ≤ `maxMass` (hold size), or any rock piece (it goes
 *  in as a chunk of any size), whose edge is within `reach` of (x, y), with
 *  its centre and radius. A piece still in its crack hold (its
 *  hull only just broke, `tick < holdUntil`) is skipped. The size test runs
 *  before the pose read, so a pass with nothing to take costs one pass over
 *  the pieces. The visitor may remove the piece. */
export function forEachPieceNear(
  wrecks: ReadonlyMap<number, LiveWreck>, pieceWreck: ReadonlyMap<string, number>,
  knock: ReadonlyMap<string, PieceKnock>, tick: number,
  poseInto: ((id: string, out: WreckPiecePose) => boolean) | undefined,
  x: number, y: number, reach: number, maxMass: number,
  visit: (pieceId: string, px: number, py: number, pr: number) => void,
): void {
  if (poseInto === undefined || !(maxMass > 0)) return;
  for (const [id, k] of knock) {
    const w = wrecks.get(pieceWreck.get(id) ?? -1);
    if (w === undefined || (w.ore === undefined && !(k.mass <= maxMass)) || tick < w.holdUntil || !poseInto(id, _near)) continue;
    const dx = _near.x - x, dy = _near.y - y, r = reach + k.radius;
    if (dx * dx + dy * dy <= r * r) visit(id, _near.x, _near.y, k.radius);
  }
}
