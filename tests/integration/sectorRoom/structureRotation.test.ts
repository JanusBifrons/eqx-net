/**
 * Phase V — a structure placed with a quarter turn must have a ROTATED physics
 * body. Before the fix the spawner forwarded the spawn angle to the worker for
 * scrap only, so a rotated Solar collided — and drew, since the client reads
 * the pose angle — at 0° while placement, connections and weapon hits used the
 * rotated box. Driven through the real `place_structure` message.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';

describe('SectorRoom integration — rotated structure placement (phase V)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it('a Solar placed with rot 90 has its body and pose rotated a quarter turn', async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
    const room = await harness.connectAs('player-1');
    await harness.advance(200);
    room.send('place_structure', { type: 'place_structure', kind: 'solar', x: 1500, y: 0, rot: 90 });
    await harness.advance(400);
    const internals = harness.getServerRoom()!._internals;
    const rec = [...internals.structureRegistry.all()].find((r) => r.kind === 'solar');
    expect(rec, 'the solar landed').toBeDefined();
    const pose = internals.swarmPose(rec!.id)!;
    expect(pose.angle).toBeCloseTo(Math.PI / 2, 3);
    expect(pose.x).toBeCloseTo(1500, 0);
  });
});
