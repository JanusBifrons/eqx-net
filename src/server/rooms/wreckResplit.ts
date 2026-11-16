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
 * (v + ω × r, ω) plus the parting kicks of the first break-up's model
 * (`wreckBreakKicks`: impulses against each child's own mass, from the hit),
 * at its gentlest (no violent-death boost).
 *
 * `WreckResplitter` runs the worn-out decision and the child spawn against
 * the subsystem's state through a narrow host. Runs once per split (not
 * hot-loop code); allocates freely.
 */
import { hullLocalCutAngle, wreckBodyParams, wreckBreakKicks } from '../../core/destruction/wreckPieces.js';
import { wreckChildGeometry, wreckChildSeed, wreckResplitOptions, type WreckChildChain, type WreckChildStep } from '../../core/destruction/wreckChildren.js';
import { wreckCanResplit, wreckHullArea, wreckPieceIntegrity, wreckSalvageQty, WRECK_RESPLITS_PER_TICK } from '../../core/destruction/wreckIntegrity.js';
import type { BurnLines } from '../../core/destruction/burnLines.js';
import { FRACTURE_ALGO_VERSION } from '../../core/destruction/fractureHull.js';
import type { CapitalWreckDeps, LiveWreck, PieceKnock } from './capitalWreckTypes.js';
import type { WreckPieceGeometry } from '../../core/destruction/wreckPieceFrame.js';
import { killCutStripWidth } from '../../shared-types/shipScale/destruction.js';
import { wreckSourceOf, type WreckSource } from '../../core/destruction/wreckSource.js';
import { WEAPONS, type WeaponId } from '../../core/combat/WeaponCatalogue.js';
import { asteroidYieldWeightPerUnit } from '../../shared-types/asteroidResources.js';
import { SALVAGE_POD_MAX_WEIGHT } from '../../shared-types/worldEvents.js';

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
 *
 * Fracture v12 multi-cut: with a cutting shot and the piece's `burn` lines
 * (at server tick `tick`), every other beam that burned it in the last
 * moment cuts its own line too (`BurnLines.extraCuts`: near-duplicates of
 * the breaking shot and of each other merged), carried on the step.
 */
export function planWreckResplit(
  chain: WreckChildChain, parent: WreckPieceGeometry, pose: WreckPiecePose,
  hitX: number, hitY: number, dirX: number, dirY: number, weaponId: WeaponId | undefined,
  burn: BurnLines | null = null, tick = 0,
): { step: WreckChildStep; chain: WreckChildChain; children: WreckChildSpawn[] } {
  const src = wreckSourceOf(chain.root);
  const s = src.scale;
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
    const w = killCutStripWidth(killCut);
    if (w > 0) step.cutW = w / s;
    const extra = burn?.extraCuts(tick, step.killX, step.killY, step.cutAng, step.cutW ?? 0);
    if (extra !== undefined) step.extraCuts = extra;
  }
  const next: WreckChildChain = { root: chain.root, steps: [...chain.steps, step] };
  const geom = wreckChildGeometry(next);
  if (geom.length < 2) return { step, chain: next, children: [] };
  const children = placeWreckPieces(
    src, geom, pose, ox, oy, mx, my, wreckChildSeed(chain.root.seed >>> 0, parent.index) ^ 0x3ec7, step.cutW !== undefined ? step.cutW * s : 0,
    step.cutKind === 'slice' && step.cutAng !== undefined ? { px: mx, py: my, ang: step.cutAng } : undefined,
  );
  return { step, chain: next, children };
}

/**
 * Place freshly broken pieces `geom` (body frames over the source's scaled
 * math-up frame) in the world: that frame's origin at world (ox, oy), turned
 * by `pose.angle`, with the broken thing's rigid motion (v + ω × r, ω) plus
 * the parting kicks of the first break-up's model (`wreckBreakKicks` from
 * the break at (mx, my) in that frame) at its gentlest (`harder` 0.75: wear,
 * not a violent death). The ONE placement of a re-split piece's children and
 * of a mined-out rock's pieces (rockCut.ts). Once per break (allocates).
 */
