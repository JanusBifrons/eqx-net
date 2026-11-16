/** Wreck lineage (rock cut / laser spread): every wreck carries the id of the
 *  root wreck it descends from (`LiveWreck.root`). These walk the
 *  CapitalWreckSubsystem's maps; split out of it for its size cap. */
import { wreckSalvageQty } from '../../core/destruction/wreckIntegrity.js';
import { GOOD_DEFS } from '../../shared-types/goods.js';
import { asteroidYieldWeightPerUnit } from '../../shared-types/asteroidResources.js';
import type { LiveWreck, PieceKnock, WreckOre } from './capitalWreckTypes.js';
import { pieceOreUnits, type WreckPiecePose } from './wreckResplit.js';

/** What a live piece is worth taken into a hold WHOLE (`pieceStoreOf`). */
export interface PieceStoreView {
  /** Body mass and bounding radius (world units). */
  mass: number;
  radius: number;
  /** Units it stores as: salvage (a ship's wreck) or ore (`ore` set: a rock
   *  piece, its goods drawn through `OreDraw.cutYield`). 0: nothing. */
  qty: number;
  ore: WreckOre | undefined;
  /** Hold weight of those units. */
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
 *  for a ship's wreck, its ore share (`pieceOreUnits`, the worn-out pod's
 *  rule) for a rock's. Read by the lock salvage bits (haul + consume tests,
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
    out.holdWeight = out.qty * asteroidYieldWeightPerUnit(w.ore.resource);
  } else {
    out.qty = wreckSalvageQty(w.src, k.mass);
    out.ore = undefined;
    out.holdWeight = out.qty * GOOD_DEFS.salvage.weight;
  }
  return true;
}

const _near: WreckPiecePose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };

/** `CapitalWreckSubsystem.forEachPieceNear`: visit each live piece (ship
 *  wreck or rock) with a bounding radius ≤ `maxRadius` whose edge is within
 *  `reach` of (x, y), with its centre. A piece still in its crack hold (its
 *  hull only just broke, `tick < holdUntil`) is skipped. The radius test runs
 *  before the pose read, so a ship that consumes nothing small costs one pass
 *  over the radii. The visitor may remove the piece. */
export function forEachPieceNear(
  wrecks: ReadonlyMap<number, LiveWreck>, pieceWreck: ReadonlyMap<string, number>,
  knock: ReadonlyMap<string, PieceKnock>, tick: number,
  poseInto: ((id: string, out: WreckPiecePose) => boolean) | undefined,
  x: number, y: number, reach: number, maxRadius: number,
  visit: (pieceId: string, px: number, py: number) => void,
): void {
  if (poseInto === undefined || !(maxRadius > 0)) return;
  for (const [id, k] of knock) {
    if (k.radius > maxRadius) continue;
    const w = wrecks.get(pieceWreck.get(id) ?? -1);
    if (w === undefined || tick < w.holdUntil || !poseInto(id, _near)) continue;
    const dx = _near.x - x, dy = _near.y - y, r = reach + k.radius;
    if (dx * dx + dy * dy <= r * r) visit(id, _near.x, _near.y);
  }
}
