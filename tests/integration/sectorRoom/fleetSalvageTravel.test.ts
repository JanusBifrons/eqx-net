/**
 * Fleet salvage order, slice 3 (travel + finish) through the REAL room: an
 * owned mining skiff, parked (AI-flown) OUT of its mining laser's reach of a
 * wreck piece, takes a `salvage` order on it; its AI pilot travels in
 * (`setTravel`, the Move path), cuts the piece (slice 2's locks and fire),
 * follows the wreck lineage when the piece goes, and the order clears once
 * no lineage piece is left (`wingmanSalvageOrder.ts`).
 *
 * Failing-first: before this slice the order never moved the hull, so a
 * piece out of reach was never worked and the order never cleared.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { SWARM_KIND_WRECK } from '../../../src/shared-types/swarmWireFormat.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { mountWeaponReach } from '../../../src/core/combat/mountReach.js';

describe('SectorRoom integration — fleet salvage order travels and finishes', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it('a parked skiff out of reach travels to the wreck, cuts it, and the order clears when it is gone', async () => {
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

    // A battleship well past the mining laser's reach breaks into wreck pieces.
    const laser = getShipKind('mining-skiff').mounts!.find((m) => m.weaponId === 'mining_laser')!;
    const laserReach = mountWeaponReach(laser);
    expect(int.spawnTestDrone('bb', 0, laserReach + 2500, 'battleship')).toBe(true);
    await harness.advance(100);
    int.applyDamage('bb', 'shooter-x', 1e7);
    const pieces = [...int.swarmRegistry.all()].filter((r) => r.kind === SWARM_KIND_WRECK);
    expect(pieces.length, 'the battleship left wreck pieces').toBeGreaterThan(0);
    const ids = new Set(pieces.map((p) => p.id));
    const hp = (): number => { let s = 0; for (const id of ids) s += int.swarmHealth.get(id) ?? 0; return s; };
    const whole = (): boolean => [...ids].every((id) => int.swarmRegistry.get(id));
    const piece = pieces.reduce((a, b) => ((b as { radius?: number }).radius! > (a as { radius?: number }).radius! ? b : a)) as { id: string; entityId: number; radius: number };

    // Park the skiff: its AI pilot takes it.
    client.send('spectate', { type: 'spectate' });
    await harness.advance(300);
    expect(int.fleet.isAttached(sid), 'the parked hull has an AI pilot').toBe(true);
    const gap = (): number => {
      const h = int.lingeringPoseCache.get(sid)!;
      const p = int.swarmPose(piece.id) ?? { x: 0, y: laserReach + 2500 };
      return Math.hypot(h.x - p.x, h.y - p.y) - piece.radius;
    };
    const gap0 = gap();
    expect(gap0, 'the skiff starts out of its mining laser reach').toBeGreaterThan(laserReach);
    const hp0 = hp();

    expect(int.fleet.applyOrder(pid, [sid], { kind: 'salvage', targetId: `swarm-${piece.entityId}` })).toEqual([sid]);
    const worked = (): boolean => !whole() || hp() < hp0;
    for (let i = 0; i < 200 && !worked(); i++) await harness.advance(150);
    expect(gap(), 'the skiff travelled in').toBeLessThan(gap0);
    expect(worked(), 'the salvage order cut the wreck piece').toBe(true);
    expect(int.fleet.ordersOf(sid)?.order?.kind).toBe('salvage');

    // The whole wreck goes: the order finishes and clears.
    for (const r of [...int.swarmRegistry.all()]) if (r.kind === SWARM_KIND_WRECK) int.evictSwarm(r.id);
    for (let i = 0; i < 20 && int.fleet.ordersOf(sid)?.order != null; i++) await harness.advance(150);
    expect(int.fleet.ordersOf(sid)?.order ?? null, 'no lineage piece left: the order cleared').toBeNull();
    await harness.disconnectClient(client);
  }, 90_000);

  it('what it salvages goes into its hold: a parked skiff on a fighter wreck collects the pieces', async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, asteroidConfig: [],
      subcapWrecks: true, keepAllOnDeath: true,
    });
    const pid = randomUUID();
    const client = await harness.connectActive(pid, { shipKind: 'mining-skiff', spawnX: 0, spawnY: 0, instantLock: true, groupMode: 'manual' });
    for (const t of ['laser_fired', 'swarm', 'damage', 'destroy', 'hit_ack', 'loot_collected', 'snapshot', 'fleet_status']) client.onMessage(t, () => {});
    const room = harness.getServerRoom()! as unknown as SectorRoom;
    const int = room._internals;
    let sid = '';
    for (const [, s] of room.state.ships) if (s.playerId === pid && s.isActive) sid = s.shipInstanceId;

    // A fighter breaks up a little way off: hold-size (AA tier) wreck pieces.
    expect(int.spawnTestDrone('f1', 0, 1500, 'fighter')).toBe(true);
    await harness.advance(100);
    int.applyDamage('f1', 'shooter-x', 1e7);
    await harness.advance(100);
    for (const pod of [...int.loot.podIds()]) int.loot.expireNow(pod); // its loot drop is not under test
    const pieces = [...int.swarmRegistry.all()].filter((r) => r.kind === SWARM_KIND_WRECK);
    expect(pieces.length, 'the fighter left wreck pieces').toBeGreaterThan(0);
    const piece = pieces.reduce((a, b) => (b.radius > a.radius ? b : a));

    client.send('spectate', { type: 'spectate' });
    await harness.advance(300);
    expect(int.fleet.isAttached(sid), 'the parked hull has an AI pilot').toBe(true);
    const cargo = (): number => int.loot.shipHold(sid)?.goods.salvage ?? 0;
    expect(cargo()).toBe(0);

    expect(int.fleet.applyOrder(pid, [sid], { kind: 'salvage', targetId: `swarm-${piece.entityId}` })).toEqual([sid]);
    for (let i = 0; i < 200 && cargo() === 0; i++) await harness.advance(150);
    expect(cargo(), 'the hold gained salvage from the wreck').toBeGreaterThan(0);
    await harness.disconnectClient(client);
  }, 90_000);
});