export function placeWreckPieces(
  src: WreckSource, geom: ReadonlyArray<WreckPieceGeometry>, pose: WreckPiecePose,
  ox: number, oy: number, mx: number, my: number, spinSeed: number, cutGap: number,
  slice?: { px: number; py: number; ang: number },
): WreckChildSpawn[] {
  const c = Math.cos(pose.angle);
  const sn = Math.sin(pose.angle);
  const kick = wreckBreakKicks(src, geom, mx, my, 0.75, spinSeed, cutGap, slice);
  const children: WreckChildSpawn[] = [];
  for (let i = 0; i < geom.length; i++) {
    const g = geom[i]!;
    const wx = ox + g.cx * c - g.cy * sn;
    const wy = oy + g.cx * sn + g.cy * c;
    const rx = wx - pose.x;
    const ry = wy - pose.y;
    const kx = kick.kvx[i]!;
    const ky = kick.kvy[i]!;
    children.push({
      geom: g, x: wx, y: wy, angle: pose.angle, angvel: pose.angvel + kick.kw[i]!,
      vx: pose.vx - pose.angvel * ry + kx * c - ky * sn,
      vy: pose.vy + pose.angvel * rx + kx * sn + ky * c,
    });
  }
  return children;
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
  /** Track a new wreck: a child (its parent's child count goes up), or a
   *  root (`parent` null: a mined-out rock's, rockCut.ts). */
  addWreck(w: Omit<LiveWreck, 'root'>, parent: LiveWreck | null): void;
  /** Remove a live piece (FIFO, body, its wreck's count). */
  dropPiece(id: string, fifo: string[]): void;
  /** Evict the oldest pieces of one FIFO down to its cap (a ship death's path). */
  enforceCap(capital: boolean): void;
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
    const src = w.src;
    const parent = wreckChainPiece(w.chain, k.index);
    const rs = wreckResplitOptions(src);
    if (parent === undefined || rs === null) {
      k.integrity = Number.POSITIVE_INFINITY;
      return false;
    }
    this.splitsThisTick++;
    const capital = src.profile.id === 'capital';
    const fifo = this.h.fifo(capital);
    if (fifo.length - 1 + rs.fracture.maxPieces <= this.h.cap(capital) && wreckCanResplit(src, parent.area, parent.radius)) {
      const plan = planWreckResplit(w.chain, parent, pose, hitX, hitY, dirX, dirY, weaponId, k.burn, tick);
      // v12: several beams' cuts may leave more children than one fracture's
      // cap; the FIFO must still hold them all.
      if (plan.children.length >= 2 && fifo.length - 1 + plan.children.length <= this.h.cap(capital)
        && this.spawnChildren(id, k, wreckId, w, plan, fifo, tick)) return true;
    }
    if (this.d.dropSalvage === undefined) {
      k.integrity = Number.POSITIVE_INFINITY;
      return false;
    }
    dropPieceSalvage(this.d, src, w.ore, parent.area, k.mass, pose.x, pose.y, pose.vx, pose.vy);
    this.h.dropPiece(id, fifo);
    return true;
  }

  /** Spawn the planned children as a child wreck and retire the parent
   *  piece; false when no child body could spawn. A multi-cut break (v12,
   *  the step has `extraCuts`) turns each child under the kind's re-split
   *  floor (`resplit.minAreaFrac` of the hull) into a salvage pod instead of
   *  a sliver of a piece; all of them pods: the parent just leaves (true). */
  private spawnChildren(
    id: string, k: PieceKnock, wreckId: number, w: LiveWreck,
    plan: ReturnType<typeof planWreckResplit>, fifo: string[], tick: number,
  ): boolean {
    const src = w.src;
    const [childId, serial] = this.h.newWreck();
    const rs = wreckResplitOptions(src);
    // A rock's break always pods its slivers (rockCut.ts does the same).
    const podBelow = (plan.step.extraCuts !== undefined || src.rock !== null) && rs !== null && this.d.dropSalvage !== undefined
      ? rs.minAreaFrac * wreckHullArea(src) : 0;
    const r = spawnWreckPieces(this.d, this.h, src, w, plan.children, podBelow, serial, childId, k, fifo, id);
    if (r.ids.length === 0) {
      if (r.pods === 0) return false;
      this.h.dropPiece(id, fifo);
      return true;
    }
    const { ids, mass } = r;
    const st = plan.step;
    this.h.addWreck({
      desc: {
        wreckId: childId, parentKind: w.desc.parentKind, seed: wreckChainSeed(plan.chain), killX: st.killX, killY: st.killY,
        // Not child inputs (the kind's `resplit` profile sets the fracture).
        killBlowDamage: 0, recentDamageRate: 0, snapChance: 0, algoVersion: FRACTURE_ALGO_VERSION, deathTick: tick,
        ...(st.cutKind !== undefined ? { cutKind: st.cutKind, cutAng: st.cutAng } : {}),
        ...(st.cutW !== undefined ? { cutW: st.cutW } : {}),
        ...(st.extraCuts !== undefined ? { extraCuts: st.extraCuts.slice() } : {}),
        parentWreck: wreckId, parentPiece: k.index,
      },
      pieces: ids.length, ids, mass, holdUntil: tick, chain: plan.chain, parent: wreckId, children: 0,
      src, ...(w.ore !== undefined ? { ore: w.ore } : {}),
    }, w);
    this.h.dropPiece(id, fifo);
    return true;
  }
}

