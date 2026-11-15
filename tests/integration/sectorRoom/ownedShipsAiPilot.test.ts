/**
 * RTS Part B slice 2 — player-owned ships are flown by the shared AI pilot
 * brain (`HostileDroneBehaviour`, players side), end to end.
 *
 * 1. Room `showcase-rts`: the pilot owns five parked fighters; three robot
 *    cubes hold ~2 km north. Four owned fighters, Aggressive, ordered north meet
 *    the cubes (robots attack players on sight) and kill all three.
 * 2. An idle owned ship holds where it was parked: an IDLE AI pilot with no
 *    post orbits the world origin (`tickPatrol`), so without the attach-time
 *    post a hull parked far out drifts toward (0, 0).
 * 3. Energy regenerates ONCE per tick: the brain owns the hull pool's regen;
 *    the room's pilot energy loop no longer also regenerates parked hulls.
 *
 * Failing first: before this slice the hulls were flown by the old wingman
 * brain (deleted in slice 12) and never registered with the AI controller.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { SHOWCASE_RTS_OPTS } from '../../../src/server/rooms/showcaseRooms.js';
import { HostileDroneBehaviour } from '../../../src/core/ai/HostileDroneBehaviour.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

describe('SectorRoom integration — owned ships flown by the AI pilot brain (RTS Part B slice 2)', () => {
  let harness: SectorTestHarness | undefined;

  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 10_000);

  it('four owned fighters ordered north kill the three robot cubes', async () => {
    harness = await bootSectorTestServer(structuredClone(SHOWCASE_RTS_OPTS) as unknown as Record<string, unknown>);
    const pid = randomUUID();
    const client = await harness.connectAs(pid, { shipKind: 'fighter', startMode: 'command' });
    client.send('client_ready', { type: 'client_ready' });
    await harness.events.waitFor({ tag: 'command_start', where: (d) => d['playerId'] === pid }, 5_000);
    await harness.advance(500);
    const room = harness.getServerRoom()! as unknown as SectorRoom;
    const state = room.state as SectorState;
    const internals = room._internals;
    const owned = [...state.ships.values()]
      .filter((s) => s.playerId === pid && internals.fleet.isAttached(s.shipInstanceId))
      .map((s) => s.shipInstanceId);
    expect(owned.length).toBeGreaterThanOrEqual(5);
    // Every owned hull is flown by the shared AI pilot brain.
    for (const id of owned) expect(internals.aiBrainOf(id)).toBeInstanceOf(HostileDroneBehaviour);
    const ids = owned.slice(0, 4);
    const robots = [...internals.swarmRegistry.all()].filter((r) => r.shipKind.startsWith('robot-')).map((r) => r.id);
    expect(robots).toHaveLength(3);

    // Aggressive engages what it sees (slice 6); the default Defensive only
    // hits back. The rts showcase shot sets the same before its move.
    client.send('set_stance', { type: 'set_stance', shipIds: ids, stance: 'aggressive' });
    client.send('fleet_order', { type: 'fleet_order', shipIds: ids, kind: 'move', x: 250, y: 700 });
    const robotsLeft = (): number => robots.filter((id) => internals.swarmHealth.has(id)).length;
    // A runtime ceiling, not a kill-time gate (kill time is not a metric).
    // Since slice 3 a hull fires only on its pilot's trigger (in its fire
    // range, aimed, line clear): 36-52 s here, with ~3 squadmate hits where
    // the lock-only trigger took ~28-38 s and hit squadmates 13-24 times.
    for (let i = 0; i < 160 && robotsLeft() > 0; i++) await harness.advance(500);
    expect(robotsLeft(), 'the owned fighters killed every cube').toBe(0);
  }, 120_000);

  it('an idle owned ship holds where it was parked (no drift toward the origin)', async () => {
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
    expect(internals.fleet.isAttached(sid)).toBe(true);
    expect(internals.aiBrainOf(sid)).toBeInstanceOf(HostileDroneBehaviour);
    const pose = internals.lingeringPoseCache.get(sid)!;
    const x0 = pose.x, y0 = pose.y;
    await harness.advance(10_000);
    const p = internals.lingeringPoseCache.get(sid)!;
    expect(Math.hypot(p.x - x0, p.y - y0), 'the idle hull holds its spot').toBeLessThan(150);
    await harness.disconnectClient(client);
  }, 60_000);

  it("a parked hull's energy regenerates once per tick (the brain owns its pool)", async () => {
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
    expect(internals.aiBrainOf(sid)).toBeInstanceOf(HostileDroneBehaviour);
    const ship = state.ships.get(sid)!;
    const regen = getShipKind(ship.kind).energyRegenRate ?? 0.25;
    ship.energy = 0;
    // Count ROOM updates: the brain regens once per room update, while
    // serverTick is the physics worker's step count (drifts under load).
    const t0 = room._internals.roomUpdates;
    await harness.advance(1000);
    const ticks = room._internals.roomUpdates - t0;
    expect(ticks).toBeGreaterThan(30);
    // The hull holds still (no boost, no target): only regen moves the pool.
    // Once a tick ⇒ ticks × regen (±1 tick of phase); twice would be ~2×.
    expect(ship.energy).toBeGreaterThanOrEqual((ticks - 1) * regen - 1e-6);
    expect(ship.energy).toBeLessThanOrEqual((ticks + 1) * regen + 1e-6);
    await harness.disconnectClient(client);
  }, 60_000);
});
