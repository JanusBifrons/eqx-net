/**
 * W2c: the showcase cue `test_fleet_warp` jumps the staged fleet
 * (`showcase-fleet-warp`) to a point, keeping its formation. The first film
 * showed the fleet never moving; this reproduces that against the real room.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { SHOWCASE_FLEET_WARP_OPTS } from '../../../src/server/rooms/showcaseRooms.js';

describe('SectorRoom integration — showcase fleet warp cue (W2c)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); });

  it('the whole staged fleet warps to the cued point, in formation', { timeout: 40_000 }, async () => {
    harness = await bootSectorTestServer({ sectorKey: 'fleet-warp-test', droneCount: 0, ...SHOWCASE_FLEET_WARP_OPTS } as never);
    const client = await harness.connectActive(randomUUID());
    const internals = harness.getServerRoom()!._internals as unknown as { swarmRegistry: { all(): Iterable<{ id: string; kind: number }> }; swarmPose(id: string): { x: number; y: number } | null };
    await harness.advance(500);
    const ships = [...internals.swarmRegistry.all()].filter((r) => r.kind === 1).map((r) => r.id);
    expect(ships.length).toBe(SHOWCASE_FLEET_WARP_OPTS.dronePoses.length);
    const before = new Map(ships.map((id) => [id, internals.swarmPose(id)!]));
    // Clients must SEE the jump: the warp phase rides the drone slice (#16),
    // even for a pilot outside the fleet's interest window (this one is ~6 km
    // south: a far onlooker first saw the fleet slide off instead of jump).
    const phases = new Set<number>();
        client.onMessage('snapshot', (snap: { drones?: Array<{ id: number; warp?: number }> }) => { for (const d of snap.drones ?? []) if (d.warp) phases.add(d.warp); });
    client.send('test_fleet_warp', { type: 'test_fleet_warp', x: -45_000, y: 0 });
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      await harness.advance(250);
      const room = harness.getServerRoom() as unknown as { botWarpPhase(id: string): number };
      if (ships.every((id) => internals.swarmPose(id)!.x < -30_000 && room.botWarpPhase(id) === 0)) break; // all landed
    }
    expect([...phases].sort()).toEqual(expect.arrayContaining([1, 2]));
    for (const id of ships) {
      const a = before.get(id)!, b = internals.swarmPose(id)!;
      expect(b.x - a.x).toBeLessThan(-35_000); // jumped ~45 km west (to the nearest clear spot)
      expect(Math.abs((b.y - a.y))).toBeLessThan(2_000); // kept its place in the formation
    }
  });
});
