/**
 * Fleet salvage order, slice 2 (lock + fire): what an AI-flown hull with a
 * `salvage` order does with its weapon groups (`WingmanPilots`). Only its
 * SALVAGE groups (a mining laser or a tractor: `salvageGroup`, the lock
 * hand-over's own test) lock the ordered scrap / wreck piece, by the swarm
 * lock key `s:<entityId>` (`resolveLockTarget`: terrain, never hostile); its
 * gun groups keep the AI pilot brain's pick and the stance, and never lock
 * or fire at the piece. A salvage group's trigger is its lock (the capital
 * "trigger is its lock" rule): the brain never aims at salvage. Lock-to-fire
 * (#19) is the lock subsystem's own: this only picks the key.
 *
 * Kept apart from `wingmanLockKey` (one cached key per hull, the brain's
 * target) so the two keys never thrash one cache. Per-tick path (#14): the
 * key is cached per hull (a string is built only when the order's target
 * changes); the salvage group ids are built once per ship kind.
 */
import type { FleetOrder } from '../../../shared-types/messages/fleetStatusMessages.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import type { WeaponMount } from '../../../shared-types/shipKinds/types.js';
import type { SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import { shipGroups } from '../lockGroups.js';
import { salvageGroup } from '../lockSplit.js';
import { wireSwarmEntityId } from './fleetMessages.js';
import { isSalvageFleetTarget } from './fleetSalvageOrder.js';

/** Activated latent mounts form the 'wing' group: guns, never salvage. */
const NO_ACTIVATED: ReadonlyArray<WeaponMount> = Object.freeze([]);

export class WingmanSalvage {
  /** Per hull: its salvage order's target and that target's lock key. */
  private readonly keys = new Map<string, { id: string; key: string }>();
  /** Per ship kind: the ids of its salvage groups. */
  private readonly groupsByKind = new Map<string, ReadonlySet<string>>();

  constructor(private readonly h: { swarmRegistry: Pick<SwarmEntityRegistry, 'getByEntityId'> }) {}

  /** The lock key of hull `sid`'s salvage order target (a live scrap or
   *  wreck piece), else null (no salvage order, or the piece is gone). */
  lockKey(sid: string, order: Readonly<FleetOrder> | null): string | null {
    if (order === null || order.kind !== 'salvage' || !isSalvageFleetTarget(order.targetId, this.h.swarmRegistry)) return null;
    const c = this.keys.get(sid);
    if (c !== undefined && c.id === order.targetId) return c.key;
    const key = `s:${wireSwarmEntityId(order.targetId)}`;
    if (c !== undefined) { c.id = order.targetId; c.key = key; } else this.keys.set(sid, { id: order.targetId, key });
    return key;
  }

  /** Does group `groupId` of a `kindId` ship carry a mining laser or a tractor? */
  isSalvageGroup(kindId: string, groupId: string): boolean {
    let set = this.groupsByKind.get(kindId);
    if (set === undefined) {
      const s = new Set<string>();
      for (const g of shipGroups(getShipKind(kindId), NO_ACTIVATED)) if (salvageGroup(g)) s.add(g.slot.id);
      this.groupsByKind.set(kindId, (set = s));
    }
    return set.has(groupId);
  }

  /** The key group `groupId` of a `kindId` ship locks: `salv` (the salvage
   *  order's key, or null) for a salvage group, else the brain's `key`. */
  groupKey(kindId: string, groupId: string, salv: string | null, key: string | null): string | null {
    return salv !== null && this.isSalvageGroup(kindId, groupId) ? salv : key;
  }

  /** Is group `groupId` a salvage group of hull `sid` working a live salvage
   *  order (its trigger is its lock, the capital rule; a gun's never is)? */
  firesOnLock(sid: string, order: Readonly<FleetOrder> | null, kindId: string, groupId: string): boolean {
    return this.isSalvageGroup(kindId, groupId) && this.lockKey(sid, order) !== null;
  }

  /** The hull left the AI pilot: drop its cached key. */
  forget(sid: string): void { this.keys.delete(sid); }
}
