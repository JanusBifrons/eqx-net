/**
 * W2a NPC warp-to (flagship fleets): a bot warps across a solar-system sector
 * through the same spool → run → drop machine as a pilot, and clients see it
 * from the snapshot alone (#16): a pilot beside it sees the spool then the run
 * (`drones[].warp` 1 then 2); a pilot at the destination sees it arrive (3).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

describe('SectorRoom integration — NPC warp-to (W2a)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it('a bot spools, runs and drops on its target; onlookers at both ends see each phase', { timeout: 40_000 }, async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [],
      galaxyBases: false, alienGates: false, solarSectors: true, peacefulDrones: true,
    } as never);
    const target = { x: 60_000, y: 0 };
    const near = await harness.connectActive(randomUUID(), { spawnX: 0, spawnY: 600 });
    const far = await harness.connectActive(randomUUID(), { spawnX: target.x, spawnY: target.y + 600 });
    const room = harness.getServerRoom()! as unknown as SectorRoom & { _internals: { spawnTestDrone(id: string, x: number, y: number): boolean; swarmPose(id: string): { x: number; y: number } | null; swarmRegistry: { get(id: string): { entityId: number } | undefined } } };
    const internals = room._internals;
    expect(internals.spawnTestDrone('warper', 0, 0)).toBe(true);
    const eid = internals.swarmRegistry.get('warper')!.entityId;

    const seenNear = new Set<number>(), seenFar = new Set<number>();
    near.onMessage('snapshot', (s: SnapshotMessage) => { for (const d of s.drones ?? []) if (d.id === eid && d.warp) seenNear.add(d.warp); });
    far.onMessage('snapshot', (s: SnapshotMessage) => { for (const d of s.drones ?? []) if (d.id === eid && d.warp) seenFar.add(d.warp); });

    await harness.advance(200);
    expect(room.warpBot('warper', target.x, target.y)).toBe(true);
    // 3 s spool + a ~3 s run + the arrival window.
    const end = Date.now() + 12_000;
    while (Date.now() < end && !seenFar.has(3)) await harness.advance(100);

    const pose = internals.swarmPose('warper')!;
    expect(Math.hypot(pose.x - target.x, pose.y - target.y)).toBeLessThan(800);
    expect(seenNear.has(1)).toBe(true); // the spool, beside it
    expect(seenNear.has(2)).toBe(true); // the departure
    expect(seenFar.has(3)).toBe(true);  // the drop, at the destination
    expect(room.warpBot('nobody', 1, 1)).toBe(false);
  });
});
