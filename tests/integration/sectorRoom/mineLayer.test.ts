/**
 * Mine Layer (plan soft-leaping-truffle v3) in a real room. A powered Mine
 * Layer spends munitions from base storage to lay a mine; the mine reaches
 * clients through room state (#16); an armed mine goes off on a drone (hostile
 * to a player's base, like its turrets target) and leaves room state, but a
 * friendly pilot can park on it safely; mines leave with their layer.
 *
 * Layout: Capital (0,0) → Connector (0,-350) → Mine Layer (0,-650); a Cargo
 * Bay (-450,-350) holds the munitions.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { AMMO_SHOTS_PER_UNIT } from '../../../src/shared-types/ammo.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';

const OWNER = '6a7e0000-0000-4000-8000-0000000000e1';

describe('SectorRoom integration — Mine Layer', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  async function boot() {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime',
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      peacefulDrones: true,
      prebuiltStructures: [
        { kind: 'capital', x: 0, y: 0 },
        { kind: 'connector', x: 0, y: -350 },
        { kind: 'mine_layer', x: 0, y: -650 },
        { kind: 'cargo_bay', x: -450, y: -350 },
      ],
      prebuiltStructuresOwner: OWNER,
      defaultSpawnX: 0,
      defaultSpawnY: 2500,
    });
    const observer = await harness.connectAs(randomUUID());
    const room = harness.getServerRoom()!;
    const internals = room._internals;
    const all = [...internals.structureRegistry.all()];
    const layer = all.find((r) => r.kind === 'mine_layer')!;
    const bay = all.find((r) => r.kind === 'cargo_bay')!;
    expect(layer && bay, 'layout seeded').toBeTruthy();
    // Clear anything the room's own ticks laid before the test took over.
    for (const id of [...internals.mineField.mines.keys()]) internals.mineField.mines.delete(id);
    (room.state as SectorState).mines.clear();
    layer.ammo = 0;
    bay.hold = { goods: { munitions: 3 }, blueprints: [] };
    return { room, internals, layer, bay, observer };
  }

  it('lays a mine from munitions; clients see it in room state', async () => {
    const { room, internals, layer, bay } = await boot();
    internals.tickStructureTurrets();
    expect(internals.mineField.countFor(layer.id)).toBe(1);
    expect(bay.hold!.goods.munitions).toBe(2);
    expect(layer.ammo).toBe(AMMO_SHOTS_PER_UNIT.mine_layer! - 1);
    const mine = [...internals.mineField.mines.values()][0]!;
    expect(Math.hypot(mine.x - layer.x, mine.y - layer.y)).toBeGreaterThan(300);
    const st = (room.state as SectorState).mines.get(mine.id);
    expect(st?.x).toBe(Math.round(mine.x));
    expect(st?.y).toBe(Math.round(mine.y));
  });

  it('an armed mine goes off on a drone and leaves room state', async () => {
    const { room, internals, layer, observer } = await boot();
    const hits: Array<{ shooterId?: string; targetId?: string }> = [];
    const blasts: unknown[] = [];
    observer.onMessage('damage', (e: { shooterId?: string; targetId?: string }) => hits.push(e));
    observer.onMessage('mine_detonated', (m: unknown) => blasts.push(m));
    internals.tickStructureTurrets();
    const mine = [...internals.mineField.mines.values()][0]!;
    mine.armedAtMs = 0; // armed (the 2 s arming is wall-clock)
    expect(internals.spawnTestDrone('raider', mine.x + 30, mine.y)).toBe(true);
    await harness.advance(100);
    internals.tickStructureTurrets();
    expect(internals.mineField.mines.has(mine.id), 'the mine went off').toBe(false);
    expect((room.state as SectorState).mines.has(mine.id)).toBe(false);
    await harness.advance(300);
    expect(blasts.length, 'everyone sees the blast').toBe(1);
    expect(hits.some((h) => h.shooterId === layer.id), 'the drone took the hit: ' + JSON.stringify(hits)).toBe(true);
  });

  it("a friendly pilot parked on a mine doesn't set it off; mines leave with their layer", async () => {
    const { internals, layer } = await boot();
    internals.tickStructureTurrets();
    const mine = [...internals.mineField.mines.values()][0]!;
    mine.armedAtMs = 0;
    await harness.connectActive(OWNER, { spawnX: mine.x, spawnY: mine.y });
    await harness.advance(200);
    internals.tickStructureTurrets();
    expect(internals.mineField.mines.has(mine.id), 'still there under its own pilot').toBe(true);
    internals.structureRegistry.remove(layer.id);
    internals.tickStructureTurrets();
    expect(internals.mineField.mines.size).toBe(0);
  });
});
