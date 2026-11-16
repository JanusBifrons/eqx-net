/**
 * Fracture v12 multi-cut wiring for CapitalWreckSubsystem.ts: a cutting beam
 * (a weapon with a `killCut`) burns its line into the hull or wreck piece it
 * hits (`BurnLines`, core/destruction/burnLines.ts), so a kill split or a
 * re-split cuts along every beam that burned it in the last moment, any
 * shooter's. Alloc-free per hit (#14) apart from a target's first
 * `BurnLines`.
 */
import { BurnLines, BURN_LINE_MERGE_GAP_PER_RADIUS, hullPointInto } from '../../core/destruction/burnLines.js';
import { WEAPONS, type WeaponId } from '../../core/combat/WeaponCatalogue.js';
import { unitDirFromSteps } from '../../core/geometry/unitDir.js';
import { shipShapeScale } from '../../core/geometry/shipHullOutline.js';
import { getShipKind, type ShipKindId } from '../../shared-types/shipKinds.js';
import { killCutStripWidth } from '../../shared-types/shipScale/destruction.js';
import type { WreckDeathPose } from '../../core/destruction/wreckPieces.js';
import type { CapitalWreckDeps, PieceKnock } from './capitalWreckTypes.js';
import type { WreckPiecePose } from './wreckResplit.js';

/** Scratch for a burn line's target pose (#14). */
const BURN_POSE: WreckPiecePose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
const BURN_PT = { x: 0, y: 0 };
const MAIN_STRIP = { off: 0, w: 0 };

/** The world width of a weapon's cut strip (`killCutStripWidth`: a wide
 *  slice's burned gap), or -1 when it does not cut (no `killCut`): only
 *  cutting beams burn lines. */
function cutWidthOf(weaponId: WeaponId | null | undefined): number {
  if (weaponId === undefined || weaponId === null) return -1;
  const kc = WEAPONS.get(weaponId)?.killCut;
  return kc === undefined ? -1 : killCutStripWidth(kc);
}

/** A hit on a live hull (`noteHit`): a cutting beam burns its line into the
 *  hull (hull frame, at the hull's pose now). Returns the hull's lines:
 *  `burn` itself, or a new `BurnLines` on its first cutting hit. */
export function burnHullHit(
  burn: BurnLines | null, d: Pick<CapitalWreckDeps, 'hullPoseInto' | 'serverTick'>, targetId: string, kindId: ShipKindId,
  shooterId: string, hitX: number | undefined, hitY: number | undefined, dirX?: number, dirY?: number, weaponId?: WeaponId,
): BurnLines | null {
  const cw = cutWidthOf(weaponId);
  if (cw >= 0 && hitX !== undefined && hitY !== undefined && dirX !== undefined && dirY !== undefined
    && (dirX !== 0 || dirY !== 0) && d.hullPoseInto?.(targetId, BURN_POSE) === true) {
    const kind = getShipKind(kindId);
    const s = shipShapeScale(kind);
    const gap = (BURN_LINE_MERGE_GAP_PER_RADIUS * kind.radius) / s;
    if (burn === null) burn = new BurnLines(gap); // once per pooled entry
    else burn.mergeGap = gap;
    burn.record(shooterId, d.serverTick(), BURN_POSE.x, BURN_POSE.y, BURN_POSE.angle, s, hitX, hitY, dirX, dirY, cw);
  }
  return burn;
}

/** A hit on a live wreck piece (`onWreckHit`) of a wreck whose source
 *  (`WreckSource`) has `scale` world units per 1× unit: a cutting beam burns
 *  its line into the piece (the source's frame under it, at its pose now),
 *  so when it gives way it breaks along every beam that burned it in the
 *  last moment. An uncut rock is a "piece" at its own centre (cx = cy = 0,
 *  scale 1; rockCut.ts). */
export function burnPieceHit(
  k: PieceKnock, d: Pick<CapitalWreckDeps, 'piecePoseInto' | 'serverTick'>, id: string, scale: number,
  shooterId: string, hitX: number, hitY: number, dirX: number, dirY: number, weaponId?: WeaponId,
): void {
  const cw = cutWidthOf(weaponId);
  if (cw < 0 || d.piecePoseInto?.(id, BURN_POSE) !== true) return;
  const s = scale;
  const gap = (BURN_LINE_MERGE_GAP_PER_RADIUS * k.radius) / s;
  if (k.burn === null) k.burn = new BurnLines(gap); // once per piece, on its first cutting hit
  const c = Math.cos(BURN_POSE.angle);
  const sn = Math.sin(BURN_POSE.angle);
  // The dead hull's (virtual) origin under this piece.
  const ox = BURN_POSE.x - (k.cx * c - k.cy * sn);
  const oy = BURN_POSE.y - (k.cx * sn + k.cy * c);
  k.burn.record(shooterId, d.serverTick(), ox, oy, BURN_POSE.angle, s, hitX, hitY, dirX, dirY, cw);
}

/** At a cut kill (`onDeath`): the other beams that burned the hull in the
 *  last moment cut their own lines too (the killing shot's, through world
 *  point `kill` at hull-local `cutAng`, strip `main.w` (1× frame), is the
 *  main cut). Every heavy beam on the hull at its death cuts its own gap:
 *  another beam's wide strip that overlaps the main one (two turrets of one
 *  ship side by side) widens the main strip to cover both instead of being
 *  dropped (`BurnLines.extraCuts`' `main`): `main.w` becomes its width and
 *  `kill` moves onto its centre line (in place). */
export function deathExtraCuts(
  burn: BurnLines, pose: WreckDeathPose, kindId: ShipKindId, kill: { x: number; y: number }, tick: number, cutAng: number,
  main: { w: number },
): ReturnType<BurnLines['extraCuts']> {
  const s = shipShapeScale(getShipKind(kindId));
  hullPointInto(pose.x, pose.y, pose.angle, s, kill.x, kill.y, BURN_PT);
  const extra = burn.extraCuts(tick, BURN_PT.x, BURN_PT.y, cutAng, main.w, MAIN_STRIP);
  if (!(MAIN_STRIP.w > main.w)) return extra;
  main.w = MAIN_STRIP.w;
  // The shift is along the main cut's normal (-dir.y, dir.x), hull 1×
  // Pixi-up frame → scaled math-up (y flips) → world (turned by the pose).
  const d = unitDirFromSteps(cutAng, BURN_PT);
  const mx = -d.y * MAIN_STRIP.off * s;
  const my = -d.x * MAIN_STRIP.off * s;
  const c = Math.cos(pose.angle);
  const sn = Math.sin(pose.angle);
  kill.x += mx * c - my * sn;
  kill.y += mx * sn + my * c;
  return extra;
}
