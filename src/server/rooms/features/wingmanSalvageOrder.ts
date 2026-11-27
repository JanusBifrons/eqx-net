/**
 * Fleet salvage order, slice 3 (travel + finish): how an AI-flown hull with
 * a `salvage` order gets to its piece and when the order is done
 * (`WingmanPilots`; the locks and fire are `wingmanSalvage.ts`).
 *
 * - **Travel.** Out of reach of the piece, the brain travels (`setTravel`,
 *   the owner's Move path) to a stand-off point on the line from the piece
 *   to the hull, `STANDOFF_REACH_FRAC` of the piece's working reach off its
 *   edge; arrived, it holds there (`holdHullAt`, the guard post). A piece
 *   that drifts past `REPLAN_REACH_FRAC` of the reach gets a new leg. The
 *   working reach is per piece, from the lock step's own salvage bits
 *   (`lockSalvageFlags`): a piece the hull takes in whole on touch
 *   (`LOCK_CONSUMABLE`) is flown onto; one its tractor pulls (its tier, or a
 *   `LOCK_HAUL` rock) is worked from tractor reach, so the beam brings it
 *   into the hold zone; any other from mining-laser reach (it needs cutting).
 *   The pieces go into the hold through the loot pickup
 *   (`LootCollectors.forEachSalvager`).
 * - **Lineage.** The ordered piece split, was taken in, or is one no salvage
 *   group can work: the order moves to the largest WORKABLE live piece of the
 *   same wreck lineage (the lock lineage source, `LockLineageSource`), ties
 *   to the lowest entity id, so every miner on one wreck picks the same piece.
 *   Workable: consumable, or some salvage group can lock it (`canLock`).
 * - **Finish.** No workable lineage piece left (scrap has no lineage), or the
 *   hold is full: the caller clears the order (`clearFleetOrder`) and the
 *   mode resumes. No auto-unload.
 * - **Too small to lock.** A piece no salvage group can EVER lock (the shared
 *   `lockSeconds`, point-blank and at rest, is Infinity: a small drone's
 *   scrap for an S mount) and the hull cannot take in on touch is not
 *   workable: nothing can tractor or cut it without a lock (#19).
 *
 * Runs on the ~10 Hz target step. Allocation-free on the steady path (#14):
 * the per-kind reach / lock geometry is built once per kind; a new order
 * object and its wire id are built only when the piece splits (an event).
 */
