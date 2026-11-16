/**
 * RTS Part B slice 5 — Stop / Defend put an owned ship on the guard leash:
 * the room hands the AI pilot brain a guard post (`holdHullAt`), so it flies
 * to the post, holds there and engages only inside its guard radius (the
 * pick itself is locked in `HostileDroneBehaviour.guardLeash.test.ts`).
 *
 * Failing first: before this slice `set_mode` Defend never reached the AI
 * pilot brain (only the order hook did), so a hull told to defend a point
 * stayed where it was parked.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { HostileDroneBehaviour } from '../../../src/core/ai/HostileDroneBehaviour.js';
import { shipTuning } from '../../../src/shared-types/shipScale/tuning.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

describe('SectorRoom integration — Stop / Defend guard leash (RTS Part B slice 5)', () => {
  let harness: SectorTestHarness | undefined;

  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 10_000);

  it('Defend at a point: the hull flies there and guards it; Stop guards where it halts', async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
    const pid = randomUUID();
    const client = await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 3000, spawnY: 1500 });
    const room = harness.getServerRoom()! as unknown as SectorRoom;
    const state = room.state as SectorState;
    const internals = room._internals;
    let sid = '';
    for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) sid = s.shipInstanceId;
    client.send('spectate', { type: 'spectate' });
    await harness.advance(300);
    const brain = internals.aiBrainOf(sid);
    expect(brain).toBeInstanceOf(HostileDroneBehaviour);
    const b = brain as HostileDroneBehaviour;
    expect(b.getGuardRadius()).toBe(shipTuning(getShipKind('fighter')).guardRadiusMin);

    client.send('set_mode', { type: 'set_mode', shipIds: [sid], mode: 'defend', x: 3600, y: 1500 });
    await harness.advance(12_000);
    let p = internals.lingeringPoseCache.get(sid)!;
    expect(Math.hypot(p.x - 3600, p.y - 1500), 'the hull flew to its Defend post').toBeLessThan(150);
    expect(b.getGuardRadius()).toBeGreaterThan(0);

    // Stop mid-move: it guards where it halts (it does not fly on, nor back).
    client.send('fleet_order', { type: 'fleet_order', shipIds: [sid], kind: 'move', x: 6600, y: 1500 });
    await harness.advance(2_500);
    client.send('fleet_order', { type: 'fleet_order', shipIds: [sid], kind: 'stop' });
    await harness.advance(500);
    const halt = { ...internals.lingeringPoseCache.get(sid)! };
    expect(halt.x).toBeGreaterThan(3700);
    expect(halt.x).toBeLessThan(6400);
    await harness.advance(8_000);
    p = internals.lingeringPoseCache.get(sid)!;
    expect(Math.hypot(p.x - halt.x, p.y - halt.y), 'the stopped hull holds near where it halted').toBeLessThan(400);
    await harness.disconnectClient(client);
  }, 60_000);
});
