/**
 * Fleet salvage order (slice 1: the order on the wire + acceptance). A
 * `fleet_order` of kind `salvage` names a wreck piece (swarm kind 4) or a
 * scrap piece (kind 3, never a loot pod) by its wire id `swarm-<n>`. Ships in
 * the command with a mining tool (`hasMiningTool`, read by the room) take the
 * one-off `salvage` order through `FleetCommandSubsystem.applyOrder`; the rest
 * GUARD: the existing escort mode on the first accepted salvager
 * (`setMode('escort')`). No salvager accepted ⇒ nothing happens.
 *
 * Extends the fleet command layer; locking / cutting and travel are later
 * slices. Allocation-free past the order object (#14): reused scratch.
 */
import type { FleetCommandSubsystem, FleetModeData } from '../../fleet/FleetCommandSubsystem.js';
import type { SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import { isLootPod, SWARM_KIND_SCRAP, SWARM_KIND_WRECK } from '../../../shared-types/swarmWireFormat.js';
import { wireSwarmEntityId } from './fleetMessages.js';

/** Does `targetId` name a live wreck piece or scrap piece (not a rock, pod, ship or structure)? */
export function isSalvageFleetTarget(
  targetId: string,
  reg: Pick<SwarmEntityRegistry, 'getByEntityId'>,
): boolean {
  const eid = wireSwarmEntityId(targetId);
  if (eid < 0) return false;
  const rec = reg.getByEntityId(eid);
  if (rec === null) return false;
  return rec.kind === SWARM_KIND_WRECK || (rec.kind === SWARM_KIND_SCRAP && !isLootPod(rec));
}

/** What one salvage command did (reused scratch; valid until the next call). */
export interface FleetSalvageResult {
  /** Ships that took the salvage order. */
  readonly salvagers: string[];
  /** Ships that took escort on `salvagers[0]` (no mining tool). */
  readonly guards: string[];
}

/**
 * Build the salvage applier. `canSalvage(shipId)`: the hull carries a mining
 * tool. The caller checks the target first (`isSalvageFleetTarget`).
 */
export function makeFleetSalvageOrder(
  fleet: Pick<FleetCommandSubsystem, 'applyOrder' | 'setMode'>,
  canSalvage: (shipId: string) => boolean,
): (callerId: string, shipIds: readonly string[], targetId: string) => FleetSalvageResult {
  const miners: string[] = [];
  const others: string[] = [];
  const res: FleetSalvageResult = { salvagers: [], guards: [] };
  const escortData: FleetModeData = {};
  return (callerId, shipIds, targetId) => {
    miners.length = 0; others.length = 0;
    res.salvagers.length = 0; res.guards.length = 0;
    for (let i = 0; i < shipIds.length; i++) {
      const id = shipIds[i]!;
      if (canSalvage(id)) miners.push(id); else others.push(id);
    }
    if (miners.length === 0) return res;
    // One order object per accepted command: the brain keeps it as its order.
    const took = fleet.applyOrder(callerId, miners, { kind: 'salvage', targetId });
    for (let i = 0; i < took.length; i++) res.salvagers.push(took[i]!);
    if (res.salvagers.length === 0 || others.length === 0) return res;
    escortData.escortId = res.salvagers[0];
    const guarded = fleet.setMode(callerId, others, 'escort', escortData);
    escortData.escortId = undefined;
    for (let i = 0; i < guarded.length; i++) res.guards.push(guarded[i]!);
    return res;
  };
}