import type { AiEntityPoseOut, IAiBehaviour } from '../../../core/contracts/IAiBehaviour.js';
import { lockSeconds, type LockInputs } from '../../../core/combat/lockTime.js';
import { mountWeaponReach } from '../../../core/combat/mountReach.js';
import { isSalvageWeapon, tractorRungOf, tractorTakesTier } from '../../../core/combat/salvageTargeting.js';
import { LOCK_CONSUMABLE, LOCK_HAUL, lockTierOf } from '../../../core/combat/turretLockPick.js';
import { shipHitBound } from '../../../core/combat/shipHitShape.js';
import { getWeapon } from '../../../core/combat/WeaponCatalogue.js';
import { LOCK_TUNING, NO_PILOT_MODS, sensorFor } from '../../../shared-types/combat/lockProfile.js';
import type { FleetOrder } from '../../../shared-types/messages/fleetStatusMessages.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import type { WeaponMount } from '../../../shared-types/shipKinds/types.js';
import type { FleetShipOrders } from '../../fleet/fleetShipOrders.js';
import type { SwarmEntityRecord, SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import { groupGeometry, shipGroups } from '../lockGroups.js';
import { swarmLockId, type LockLineageSource } from '../lockSalvage.js';
import { salvageGroup } from '../lockSplit.js';
import { wireSwarmEntityId } from './fleetMessages.js';
import { isSalvageFleetTarget } from './fleetSalvageOrder.js';

/** Stand-off from the piece's edge, as a share of the salvage reach. */
export const STANDOFF_REACH_FRAC = 0.5;
/** Past this share of the salvage reach from the piece's edge: travel again. */
export const REPLAN_REACH_FRAC = 0.9;
/** `getTravelState` codes (`TRAVEL_ON_THE_WAY`, `TRAVEL_ARRIVED`). */
const ON_THE_WAY = 1;
const ARRIVED = 2;

/** What one step of a salvage order did. */
export const SALVAGE_WORKING = 0;
export const SALVAGE_RETARGETED = 1;
export const SALVAGE_DONE = 2;
export type SalvageStep = 0 | 1 | 2;

/** Activated latent mounts form the 'wing' group: guns, never salvage. */
const NO_ACTIVATED: ReadonlyArray<WeaponMount> = Object.freeze([]);

/** A mining laser or a tractor (`salvageGroup`'s per-mount test). */
function isSalvageMount(m: WeaponMount): boolean {
  const w = getWeapon(m.weaponId);
  return isSalvageWeapon(w) || w.tractor !== undefined;
}

/** A kind's salvage numbers: its longest salvage reach (the cutter's), its
 *  shortest tractor reach and rung (0: none), its hull bound (touch), and
 *  its salvage groups' lock geometry (refSize, tracking, reach, absRange). */
interface KindSalvage {
  reach: number; tractorReach: number; rung: number; touch: number; sensor: number;
  groups: Array<{ refSize: number; tracking: number; reach: number; absRange: boolean }>;
}

export interface WingmanSalvageOrderHost {
  swarmRegistry: Pick<SwarmEntityRegistry, 'getByEntityId'>;
  swarmEntityPoseInto(id: string, out: AiEntityPoseOut): boolean;
  /** Parked hulls' live poses and the ships (a hull's pose and kind on `fly`). */
  lingeringPoseCache: ReadonlyMap<string, { x: number; y: number }>;
  state(): { ships: { get(id: string): { kind: string } | undefined } };
  /** The wreck lineages (the lock lineage source); absent / null: none. */
  salvageLineage?(): LockLineageSource | null;
  /** Hull `sid` has a hold and it is full (absent: never full). */
  salvageHoldFull?(sid: string): boolean;
  /** Hull `sid`'s salvage lock bits for lock key `key` (`lockSalvageFlags`);
   *  absent: 0 (every piece worked from laser reach, none consumable). */
  salvageFlags?(sid: string, key: string): number;
}

export class WingmanSalvageOrder {
  /** Per hull: the order target it last saw live and that piece's lineage root. */
  private readonly seen = new Map<string, { id: string; key: string; root: number }>();
  private readonly byKind = new Map<string, KindSalvage>();
  private readonly pose: AiEntityPoseOut = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
  private readonly members: string[] = [];
  private readonly inp: LockInputs = { refSize: 1, tracking: 1, reach: 1, sensor: 1, pilotSpeed: 1, signature: 1, dx: 0, dy: 0, dvx: 0, dvy: 0 };

  constructor(private readonly h: WingmanSalvageOrderHost) {}

  /** The kind's salvage reach and lock geometry (built once per kind). */
  private kind(kindId: string): KindSalvage {
    let k = this.byKind.get(kindId);
    if (k !== undefined) return k;
    const kind = getShipKind(kindId);
    k = { reach: 0, tractorReach: 0, rung: tractorRungOf(kind.mounts ?? NO_ACTIVATED), touch: shipHitBound(kindId), sensor: sensorFor(kind) * NO_PILOT_MODS.lockSpeed, groups: [] };
    for (const g of shipGroups(kind, NO_ACTIVATED)) {
      if (!salvageGroup(g)) continue;
      k.groups.push(groupGeometry(g.mounts));
      for (const m of g.mounts) {
        if (!isSalvageMount(m)) continue;
        const r = mountWeaponReach(m);
        k.reach = Math.max(k.reach, r);
        if (getWeapon(m.weaponId).tractor !== undefined) k.tractorReach = k.tractorReach > 0 ? Math.min(k.tractorReach, r) : r;
      }
    }
    this.byKind.set(kindId, k);
    return k;
  }

  /** Can any salvage group of a `kindId` ship ever lock a piece of `radius`
   *  (the shared `lockSeconds`, best case: point-blank, at rest)? */
  canLock(kindId: string, radius: number): boolean {
    const k = this.kind(kindId);
    const inp = this.inp;
    inp.sensor = k.sensor; inp.pilotSpeed = 1; inp.signature = radius; inp.hullRadii = radius;
    inp.dx = 0; inp.dy = 0; inp.dvx = 0; inp.dvy = 0;
    for (let i = 0; i < k.groups.length; i++) {
      const g = k.groups[i]!;
      inp.refSize = g.refSize; inp.tracking = g.tracking; inp.reach = g.reach; inp.absRange = g.absRange; inp.lockRange = g.reach;
      if (Number.isFinite(lockSeconds(inp, LOCK_TUNING))) return true;
    }
    return false;
  }

  /** The live salvage piece order `o` names, else null. */
  private live(o: Readonly<FleetOrder>): SwarmEntityRecord | null {
    if (o.kind !== 'salvage' || !isSalvageFleetTarget(o.targetId, this.h.swarmRegistry)) return null;
    return this.h.swarmRegistry.getByEntityId(wireSwarmEntityId(o.targetId)) as SwarmEntityRecord | null;
  }

  /** Note hull `sid`'s live target, its lock key and lineage root (on a
   *  change only: the key string is built then, never per step). */
  private note(sid: string, o: Readonly<FleetOrder> & { kind: 'salvage' }, rec: SwarmEntityRecord): { key: string; root: number } {
    const s = this.seen.get(sid);
    if (s !== undefined && s.id === o.targetId) return s;
    const key = `s:${rec.entityId}`;
    const root = this.h.salvageLineage?.()?.rootOf(key) ?? -1;
    if (s !== undefined) { s.id = o.targetId; s.key = key; s.root = root; return s; }
    const n = { id: o.targetId, key, root };
    this.seen.set(sid, n);
    return n;
  }

  /** Can hull `sid` (kind `kindId`) work piece `rec` (lock key `key`):
   *  take it in on touch, or lock it with some salvage group? */
  private workable(sid: string, kindId: string, rec: SwarmEntityRecord, key: string): boolean {
    return ((this.h.salvageFlags?.(sid, key) ?? 0) & LOCK_CONSUMABLE) !== 0 || this.canLock(kindId, rec.radius);
  }

  /** The piece's working reach for hull `sid`: 0 = fly onto it (taken in
   *  on touch), its tractor reach (pulled into the hold), else the cutter's. */
  private workReach(sid: string, k: KindSalvage, key: string): number {
    const f = this.h.salvageFlags?.(sid, key) ?? 0;
    if ((f & LOCK_CONSUMABLE) !== 0) return 0;
    if (k.tractorReach > 0 && ((f & LOCK_HAUL) !== 0 || tractorTakesTier(k.rung, lockTierOf(f)))) return k.tractorReach;
    return k.reach;
  }

  /** The largest workable live piece of lineage `root` (ties: the lowest
   *  entity id; the same pick for every miner), else null. */
  private largest(sid: string, kindId: string, root: number): SwarmEntityRecord | null {
    const src = this.h.salvageLineage?.();
    if (root < 0 || src == null) return null;
    const m = this.members;
    m.length = 0;
    src.keysOf(root, m);
    let best: SwarmEntityRecord | null = null;
    for (let i = 0; i < m.length; i++) {
      const n = swarmLockId(m[i]!);
      const rec = n < 0 ? null : (this.h.swarmRegistry.getByEntityId(n) as SwarmEntityRecord | null);
      if (rec === null || (best !== null && (rec.radius < best.radius || (rec.radius === best.radius && rec.entityId > best.entityId)))) continue;
      if (this.workable(sid, kindId, rec, m[i]!)) best = rec;
    }
    m.length = 0;
    return best;
  }

  /**
   * One ~10 Hz step of hull `sid`'s salvage order (`w.order`, kind salvage)
   * at (x, y): retarget on a split or an unworkable piece, finish (hold
   * full, no workable piece left), else fly (`fly`). `hold` is the room's
   * `holdHullAt`.
   */
  step(sid: string, kindId: string, w: FleetShipOrders, brain: IAiBehaviour | null, x: number, y: number,
    hold: (b: IAiBehaviour, x: number, y: number) => void): SalvageStep {
    const o = w.order;
    if (o === null || o.kind !== 'salvage') return SALVAGE_WORKING;
    if (this.h.salvageHoldFull?.(sid) === true) return SALVAGE_DONE;
    let rec = this.live(o);
    let root = -1;
    if (rec !== null) {
      const s = this.note(sid, o, rec);
      if (this.workable(sid, kindId, rec, s.key)) {
        if (brain !== null) this.flyTo(sid, kindId, rec, s.key, brain, x, y, false, hold);
        return SALVAGE_WORKING;
      }
      root = s.root;
    } else {
      const s = this.seen.get(sid);
      root = s !== undefined && s.id === o.targetId ? s.root : -1;
    }
    rec = this.largest(sid, kindId, root);
    if (rec === null) return SALVAGE_DONE;
    const next: FleetOrder = { kind: 'salvage', targetId: `swarm-${rec.entityId}` }; // retarget event only
    w.order = next;
    const s = this.note(sid, next as FleetOrder & { kind: 'salvage' }, rec);
    if (brain !== null) this.flyTo(sid, kindId, rec, s.key, brain, x, y, true, hold);
    return SALVAGE_RETARGETED;
  }

  /** The order was just issued / the mode re-applied: fly hull `sid` to the
   *  piece now. False when it can't (no live piece, pose or ship): the caller
   *  applies the mode as usual. */
  fly(sid: string, o: Readonly<FleetOrder>, brain: IAiBehaviour, hold: (b: IAiBehaviour, x: number, y: number) => void): boolean {
    const rec = this.live(o);
    const p = this.h.lingeringPoseCache.get(sid);
    const kindId = this.h.state().ships.get(sid)?.kind;
    if (rec === null || o.kind !== 'salvage' || p === undefined || kindId === undefined) return false;
    const s = this.note(sid, o, rec);
    this.flyTo(sid, kindId, rec, s.key, brain, p.x, p.y, true, hold);
    return true;
  }

  /** Travel to the stand-off point when out of the piece's working reach;
   *  hold once arrived (or at once when `fresh` and already in reach). A
   *  piece taken in on touch is flown onto: the hull holds on its centre. */
  private flyTo(sid: string, kindId: string, rec: SwarmEntityRecord, key: string, brain: IAiBehaviour, x: number, y: number, fresh: boolean,
    hold: (b: IAiBehaviour, x: number, y: number) => void): void {
    if (!this.h.swarmEntityPoseInto(rec.id, this.pose)) return;
    const k = this.kind(kindId);
    const reach = this.workReach(sid, k, key);
    const travel = brain.getTravelState?.() ?? 0;
    if (travel === ON_THE_WAY && !fresh) return;
    const dx = x - this.pose.x, dy = y - this.pose.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (reach === 0) { // touch: onto the piece
      if (d - rec.radius > k.touch) { if (brain.setTravel !== undefined) brain.setTravel(this.pose.x, this.pose.y); else hold(brain, this.pose.x, this.pose.y); }
      else if (fresh || travel === ARRIVED) hold(brain, this.pose.x, this.pose.y);
      return;
    }
    if (d - rec.radius <= reach * REPLAN_REACH_FRAC) {
      if (fresh || travel === ARRIVED) hold(brain, x, y);
      return;
    }
    const off = rec.radius + reach * STANDOFF_REACH_FRAC;
    const tx = this.pose.x + (dx / d) * off, ty = this.pose.y + (dy / d) * off;
    if (brain.setTravel !== undefined) brain.setTravel(tx, ty);
    else hold(brain, tx, ty);
  }

  /** The hull left the AI pilot: drop its cache. */
  forget(sid: string): void { this.seen.delete(sid); }
}
