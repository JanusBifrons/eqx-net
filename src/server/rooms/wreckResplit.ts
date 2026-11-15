/**
 * Wreck re-split placement (salvage stream PR 5; capital-destruction.md §S4
 * "Re-split"): the server half of breaking one live wreck piece again. Pure
 * apart from reading the weapon catalogue, so `CapitalWreckSubsystem` keeps
 * only the bookkeeping (integrity, refcounts, FIFO, spawn and remove hooks).
 *
 * Frames. Every wreck piece, root or child, is its geometry's body frame: the
 * dead hull's scaled math-up frame translated to the piece centroid
 * (`fracturePiecesToGeometry`), never turned. So a live piece at world P with
 * angle θ puts the dead hull's (virtual) origin at O = P − R(θ)·(cx, cy), the
 * hit maps into the hull 1× Pixi-up frame through O and θ, and a child
 * spawns at O + R(θ)·(ccx, ccy), angle θ, with the parent's rigid motion
 * (v + ω × r, ω) and a small parting kick away from the hit, the way the
 * first break-up parts its pieces.
 *
 * `WreckResplitter` runs the worn-out decision and the child spawn against
 * the subsystem's state through a narrow host. Runs once per split (not
 * hot-loop code); allocates freely.
 */
import { hullLocalCutAngle, wreckBodyParams } from '../../core/destruction/wreckPieces.js';
import { wreckChildGeometry, wreckChildSeed, wreckResplitOptions, type WreckChildChain, type WreckChildStep } from '../../core/destruction/wreckChildren.js';
import { wreckCanResplit, wreckPieceIntegrity, wreckSalvageQty, WRECK_RESPLITS_PER_TICK } from '../../core/destruction/wreckIntegrity.js';
import { FRACTURE_ALGO_VERSION } from '../../core/destruction/fractureHull.js';
import type { CapitalWreckDeps, LiveWreck, PieceKnock } from './CapitalWreckSubsystem.js';
import type { WreckPieceGeometry } from '../../core/destruction/wreckPieceFrame.js';
import { DESTRUCTION_PROFILES } from '../../shared-types/shipScale/destruction.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import { shipShapeScale } from '../../core/geometry/shipHullOutline.js';
import { WEAPONS, type WeaponId } from '../../core/combat/WeaponCatalogue.js';

/** A live piece's pose and motion (world). */
export interface WreckPiecePose {
  x: number; y: number; vx: number; vy: number; angle: number; angvel: number;
}

/** One child piece, placed in the world. */
export interface WreckChildSpawn {
  geom: WreckPieceGeometry;
  x: number; y: number; vx: number; vy: number; angle: number; angvel: number;
}

/** The piece `pieceIndex` of the chain's last generation, or undefined. */
export function wreckChainPiece(chain: WreckChildChain, pieceIndex: number): WreckPieceGeometry | undefined {
  return wreckChildGeometry(chain).find((g) => g.index === pieceIndex);
}

/** The seed of the chain's last generation (the root's with no steps). */
export function wreckChainSeed(chain: WreckChildChain): number {
  let seed = chain.root.seed >>> 0;
  for (const s of chain.steps) seed = wreckChildSeed(seed, s.pieceIndex);
  return seed;
}

/**
 * Break piece `parent` (of `chain`'s last generation, live at `pose`) where a
 * shot travelling (dirX, dirY) hit it at world (hitX, hitY). Returns the new
 * step (the child descriptor's fields), the child chain and the placed
 * children; no children when the fracture gave fewer than two.
 */