/**
 * Spawn placed pieces `placed` as the pieces of wreck `wreckId` (piece ids
 * `wreck-<serial>-<index>`), each under `podBelow` world area dropped as a
 * pod instead (`dropPieceSalvage`). `like` seeds each per-piece entry's
 * knock numbers (null: the source's own, a rock's first break). The ONE
 * piece spawn of a re-split and of a mined-out rock (rockCut.ts), so the ONE
 * place a parent (`parentId`) is replaced by its pieces: the locks held on
 * it follow them (`CapitalWreckDeps.pieceSplit`).
 */
export function spawnWreckPieces(
  d: CapitalWreckDeps, h: Pick<WreckResplitHost, 'addPiece'>, src: WreckSource, w: Pick<LiveWreck, 'ore'>,
  placed: ReadonlyArray<WreckChildSpawn>, podBelow: number, serial: number, wreckId: number,
  like: PieceKnock | null, fifo: string[], parentId: string,
): { ids: string[]; mass: number; pods: number } {
  const body = wreckBodyParams(src.ship ?? src);
  const ids: string[] = [];
  const masses: number[] = []; // once per break, never per tick
  let mass = 0;
  let pods = 0;
  for (const c of placed) {
    const g = c.geom;
    if (g.area < podBelow) {
      dropPieceSalvage(d, src, w.ore, g.area, g.mass, c.x, c.y, c.vx, c.vy);
      pods++;
      continue;
    }
    const cid = `wreck-${serial}-${g.index}`;
    const ok = d.spawnPiece({
      id: cid, x: c.x, y: c.y, vx: c.vx, vy: c.vy, angle: c.angle, angvel: c.angvel,
      radius: g.radius, mass: g.mass, parentShipKind: src.ship ?? undefined, pieceIndex: g.index, wreckId,
      parts: g.parts, colliderParts: g.colliderParts,
      linearDamping: body.linearDamping, angularDamping: body.angularDamping,
      collisionGroups: body.collisionGroups, settleSpeed: body.settleSpeed, settleSpin: body.settleSpin,
    });
    if (!ok) continue;
    ids.push(cid);
    masses.push(g.mass);
    mass += g.mass;
    const knock = like ?? { mass: 0, impulsePerDamage: 0, maxDv: 0, spin: src.profile.spinScale, wakeDv: 0 };
    h.addPiece(cid, wreckId, {
      ...knock, mass: g.mass, index: g.index, integrity: wreckPieceIntegrity(src, g.mass),
      cx: g.cx, cy: g.cy, radius: g.radius, burn: null,
    }, fifo);
  }
  if (ids.length > 0) d.pieceSplit?.(parentId, ids, masses);
  return { ids, mass, pods };
}

/** A worn-out piece (or a sliver) too small to split leaves a pod: a ship
 *  wreck's carries salvage (`wreckSalvageQty`), a rock's its share of the
 *  rock's ore (area × `ore.perArea`) up to a pod's size
 *  (`SALVAGE_POD_MAX_WEIGHT` of that ore; the rest of the share is never
 *  mined, so cutting never makes ore), drawn through `OreDraw` by the room's
 *  `dropSalvage`. A rock share under one unit (a mined-out rock: perArea 0)
 *  drops nothing. No hook: nothing drops. */
export function dropPieceSalvage(
  d: CapitalWreckDeps, src: WreckSource, ore: LiveWreck['ore'],
  area: number, mass: number, x: number, y: number, vx: number, vy: number,
): void {
  if (d.dropSalvage === undefined) return;
  if (ore !== undefined) {
    const units = pieceOreUnits(ore, area);
    if (units > 0) d.dropSalvage(units, x, y, vx, vy, ore); // none left in this sliver: no pod
    return;
  }
  d.dropSalvage(wreckSalvageQty(src, mass), x, y, vx, vy);
}

/** A rock piece's ore units (area × `ore.perArea`, rounded, up to a pod's
 *  size of that ore: `SALVAGE_POD_MAX_WEIGHT`); 0 under one unit. The one
 *  rule for a worn-out rock piece's pod and a whole piece taken into a hold
 *  (wreckLineage.ts `pieceStoreOf`). */
export function pieceOreUnits(ore: NonNullable<LiveWreck['ore']>, area: number): number {
  const share = area * ore.perArea;
  if (!(share >= 1)) return 0;
  const podMax = Math.max(1, Math.floor(SALVAGE_POD_MAX_WEIGHT / asteroidYieldWeightPerUnit(ore.resource)));
  return Math.min(podMax, Math.round(share));
}
