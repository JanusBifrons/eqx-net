/**
 * Fleet salvage order, slice 2 (lock + fire) through the REAL room: an owned
 * mining skiff, parked (AI-flown) with a wreck piece inside its mining
 * laser's reach, takes a `salvage` order on the piece; its salvage groups
 * lock the piece through the wingman lock machine (`instantLock` carries
 * over: a completed lock, #19) and fire through `PlayerFireResolver.fireHull`,
 * so the piece takes salvage damage (or is cut away). Travel into reach is
 * the next slice: the hull starts in reach.
 *
 * The piece is a battleship wreck piece: a small drone's scrap (radius ~6-9)
 * is too small for an S mount to lock at all (`lockSeconds` past its cap).
 *
 * Failing-first: before this slice nothing locked salvage for an AI-flown
 * hull (`wingmanLockKey` refuses it), so the piece stayed whole.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { SWARM_KIND_WRECK } from '../../../src/shared-types/swarmWireFormat.js';

describe('SectorRoom integration — fleet salvage order fires', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it('a parked mining skiff with a salvage order works the wreck piece', async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, asteroidConfig: [],
      subcapWrecks: true, capitalWrecks: true,
    });
    const pid = randomUUID();
    const client = await harness.connectActive(pid, { shipKind: 'mining-skiff', spawnX: 0, spawnY: 0, instantLock: true, groupMode: 'manual' });
    for (const t of ['laser_fired', 'swarm', 'damage', 'destroy', 'hit_ack', 'loot_collected', 'snapshot', 'fleet_status']) client.onMessage(t, () => {});
    const room = harness.getServerRoom()! as unknown as SectorRoom;
    const int = room._internals;
    let sid = '';
    for (const [, s] of room.state.ships) if (s.playerId === pid && s.isActive) sid = s.shipInstanceId;
    expect(sid).not.toBe('');

    // A battleship dead ahead breaks into wreck pieces when killed.
    expect(int.spawnTestDrone('bb', 0, 2500, 'battleship')).toBe(true);
    await harness.advance(100);
    int.applyDamage('bb', 'shooter-x', 1e7);
    const pieces = [...int.swarmRegistry.all()].filter((r) => r.kind === SWARM_KIND_WRECK);
    expect(pieces.length, 'the battleship left wreck pieces').toBeGreaterThan(0);
    const ids = new Set(pieces.map((p) => p.id));
    const hp = (): number => { let s = 0; for (const id of ids) s += int.swarmHealth.get(id) ?? 0; return s; };
    const whole = (): boolean => [...ids].every((id) => int.swarmRegistry.get(id));
    const piece = pieces.reduce((a, b) => (b.radius > a.radius ? b : a));

    // Park the skiff: its AI pilot takes it.
    client.send('spectate', { type: 'spectate' });
    await harness.advance(300);
    expect(int.fleet.isAttached(sid), 'the parked hull has an AI pilot').toBe(true);
    const hp0 = hp();
    await harness.advance(600);
    expect(whole() && hp() === hp0, 'no salvage without the order').toBe(true);

    expect(int.fleet.applyOrder(pid, [sid], { kind: 'salvage', targetId: `swarm-${piece.entityId}` })).toEqual([sid]);
    const worked = (): boolean => !whole() || hp() < hp0;
    for (let i = 0; i < 40 && !worked(); i++) await harness.advance(150);
    expect(worked(), 'the salvage order cut the wreck piece').toBe(true);
    await harness.disconnectClient(client);
  }, 60_000);
});