export function planWreckResplit(
  chain: WreckChildChain, parent: WreckPieceGeometry, pose: WreckPiecePose,
  hitX: number, hitY: number, dirX: number, dirY: number, weaponId: WeaponId | undefined,
): { step: WreckChildStep; chain: WreckChildChain; children: WreckChildSpawn[] } {
  const kind = getShipKind(chain.root.kindId);
  const s = shipShapeScale(kind);
  const c = Math.cos(pose.angle);
  const sn = Math.sin(pose.angle);
  // The dead hull's virtual origin under this piece.
  const ox = pose.x - (parent.cx * c - parent.cy * sn);
  const oy = pose.y - (parent.cx * sn + parent.cy * c);
  // The hit in the hull's scaled math-up frame, then its 1× Pixi-up frame.
  const hx = hitX - ox;
  const hy = hitY - oy;
  const mx = hx * c + hy * sn;
  const my = -hx * sn + hy * c;
  const step: WreckChildStep = { pieceIndex: parent.index, killX: mx / s, killY: -my / s };
  const killCut = weaponId !== undefined ? WEAPONS.get(weaponId)?.killCut : undefined;
  if (killCut !== undefined && (dirX !== 0 || dirY !== 0)) {
    step.cutKind = killCut.kind;
    step.cutAng = hullLocalCutAngle({ x: 0, y: 0, vx: 0, vy: 0, angle: pose.angle, angvel: 0 }, { x: dirX, y: dirY });
    const w = killCut.width ?? 0;
    if (w > 0) step.cutW = w / s;
  }
  const next: WreckChildChain = { root: chain.root, steps: [...chain.steps, step] };
  const geom = wreckChildGeometry(next);
  const children: WreckChildSpawn[] = [];
  if (geom.length < 2) return { step, chain: next, children };
  const profile = DESTRUCTION_PROFILES[shipTuning(kind).destruction];
  // The parting kick: the speed every first-break seam opens at (#18).
  const sep = shipTuning(kind).wreckSeparate * profile.separateScale;
  for (const g of geom) {
    const wx = ox + g.cx * c - g.cy * sn;
    const wy = oy + g.cx * sn + g.cy * c;
    const rx = wx - pose.x;
    const ry = wy - pose.y;
    let kx = g.cx - mx;
    let ky = g.cy - my;
    const kl = Math.hypot(kx, ky);
    if (kl > 1e-6) { kx /= kl; ky /= kl; } else { kx = 0; ky = 0; }
    children.push({
      geom: g, x: wx, y: wy, angle: pose.angle, angvel: pose.angvel,
      vx: pose.vx - pose.angvel * ry + (kx * c - ky * sn) * sep,
      vy: pose.vy + pose.angvel * rx + (kx * sn + ky * c) * sep,
    });
  }
  return { step, chain: next, children };
}

/** The wreck state `WreckResplitter` touches, owned by `CapitalWreckSubsystem`. */
export interface WreckResplitHost {
  /** The FIFO a kind's pieces live in (capital or sub-cap) and its cap. */
  fifo(capital: boolean): string[];
  cap(capital: boolean): number;
  /** A free wreck id and a fresh piece-id serial. */
  newWreck(): [wreckId: number, serial: number];
  /** Track a spawned piece (its per-piece entry, FIFO slot and wreck). */
  addPiece(id: string, wreckId: number, entry: PieceKnock, fifo: string[]): void;
  /** Track a child wreck (its parent's child count goes up). */
  addWreck(w: LiveWreck, parent: LiveWreck): void;
  /** Remove a live piece (FIFO, body, its wreck's count). */
  dropPiece(id: string, fifo: string[]): void;
}

/**
 * Worn-out pieces (§S4): a piece whose hidden integrity reached 0 splits or
 * turns to salvage. At most `WRECK_RESPLITS_PER_TICK` per tick.
 */
export class WreckResplitter {
  private splitTick = -1;
  private splitsThisTick = 0;

  constructor(private readonly d: CapitalWreckDeps, private readonly h: WreckResplitHost) {}

