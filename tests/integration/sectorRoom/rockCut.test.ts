/**
 * Rock cut through the REAL room (salvage stream; mining-and-salvage.md
 * "Mining asteroids"): mining-laser hits through the damage choke point
 * (`applyDamage` → `onWreckHit` → `RockCutter`) wear an asteroid until it
 * breaks along the beam into >= 2 movable wreck pieces (kind 4, a rock
 * descriptor on the wire); other weapons never wear it; grinding the pieces
 * ends in ore pods carrying the rock's resource. A real `fire` of the mining
 * laser cuts a small rock too (the fire path hands the hit point and line).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';
import { WRECK_ROCK_PARENT_KIND } from '../../../src/shared-types/messages/wreckDescriptor.js';

const WRECK_KIND = 4;

describe('SectorRoom integration: the mining laser cuts asteroids like wrecks', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  async function setup(radius: number): Promise<{ cr: ClientRoom<SectorState>; room: SectorRoom; pid: string; shipId: string }> {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
    const pid = randomUUID();
    const cr = (await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 0, spawnY: 0, instantLock: true })) as ClientRoom<SectorState>;
    const room = harness.getServerRoom() as unknown as SectorRoom;
    let shipId = '';
    for (const [id, s] of room.state.ships) if (s.playerId === pid && s.isActive) shipId = id;
    expect(room._internals.spawnTestAsteroid('rock-1', 0, 400, radius)).toBe(true);
    await harness.advance(100);
    return { cr, room, pid, shipId };
  }

  it('wears a rock to a break along the beam; other weapons do not; the pieces grind down to ore pods', { timeout: 40_000 }, async () => {
    const { room, pid } = await setup(60);
    const int = room._internals;
    int.setWreckSeed(9);
    // Guns never wear rock (rock factor 0): a heavy beam and a laser, hard.
    for (let i = 0; i < 40; i++) {
      int.applyDamage('rock-1', pid, 5_000, 6, 340, 0, 1, 'heavy_beam');
      int.applyDamage('rock-1', pid, 5_000, 6, 340, 0, 1, 'laser');
    }
    expect(int.swarmRegistry.get('rock-1'), 'the rock still stands').not.toBeNull();
    expect(int.wreckIntegrity('rock-1'), 'no wear recorded').toBeUndefined();

    // The mining laser, beamed straight up the rock 6 u right of its centre.
    let hits = 0;
    while (int.swarmRegistry.get('rock-1') !== null && hits < 200) {
      int.applyDamage('rock-1', pid, 120, 6, 340, 0, 1, 'mining_laser');
      hits++;
      if (hits === 1) expect(int.wreckIntegrity('rock-1')!).toBeGreaterThan(0);
    }
    expect(int.swarmRegistry.get('rock-1'), 'the rock left through the evict path').toBeNull();
    expect(hits, 'it took real wear, not one hit').toBeGreaterThan(5);
    const desc = int.wreckDescriptors().find((d) => d.rock?.id === 'rock-1')!;
    expect(desc, 'a rock wreck descriptor rides the snapshot').toBeDefined();
    expect(desc.parentKind).toBe(WRECK_ROCK_PARENT_KIND);
    expect(desc.cutKind).toBe('slice');
    await harness.advance(50);
    const pieces = [...int.swarmRegistry.all()].filter((r) => r.kind === WRECK_KIND && r.wreckId === desc.wreckId);
    expect(pieces.length).toBeGreaterThanOrEqual(2);
    // Along the burn line (the beam ran up x = 6): pieces on both sides of it.
    const xs = pieces.map((p) => int.wreckState(p.id)!.x);
    expect(xs.some((x) => x < 6)).toBe(true);
    expect(xs.some((x) => x > 6)).toBe(true);
    for (const p of pieces) expect(p.shipKind, 'no ship byte on a rock piece').toBeUndefined();

    // Grind the smallest pieces with the mining laser until one is an ore pod.
    const pods0 = int.loot.podCount();
    const size = (id: string): number => int.wreckIntegrity(id) ?? 0;
    for (let i = 0; i < 80 && int.loot.podCount() === pods0; i++) {
      const live = [...int.swarmRegistry.all()].filter((r) => r.kind === WRECK_KIND);
      if (live.length === 0) break;
      const small = live.reduce((a, b) => (size(b.id) < size(a.id) ? b : a));
      const p = int.wreckState(small.id)!;
      int.applyDamage(small.id, pid, size(small.id) + 1, p.x - 1, p.y, 1, 0, 'mining_laser');
      await harness.advance(20);
    }
    expect(int.loot.podCount(), 'an ore pod dropped').toBeGreaterThan(pods0);
    const pod = [...int.loot.podIds()][0]!;
    const goods = int.loot.shipHold(pod)?.goods ?? {};
    expect(goods.minerals ?? 0, 'a plain rock pods minerals (asteroidYield)').toBeGreaterThan(0);
    expect(goods.salvage ?? 0, 'never salvage').toBe(0);
  });

  it('a cut-field rock is not cut until terrain C3 (else the client draws a ghost whole rock)', { timeout: 20_000 }, async () => {
    const { room, pid } = await setup(60);
    const int = room._internals;
    // Stand-in for a field rock (CutFieldSubsystem spawns these with their
    // cut outline); the rock-cut source would rebuild the seed's outline.
    int.swarmRegistry.get('rock-1')!.fieldRock = true;
    for (let i = 0; i < 100; i++) int.applyDamage('rock-1', pid, 5_000, 6, 340, 0, 1, 'mining_laser');
    expect(int.swarmRegistry.get('rock-1'), 'the field rock still stands').not.toBeNull();
    expect(int.wreckIntegrity('rock-1'), 'no wear recorded').toBeUndefined();
  });

  it('a real mining-laser fire cuts a small locked rock', { timeout: 40_000 }, async () => {
    const { cr, room, pid, shipId } = await setup(20);
    const mounts = [{ slotId: 'latent-wing-l', weaponId: 'mining_laser' as const }];
    getPlayerShipStore().setProgress(shipId, { mounts });
    room.state.ships.get(shipId)!.mounts = mounts;
    harness.lockTarget(pid, 'rock-1');
    await harness.advance(100);
    let tick = 100;
    const end = Date.now() + 6_000;
    while (Date.now() < end && room._internals.swarmRegistry.get('rock-1') !== null) {
      cr.send('fire', { type: 'fire', tick, clientShotId: `f${tick}`, weapon: 'hitscan', dirAngle: 0, slotId: 'primary' });
      tick += 10;
      await harness.advance(100);
    }
    expect(room._internals.swarmRegistry.get('rock-1'), 'the beam wore the rock out').toBeNull();
    expect(room._internals.wreckDescriptors().some((d) => d.rock?.id === 'rock-1') || room._internals.loot.podCount() > 0,
      'it left pieces (or, all slivers, ore pods)').toBe(true);
  });
});
