/**
 * RTS Part B slice 11 — fleet Patrol on the AI pilot brain.
 *
 * An owned ship given a 3-point patrol walks its fleet route (the ONE route,
 * kept on the wingman store), stepped by the shared `stepRoute` (the garrison
 * patrols' stepper): it visits the three waypoints in order and loops back to
 * the first, and the fleet panel reads "patrolling".
 *
 * Failing first: before this slice Patrol mode held the hull at its post
 * (the brain never flew the route).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

describe('SectorRoom integration — an owned ship flies its patrol route (RTS Part B slice 11)', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('a 3-point patrol visits all three waypoints in order and loops', async () => {
    const pid = randomUUID();
    const client = await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 0, spawnY: 0 });
    const room = harness.getServerRoom()! as unknown as SectorRoom;
    const state = room.state as SectorState;
    const internals = room._internals;
    let sid = '';
    for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) sid = s.shipInstanceId;
    client.send('spectate', { type: 'spectate' });
    await harness.advance(300);
    expect(internals.fleet.isAttached(sid)).toBe(true);

    // The first waypoint is the one nearest the hull (the resume rule).
    const route: [number, number][] = [[0, 1500], [1500, 1500], [1500, 0]];
    expect(internals.fleet.setMode(pid, [sid], 'patrol', { route })).toEqual([sid]);
    const w = internals.fleet.ordersOf(sid)!;
    const brain = internals.aiBrainOf(sid)!;

    const visits: number[] = [];
    let patrolling = false;
    const trace: string[] = [];
    for (let i = 0; i < 240 && visits.length < 5; i++) {
      await harness.advance(250);
      const p = internals.lingeringPoseCache.get(sid);
      expect(p, 'the ship is alive and flown').toBeDefined();
      const idx = w.routeIdx;
      if (visits.length === 0 || visits[visits.length - 1] !== idx) visits.push(idx);
      const row = internals.fleet.statusFor(pid)[0]!;
      if (row.activity === 'patrolling') patrolling = true;
      trace.push(`${(i * 0.25).toFixed(2)}s @ ${p!.x.toFixed(0)},${p!.y.toFixed(0)} wp ${idx} ${row.activity} patrolLeg ${brain.isPatrolling?.()}`);
    }
    const msg = trace.join('\n');
    // Waypoint indices flown, in order, round the loop and back.
    expect(visits.slice(0, 5), `visits all three in order and loops:\n${msg}`).toEqual([0, 1, 2, 0, 1]);
    expect(patrolling, `the panel reads patrolling:\n${msg}`).toBe(true);
    expect(internals.fleet.statusFor(pid)[0]!.mode).toBe('patrol');
    await harness.disconnectClient(client);
  }, 120_000);
});
