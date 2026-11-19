/**
 * Per-sector live counts the LivingWorldDirector reads (`playerCount` for the
 * desired-distribution computation, `liveCounts` for the `/galaxy/snapshot`
 * aggregation + the control meter's per-side presence). Moved verbatim out of
 * `SectorRoom` (god-file split slice 25); the room keeps one-line public
 * delegates so the director's `LivingWorldRoom` surface is unchanged. The
 * room hands in a narrow host (`() => value` for fields it reassigns). Runs on
 * the director's ~1.5 s control tick, never the 60 Hz loop.
 */
import { allegianceOfKind } from '../../shared-types/shipKinds.js';
import { SWARM_KIND_DRONE } from '../../shared-types/swarmWireFormat.js';
import { parseOwner } from '../../shared-types/relations.js';
import type { SectorLiveCounts } from '../livingworld/LivingWorldRoom.js';
import { tallyFaction, type FactionPresenceMap } from '../livingworld/factionPresence.js';
import type { SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { StructureRegistry } from '../structures/StructureRegistry.js';
import { isLiveTerritoryLock } from '../structures/territoryLockRules.js';
import type { PatrolSubsystem } from '../bases/PatrolSubsystem.js';
import type { ShipState } from './schema/SectorState.js';

/** What the live counts read from the room; getters read the live field. */
export interface SectorLiveCountsHost {
  playerToSlot(): ReadonlyMap<string, number>;
  getActiveShip(playerId: string): Pick<ShipState, 'alive' | 'isActive'> | undefined;
  swarmRegistry: Pick<SwarmEntityRegistry, 'all'>;
  structureRegistry: Pick<StructureRegistry, 'all' | 'size'>;
  patrols: Pick<PatrolSubsystem, 'count' | 'factionOf'>;
  /** The room's ONE NPC→player hostility query. */
  npcHostileTo(entityId: string, playerId: string): boolean;
}

/** Active, alive, non-lingering player — the same filter the AI view-rebuild
 *  uses (the one ownership site for "who counts as present"). */
function isPresent(host: SectorLiveCountsHost, playerId: string): boolean {
  const ship = host.getActiveShip(playerId);
  return ship?.alive === true && ship.isActive;
}

/** Active, alive, non-lingering players in this sector. The director feeds
 *  this into the desired-distribution computation. */
export function sectorPlayerCount(host: SectorLiveCountsHost): number {
  let n = 0;
  for (const [pid] of host.playerToSlot()) {
    if (isPresent(host, pid)) n++;
  }
  return n;
}

/** Phase-3 — live per-sector counts for the `/galaxy/snapshot` aggregation.
 *  Read by the LivingWorldDirector on its ~1.5 s control tick (NOT the 60 Hz
 *  update loop), so the small per-call allocation + O(drones × players) scan is
 *  fine. A drone is an "enemy" iff it is hostile to a present active player (an
 *  active wave); a roaming neutral squad — hostile to nobody present — counts as
 *  `neutrals`, which matches the wave design (roamers are neutral until they
 *  attack a based, present owner). */
export function sectorLiveCounts(host: SectorLiveCountsHost): SectorLiveCounts {
  // Present active players — the same "who counts as present" filter sectorPlayerCount uses.
  const present: string[] = [];
  for (const [pid] of host.playerToSlot()) {
    if (isPresent(host, pid)) present.push(pid);
  }
  const byFaction: FactionPresenceMap = new Map();
  for (const pid of present) tallyFaction(byFaction, pid, 'ships');
  let enemies = 0;
  let neutrals = 0;
  for (const rec of host.swarmRegistry.all()) {
    if (rec.kind !== SWARM_KIND_DRONE) continue;
    tallyFaction(byFaction, (host.patrols.count > 0 ? host.patrols.factionOf(rec.id) : undefined) ?? allegianceOfKind(rec.shipKind), 'ships');
    let hostile = false;
    for (const pid of present) {
      if (host.npcHostileTo(rec.id, pid)) {
        hostile = true;
        break;
      }
    }
    if (hostile) enemies++;
    else neutrals++;
  }
  let playerStructures = 0;
  let lockSides: string[] | undefined;
  for (const rec of host.structureRegistry.all()) {
    const o = parseOwner(rec.owner);
    if (o.kind === 'player') playerStructures++;
    tallyFaction(byFaction, o.faction, 'structures');
    if (isLiveTerritoryLock(rec)) (lockSides ??= []).push(o.faction);
  }
  return { players: present.length, enemies, neutrals, structures: host.structureRegistry.size, playerStructures, byFaction, lockSides };
}
