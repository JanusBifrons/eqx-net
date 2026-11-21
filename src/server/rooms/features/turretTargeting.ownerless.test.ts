/**
 * Capture plan 4E — an ownerless base (`none:<lostCapitalId>`) has no enemies:
 * its turrets, mines and missiles never pick a target, not even the combat
 * drones a player's turret would shoot. A player's turret still does.
 */
import { describe, expect, it } from 'vitest';
import { TurretTargeting, type TurretTargetingHost } from './turretTargeting.js';
import type { SwarmEntityRecord } from '../../net/SwarmEntityRegistry.js';
import type { StructureRecord } from '../../structures/StructureRegistry.js';
import type { TurretTargetView } from '../../structures/StructureMountTicker.js';
import { createRelationContext, npcOwner, unownedOwner } from '../../../shared-types/relations.js';
import { HostileActLedger } from '../../../core/relations/HostileActLedger.js';
import { NPC_ALLEGIANCE_IDS, type NpcAllegianceId } from '../../../shared-types/allegiances.js';
import { DEFAULT_FACTION_POLICY } from '../../../shared-types/factions.js';
import { slotBase } from '../../../shared-types/sabLayout.js';

const NPC_SIDE_PARTY = Object.fromEntries(NPC_ALLEGIANCE_IDS.map((a) => [a, npcOwner(a)])) as Record<NpcAllegianceId, string>;

const NONE = unownedOwner('pstruct-cap');

function setup() {
  const drone = { id: 'swarm-1', entityId: 1, kind: 1, slot: 0, radius: 20, shipKind: 'drone' } as unknown as SwarmEntityRecord;
  const sab = new Float32Array(slotBase(2)); // drone at (0, 0), still
  const turret = { id: 'pstruct-9', owner: NONE } as unknown as StructureRecord;
  const hostileActs = new HostileActLedger();
  const host: TurretTargetingHost = {
    swarmRegistry: { all: () => [drone][Symbol.iterator](), get: (id: string) => (id === drone.id ? drone : undefined) } as unknown as TurretTargetingHost['swarmRegistry'],
    structureRegistry: { get: (id: string) => (id === turret.id ? turret : undefined) } as unknown as TurretTargetingHost['structureRegistry'],
    sabF32: () => sab,
    playerToSlot: () => new Map(),
    getActiveShip: () => undefined,
    shipPoseCache: new Map(),
    spectateParkedHull: new Map(),
    engageablePilotHull: () => null,
    visitParkedPilotHulls: () => {},
    relationCtx: createRelationContext({ hostileActs }),
    hostileActs,
    isTurretTargetable: () => true,
    npcHostileTo: () => false,
    writeSwarmRangeShape: () => {},
    npcSideParty: NPC_SIDE_PARTY,
    policyOf: () => DEFAULT_FACTION_POLICY,
    gridBounds: 20_000,
  };
  return { t: new TurretTargeting(host), turret };
}

describe('turret targeting — an ownerless base has no enemies (capture 4E)', () => {
  it('a player turret takes the combat drone in range (control)', () => {
    const { t } = setup();
    expect(t.findNearestTurretTarget(100, 0, 1000, 'alice')?.id).toBe('swarm-1');
  });

  it('an ownerless turret finds nothing: nearest, per-mount list, missile lock-on', () => {
    const { t, turret } = setup();
    expect(t.findNearestTurretTarget(100, 0, 1000, NONE)).toBeNull();
    const out: TurretTargetView[] = [];
    expect(t.collectTurretTargets(100, 0, 1000, NONE, out)).toBe(0);
    expect(t.isMissileTargetHostile(turret.id)('swarm-1')).toBe(false);
  });
});
