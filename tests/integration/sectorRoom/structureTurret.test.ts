/**
 * Structures plan, Phase 5 — defensive turrets, through the real SectorRoom.
 * A built + powered turret near a drone aims at it and damages it through the
 * standard `applyDamage` path. Turret ticks driven deterministically.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { STARTER_STRUCTURE_KINDS } from '../../../src/shared-types/blueprints.js';

/** Room-PRIVATE collaborators the WS-8 shot tests observe — `missileSim` +
 *  `projectiles.liveProjectiles` are private fields (not on the `_internals`
 *  surface), reached by the same room-cast the missileLifecycle test uses. */
interface RoomShotPrivates {
  missileSim: { size(): number };
  projectiles: { liveProjectiles: Map<string, { ownerId: string }> };
}

async function placeAndWait(
  harness: SectorTestHarness,
  room: Awaited<ReturnType<SectorTestHarness['connectAs']>>,
  kind: string,
  x: number,
  y: number,
): Promise<string> {
  const internals = harness.getServerRoom()!._internals;
  const before = new Set<string>();
  for (const r of internals.structureRegistry.all()) before.add(r.id);
  // Economy v2 W4b — a non-starter kind is placed from a PACKED item: stock
  // one in the Capital first (this test is about turrets, not packing).
  if (!STARTER_STRUCTURE_KINDS.includes(kind)) {
    const cap = [...internals.structureRegistry.all()].find((r) => r.kind === 'capital');
    if (cap) {
      cap.hold ??= { goods: {}, blueprints: [] };
      (cap.hold.packed ??= []).push({ product: `structure:${kind}`, quality: 50 });
    }
  }
  room.send('place_structure', { type: 'place_structure', kind, x, y });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    for (const r of internals.structureRegistry.all()) {
      if (!before.has(r.id)) return r.id;
    }
    await harness.advance(40);
  }
  throw new Error(`structure ${kind} never placed`);
}

