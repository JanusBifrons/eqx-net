/**
 * B2 (plan soft-leaping-truffle v3) — NPC-owned structures in a real room.
 * Turrets pick targets through `relationOf`, so:
 *  - a neutral (trader) base ignores a passing pilot until the pilot attacks it;
 *  - a robot base engages a pilot on sight, and drones, but never robots;
 *  - a player's own turret is unchanged (drones yes, other pilots no);
 *  - an NPC base is never a wave target.
 *
 * Layout: Capital (0,0) → Connector (0,-350) → Turret (0,-650). The Capital's
 * 50 power covers the turret's 15. Pilots spawn at (0,-1000), 350 u from the
 * turret (range 600).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';

const PLAYER_OWNER = '6a7e0000-0000-4000-8000-0000000000a1';
const LAYOUT = [
  { kind: 'capital', x: 0, y: 0 },
  { kind: 'connector', x: 0, y: -350 },
  { kind: 'turret', x: 0, y: -650 },
];

describe('SectorRoom integration — NPC-owned structures (B2)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  async function boot(owner: string) {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime',
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      prebuiltStructures: LAYOUT,
      prebuiltStructuresOwner: owner,
      defaultSpawnX: 0,
      defaultSpawnY: -1000,
    });
    // The room exists once a client joins; a pending hull is never a target.
    await harness.connectAs(randomUUID());
    const room = harness.getServerRoom()!;
    const internals = room._internals;
    const all = [...internals.structureRegistry.all()];
    const turret = all.find((r) => r.kind === 'turret')!;
    const capital = all.find((r) => r.kind === 'capital')!;
    expect(turret, 'the turret was seeded').toBeDefined();
    internals.pulseStructureGrid();
    const aim = () => {
      internals.tickStructureTurrets();
      return { player: turret.turretTargetPlayer, entity: turret.turretTargetEntityId };
    };
    return { room, internals, turret, capital, aim };
  }

  it('a trader base ignores a passing pilot until the pilot attacks it', async () => {
    const { internals, capital, aim } = await boot('npc:traders:t1');
    const pilot = randomUUID();
    await harness.connectActive(pilot);
    await harness.advance(300);
    expect(aim().player, 'traders are neutral to pilots').toBeUndefined();

    internals.applyDamage(capital.id, pilot, 1);
    expect(aim().player, 'attacking the base makes the pilot hostile to it').toBe(pilot);
  });

  it('a robot base engages a pilot on sight', async () => {
    const { turret, aim } = await boot('npc:robots:r1');
    const pilot = randomUUID();
    const client = await harness.connectActive(pilot);
    const hits: Array<{ shooterId?: string }> = [];
    client.onMessage('damage', (m: { shooterId?: string }) => {
      if (m.shooterId === turret.id) hits.push(m);
    });
    await harness.advance(300);
    expect(aim().player).toBe(pilot);
    // The shot lands: the damage path accepts a player target.
    for (let i = 0; i < 20 && hits.length === 0; i++) { aim(); await harness.advance(50); }
    expect(hits.length).toBeGreaterThan(0);
  });

  it('a robot base shoots drones but never robots', async () => {
    const { internals, aim } = await boot('npc:robots:r1');
    expect(internals.spawnTestDrone('robot-1', 0, -900, 'robot-square')).toBe(true);
    await harness.advance(100);
    expect(aim().entity, 'its own side is never a target').toBeUndefined();

    expect(internals.spawnTestDrone('drone-1', 200, -900, 'fighter')).toBe(true);
    await harness.advance(100);
    expect(aim().entity).toBe(internals.swarmRegistry.get('drone-1')!.entityId);
  });

  it("a player's turret is unchanged: drones yes, other pilots no", async () => {
    const { internals, aim } = await boot(PLAYER_OWNER);
    await harness.connectActive(randomUUID());
    await harness.advance(300);
    expect(aim().player).toBeUndefined();

    expect(internals.spawnTestDrone('drone-1', 0, -900, 'fighter')).toBe(true);
    await harness.advance(100);
    const target = aim();
    expect(target.player).toBeUndefined();
    expect(target.entity).toBe(internals.swarmRegistry.get('drone-1')!.entityId);
  });

  it('an NPC base is never a wave target', async () => {
    const { room } = await boot('npc:robots:r1');
    expect(room.factionBaseReadiness().some((f) => f.factionId.startsWith('npc:'))).toBe(false);
  });
});