  /**
   * Piece `id` of wreck `wreckId` is worn out. Big enough (`wreckCanResplit`)
   * and with room under its FIFO cap for a whole child fracture, it breaks
   * through the same fracture as its wreck (`planWreckResplit`): a child
   * wreck with its own descriptor naming this piece, its pieces spawned
   * through `spawnPiece` from this piece's live pose. Else it turns into a
   * salvage pod (`dropSalvage`). Either way the piece leaves (true). False
   * (the hit goes on to shove it): no pose, over this tick's split budget
   * (it splits on a later hit), or no salvage hook (it stops wearing).
   * Runs once per split, so it may allocate.
   */
  wornOut(
    id: string, k: PieceKnock, wreckId: number, w: LiveWreck,
    hitX: number, hitY: number, dirX: number, dirY: number, weaponId: WeaponId | undefined,
  ): boolean {
    const tick = this.d.serverTick();
    if (tick !== this.splitTick) {
      this.splitTick = tick;
      this.splitsThisTick = 0;
    }
    if (this.splitsThisTick >= WRECK_RESPLITS_PER_TICK) return false;
    const pose = this.d.piecePose?.(id) ?? null;
    if (pose === null) return false;
    const kindId = w.chain.root.kindId;
    const parent = wreckChainPiece(w.chain, k.index);
    const rs = wreckResplitOptions(kindId);
    if (parent === undefined || rs === null) {
      k.integrity = Number.POSITIVE_INFINITY;
      return false;
    }
    this.splitsThisTick++;
    const capital = DESTRUCTION_PROFILES[shipTuning(getShipKind(kindId)).destruction].id === 'capital';
    const fifo = this.h.fifo(capital);
    if (fifo.length - 1 + rs.fracture.maxPieces <= this.h.cap(capital) && wreckCanResplit(kindId, parent.area, parent.radius)) {
      const plan = planWreckResplit(w.chain, parent, pose, hitX, hitY, dirX, dirY, weaponId);
      if (plan.children.length >= 2 && this.spawnChildren(id, k, wreckId, w, plan, fifo, tick)) return true;
    }
    if (this.d.dropSalvage === undefined) {
      k.integrity = Number.POSITIVE_INFINITY;
      return false;
    }
    this.d.dropSalvage(wreckSalvageQty(kindId, k.mass), pose.x, pose.y, pose.vx, pose.vy);
    this.h.dropPiece(id, fifo);
    return true;
  }

  /** Spawn the planned children as a child wreck and retire the parent
   *  piece; false when no child body could spawn. */
  private spawnChildren(
    id: string, k: PieceKnock, wreckId: number, w: LiveWreck,
    plan: ReturnType<typeof planWreckResplit>, fifo: string[], tick: number,
  ): boolean {
    const kindId = w.chain.root.kindId;
    const [childId, serial] = this.h.newWreck();
    const body = wreckBodyParams(kindId);
    const ids: string[] = [];
    let mass = 0;
    for (const c of plan.children) {
      const g = c.geom;
      const cid = `wreck-${serial}-${g.index}`;
      const ok = this.d.spawnPiece({
        id: cid, x: c.x, y: c.y, vx: c.vx, vy: c.vy, angle: c.angle, angvel: c.angvel,
        radius: g.radius, mass: g.mass, parentShipKind: kindId, pieceIndex: g.index, wreckId: childId,
        parts: g.parts, colliderParts: g.colliderParts,
        linearDamping: body.linearDamping, angularDamping: body.angularDamping,
        collisionGroups: body.collisionGroups, settleSpeed: body.settleSpeed, settleSpin: body.settleSpin,
      });
      if (!ok) continue;
      ids.push(cid);
      mass += g.mass;
      this.h.addPiece(cid, childId, { ...k, mass: g.mass, index: g.index, integrity: wreckPieceIntegrity(kindId, g.mass) }, fifo);
    }
    if (ids.length === 0) return false;
    const st = plan.step;
    this.h.addWreck({
      desc: {
        wreckId: childId, parentKind: kindId, seed: wreckChainSeed(plan.chain), killX: st.killX, killY: st.killY,
        // Not child inputs (the kind's `resplit` profile sets the fracture).
        killBlowDamage: 0, recentDamageRate: 0, snapChance: 0, algoVersion: FRACTURE_ALGO_VERSION, deathTick: tick,
        ...(st.cutKind !== undefined ? { cutKind: st.cutKind, cutAng: st.cutAng } : {}),
        ...(st.cutW !== undefined ? { cutW: st.cutW } : {}),
        parentWreck: wreckId, parentPiece: k.index,
      },
      pieces: ids.length, ids, mass, holdUntil: tick, chain: plan.chain, parent: wreckId, children: 0,
    }, w);
    this.h.dropPiece(id, fifo);
    return true;
  }
}