describe('SectorRoom integration — turret (Phase 5)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); });

  it('a powered turret damages a drone in range; an idle one (no drone) does not', async () => {
    harness = await bootSectorTestServer({ asteroidConfig: [] });
    const room = await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;

    // Idle drone parked in range of the turret-to-be.
    expect(internals.spawnTestDrone('mob-1', -130, 900)).toBe(true);

    await placeAndWait(harness, room, 'capital', 0, 0);
    // WS-5: leaves route via a Connector relay. Diagonal offset (120,120) so its
    // LOS clears the Capital to BOTH the close +x solar and the +y turret.
    await placeAndWait(harness, room, 'connector', 0, 350);
    const sol = await placeAndWait(harness, room, 'solar', 250, 400); // offsets turret draw
    const turret = await placeAndWait(harness, room, 'turret', -130, 400);
    for (let i = 0; i < 120; i++) internals.pulseStructureGrid();
    expect(internals.structureRegistry.get(sol)!.isConstructed).toBe(true);
    expect(internals.structureRegistry.get(turret)!.isConstructed).toBe(true);

    const before = internals.swarmHealth.get('mob-1')!;
    expect(before).toBeGreaterThan(0);

    // Fire once → the drone takes turret damage.
    internals.tickStructureTurrets();
    const after = internals.swarmHealth.get('mob-1');
    // Either it lost health, or one shot already overkilled it (evicted).
    if (after !== undefined) {
      expect(after).toBeLessThan(before);
    } else {
      expect(internals.swarmRegistry.get('mob-1') ?? null).toBeNull();
    }
    // The turret locked onto the drone (aim line target set).
    expect(internals.structureRegistry.get(turret)!.turretTargetEntityId).toBeDefined();
  }, 25_000);

  it('a Bolt Turret SPAWNS a travelling projectile owned by the turret (WS-8, real room)', async () => {
    harness = await bootSectorTestServer({ asteroidConfig: [] });
    const room = await harness.connectAs('player-1');
    const serverRoom = harness.getServerRoom()!;
    const internals = serverRoom._internals;
    const priv = serverRoom as unknown as RoomShotPrivates;
    internals.spawnTestDrone('mob-bolt', -130, 900);

    await placeAndWait(harness, room, 'capital', 0, 0);
    await placeAndWait(harness, room, 'connector', 0, 350);
    await placeAndWait(harness, room, 'solar', 250, 400);
    const bolt = await placeAndWait(harness, room, 'laser_bolt_turret', -130, 400);
    for (let i = 0; i < 150; i++) internals.pulseStructureGrid();
    expect(internals.structureRegistry.get(bolt)!.isConstructed).toBe(true);

    // A Bolt Turret SPAWNS a travelling projectile owned by the turret (NOT the
    // existing turret's instant hitscan damage). Observe the spawn directly off
    // the projectile pipeline — robust, no flight-timing dependency.
    const before = priv.projectiles.liveProjectiles.size;
    internals.tickStructureTurrets();
    expect(priv.projectiles.liveProjectiles.size).toBe(before + 1);
    let ownedByTurret = false;
    for (const p of priv.projectiles.liveProjectiles.values()) if (p.ownerId === bolt) ownedByTurret = true;
    expect(ownedByTurret).toBe(true);
    expect(internals.structureRegistry.get(bolt)!.turretTargetEntityId).toBeDefined();
  }, 25_000);

  it('a Missile Turret LAUNCHES a homing missile; it never targets the friendly Capital (WS-8 drones-only)', async () => {
    harness = await bootSectorTestServer({ asteroidConfig: [] });
    const room = await harness.connectAs('player-1');
    const serverRoom = harness.getServerRoom()!;
    const internals = serverRoom._internals;
    const priv = serverRoom as unknown as RoomShotPrivates;
    internals.spawnTestDrone('mob-msl', -140, 920);

    const cap = await placeAndWait(harness, room, 'capital', 0, 0);
    await placeAndWait(harness, room, 'connector', 0, 350);
    await placeAndWait(harness, room, 'solar', 250, 400);
    await placeAndWait(harness, room, 'solar', 0, 600); // extra power (missile draws 30)
    const mt = await placeAndWait(harness, room, 'missile_turret', -140, 420);
    for (let i = 0; i < 250; i++) internals.pulseStructureGrid();
    expect(internals.structureRegistry.get(mt)!.isConstructed).toBe(true);

    const capBefore = internals.swarmHealth.get(cap)!;
    const before = priv.missileSim.size();
    internals.tickStructureTurrets();
    // The turret LAUNCHES a homing missile (not a beam/bolt) + locks onto the drone.
    expect(priv.missileSim.size()).toBe(before + 1);
    expect(internals.structureRegistry.get(mt)!.turretTargetEntityId).toBeDefined();
    // Let it fly. The Capital (0,0) is CLOSER to the turret (250 u) than the drone
    // (354 u): a broken "any-non-owner" missile would home on the Capital. With
    // drones-only it flies AWAY toward the drone, so the Capital stays untouched.
    await harness.advance(1500);
    expect(internals.swarmHealth.get(cap)).toBe(capBefore);
  }, 30_000);

  it('an unpowered turret (overdrawn grid) does not fire', async () => {
    harness = await bootSectorTestServer({ asteroidConfig: [] });
    const room = await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;
    internals.spawnTestDrone('mob-2', 400, 700);

    await placeAndWait(harness, room, 'capital', 0, 0);
    // WS-5: relay offset on +x so its LOS clears the Capital to BOTH the +y
    // turret and the −y miner (both on the y-axis, opposite the Capital).
    await placeAndWait(harness, room, 'connector', 400, 0);
    const turret = await placeAndWait(harness, room, 'turret', 400, 140);
    // A miner far enough not to overlap, to push the grid negative.
    const miner = await placeAndWait(harness, room, 'miner', 420, -180);
    for (let i = 0; i < 400; i++) internals.pulseStructureGrid();
    expect(internals.structureRegistry.get(turret)!.isConstructed).toBe(true);
    expect(internals.structureRegistry.get(miner)!.isConstructed).toBe(true);

    const before = internals.swarmHealth.get('mob-2')!;
    internals.tickStructureTurrets();
    // capital 50 − turret 15 − miner 60 = −25 → unpowered → no shot.
    expect(internals.swarmHealth.get('mob-2')).toBe(before);
    expect(internals.structureRegistry.get(turret)!.turretTargetEntityId).toBeUndefined();
  }, 25_000);
});
