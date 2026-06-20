/**
 * Missile lifecycle integration test — verifies the SectorRoom-level
 * flow that pure unit tests can't reach:
 *
 *   1. Player A fires a heat-seeker (via spawnServerMissile) at a
 *      ship-shaped target near the spawn point.
 *   2. The simulation locks onto the target at launch.
 *   3. Within the missile's lifetime, the target takes damage via the
 *      authoritative applyDamage path (DamageEvent broadcasts to the
 *      shooter).
 *
 * Mirrors the white-box pattern used by shieldHull.test.ts — accesses
 * private collaborators via a typed cast (no _internals surface in this
 * branch's SectorRoom).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import type { Room as ServerRoom } from 'colyseus';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState, ShipState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getWeapon, type MissileWeaponDef } from '../../../src/core/combat/WeaponCatalogue.js';
import type { MissileSimulation } from '../../../src/server/rooms/MissileSimulation.js';

interface MissileTestInternals {
  missileSim: MissileSimulation;
  spawnServerMissile: (
    ownerId: string,
    spawnX: number, spawnY: number,
    dirX: number, dirY: number,
    def: MissileWeaponDef,
  ) => number | null;
}

function getRoomById(roomId: string): ServerRoom<SectorState> {
  return matchMaker.getLocalRoomById(roomId) as unknown as ServerRoom<SectorState>;
}

describe('SectorRoom integration — missile lifecycle', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    // asteroidConfig:[] = a rock-FREE sector. sol-prime's default 'dense' field
    // would otherwise litter the missile corridors with asteroids, which — now
    // that missiles collide with rock (WS-2b) — detonate a missile before it
    // reaches its intended target (e.g. the lingering hull at 600,0). Tests that
    // need a rock seed their OWN via _internals.spawnTestAsteroid (deterministic).
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  async function joinPlayer(
    shipKind: string,
    spawnX = 0,
    spawnY = 0,
  ): Promise<{ pid: string; cr: ClientRoom<SectorState>; room: ServerRoom<SectorState>; state: SectorState; shipInstanceId: string }> {
    const pid = randomUUID();
    const cr = (await harness.connectActive(pid, { shipKind, spawnX, spawnY })) as ClientRoom<SectorState>;
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });
    const room = getRoomById(cr.roomId);
    const state = room.state as SectorState;
    for (const [, s] of state.ships) {
      if (s.playerId === pid && s.isActive) {
        return { pid, cr, room, state, shipInstanceId: s.shipInstanceId };
      }
    }
    throw new Error('ship not found after join');
  }

  function findShipPlayerId(state: SectorState, pid: string): ShipState {
    for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) return s;
    throw new Error('ship gone');
  }

  it('spawn missile against a hostile target → it locks and detonates within lifetime', async () => {
    // Shooter (frigate) at origin; target (fighter) ahead at +x=200.
    const shooter = await joinPlayer('missile-frigate', 0, 0);
    const target = await joinPlayer('fighter', 200, 0);
    const internals = shooter.room as unknown as MissileTestInternals;

    // Capture target hull at start.
    const targetShip = findShipPlayerId(target.state, target.pid);
    const hullBefore = targetShip.health;
    const shieldBefore = targetShip.shield;

    // Subscribe to damage broadcasts so we can detect the missile's hit.
    const dmgEvents: Array<Record<string, unknown>> = [];
    shooter.cr.onMessage('damage', (e: Record<string, unknown>) => dmgEvents.push(e));

    // Wait one tick so shipPoseCache populates (the worker writes pose;
    // the room mirrors it at the top of update()).
    await harness.advance(100);

    // Fire missile from shooter toward target. Direction +x: dirX=1, dirY=0.
    const heatSeeker = getWeapon('heat-seeker') as MissileWeaponDef;
    const missileId = internals.spawnServerMissile(
      shooter.pid, 0, 0, 1, 0, heatSeeker,
    );
    expect(missileId).not.toBeNull();
    expect(internals.missileSim.size()).toBe(1);

    // Advance up to the missile's lifetime. heat-seeker.lifetimeTicks=360
    // at 60Hz = 6 s. Allow more wall-clock to absorb scheduling jitter.
    // Wait for either a damage event on the target OR the missile to
    // expire (size goes to 0).
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (dmgEvents.some((e) => e['targetId'] === target.pid)) break;
      if (internals.missileSim.size() === 0) break;
      await harness.advance(100);
    }

    // The missile should have detonated (size === 0) and damage event
    // should have fired against the target.
    expect(internals.missileSim.size()).toBe(0);
    const hits = dmgEvents.filter((e) => e['targetId'] === target.pid);
    expect(hits.length).toBeGreaterThan(0);
    // Damage actually landed on shield (fighter has shield), so either
    // shield is reduced OR hull is reduced.
    const ship = findShipPlayerId(target.state, target.pid);
    const shieldDelta = shieldBefore - ship.shield;
    const hullDelta = hullBefore - ship.health;
    expect(shieldDelta + hullDelta).toBeGreaterThan(0);
  }, 20_000);

  it('WS-2/R2.22 symptom 3: a missile COLLIDES with and DAMAGES a lingering hull (does not pass through)', async () => {
    // Shooter (frigate) at origin; victim (fighter) parked far down +x.
    const shooter = await joinPlayer('missile-frigate', 0, 0);
    const victim = await joinPlayer('fighter', 600, 0);
    const internals = shooter.room as unknown as MissileTestInternals;
    const sectorRoom = shooter.room as unknown as SectorRoom;
    const victimShipId = victim.shipInstanceId;

    await harness.advance(150);

    // Force the victim into a LINGERING hull via the proven fresh-spawn-displace
    // path (lingering.test.ts): disconnect → reconnect with isNewShip. The OLD
    // hull (victimShipId) displaces into lingeringSlots (isActive=false) and
    // stays parked at ~(600,0); SabPoseMirror writes its pose into
    // lingeringPoseCache each tick.
    await harness.disconnectClient(victim.cr);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === victim.pid });
    const reconnected = await harness.connectActive(victim.pid, { isNewShip: true, shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === victim.pid });

    // Park the NEW active hull far OFF the +x missile corridor so the missile
    // can only encounter the lingering hull at ~(600,0).
    sectorRoom._internals.postToWorker({ type: 'SET_POSITION', entityId: victim.pid, x: 0, y: -8000, angle: 0, vx: 0, vy: 0, angvel: 0 });
    await harness.advance(200);

    const lingering = victim.state.ships.get(victimShipId);
    expect(lingering, 'lingering hull still present').toBeDefined();
    expect(lingering!.isActive).toBe(false);
    const shieldBefore = lingering!.shield;
    const hullBefore = lingering!.health;

    // Fire a missile straight down +x from the origin. lockOnTarget excludes the
    // lingering hull (and the new active hull is parked off-corridor), so the
    // missile flies straight through (600,0) — where it must COLLIDE with the
    // lingering hull rather than pass through it.
    const heatSeeker = getWeapon('heat-seeker') as MissileWeaponDef;
    const missileId = internals.spawnServerMissile(shooter.pid, 0, 0, 1, 0, heatSeeker);
    expect(missileId).not.toBeNull();

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const cur = victim.state.ships.get(victimShipId);
      if (cur && (cur.shield < shieldBefore || cur.health < hullBefore)) break;
      if (internals.missileSim.size() === 0) break;
      await harness.advance(100);
    }

    // The lingering hull took damage — the missile collided, it did not pass
    // through. FAILS on current main: sweepCollision + detonate skip
    // isActive=false hulls, so the missile flies through and expires.
    const after = victim.state.ships.get(victimShipId);
    expect(after, 'lingering hull still tracked').toBeDefined();
    const shieldDelta = shieldBefore - after!.shield;
    const hullDelta = hullBefore - after!.health;
    expect(shieldDelta + hullDelta, 'lingering hull lost shield/hull to the missile').toBeGreaterThan(0);

    await harness.disconnectClient(reconnected);
  }, 25_000);

  it('WS-2b/R2.22 symptom 2: a missile DETONATES on an asteroid (does not pass through; deals 0 HP)', async () => {
    // Asteroid model ADR (docs/architecture/asteroid-interaction-model.md):
    // asteroids are solid, indestructible rock — a missile must detonate +
    // despawn ON contact (0 HP to the immune rock), NOT pass through.
    const shooter = await joinPlayer('missile-frigate', 0, 0);
    const internals = shooter.room as unknown as MissileTestInternals;
    const sectorRoom = shooter.room as unknown as SectorRoom;

    // Solid rock squarely on the +Y missile path.
    sectorRoom._internals.spawnTestAsteroid('ws2b-rock', 0, 400, 50);
    await harness.advance(150);

    // A missile_detonated broadcast fires ONLY on a real detonation (sweep /
    // fuse), never on lifetime expiry — so it discriminates "hit the rock"
    // from "flew through and timed out".
    const detonations: Array<Record<string, unknown>> = [];
    shooter.cr.onMessage('missile_detonated', (e: Record<string, unknown>) => detonations.push(e));

    const heatSeeker = getWeapon('heat-seeker') as MissileWeaponDef;
    const missileId = internals.spawnServerMissile(shooter.pid, 0, 0, 0, 1, heatSeeker);
    expect(missileId).not.toBeNull();

    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if (detonations.length > 0) break;
      if (internals.missileSim.size() === 0) break;
      await harness.advance(100);
    }

    // FAILS on current main: sweepCollision skips kind===0, so the missile
    // sweeps THROUGH the rock and expires (size→0) with NO detonation broadcast.
    expect(detonations.length, 'missile detonated on the asteroid (did not pass through)').toBeGreaterThan(0);
    expect(internals.missileSim.size()).toBe(0);
  }, 20_000);

  it('WS-C #14: lifetime expiry BROADCASTS missile_detonated WITHOUT splash damage (client clears, not freeze-then-fade)', async () => {
    // Bug: lifetime expiry called releaseAtPos() SILENTLY (no broadcast). The
    // missile dropped from the next snapshot, the client extrapolation capped
    // then FROZE, and the stale lifePct fade played over the frozen sprite —
    // the "missile stops, then fades" report. Fix: expiry now detonates with
    // cause='lifetime' (+ null primary) so missile_detonated fires and the
    // client removeMissile()s immediately. The 2026-06-06 impact-only design
    // (a lifetime miss deals NO damage) is preserved — detonate() skips its
    // splash loops on cause==='lifetime', so the broadcast is for the client
    // clear + VFX only, never damage.
    //
    // Single-shooter, rock-free sector ⇒ no lock candidate ⇒ the dumb missile
    // flies straight into empty space, so the ONLY way it leaves the pool is
    // lifetime expiry (not a sweep/fuse hit). A short lifetime keeps it fast.
    const shooter = await joinPlayer('missile-frigate', 0, 0);
    const internals = shooter.room as unknown as MissileTestInternals;

    const detonations: Array<Record<string, unknown>> = [];
    shooter.cr.onMessage('missile_detonated', (e: Record<string, unknown>) => detonations.push(e));
    const dmgEvents: Array<Record<string, unknown>> = [];
    shooter.cr.onMessage('damage', (e: Record<string, unknown>) => dmgEvents.push(e));

    await harness.advance(100);

    const heatSeeker = getWeapon('heat-seeker') as MissileWeaponDef;
    const shortLived: MissileWeaponDef = { ...heatSeeker, lifetimeTicks: 30 }; // ~0.5 s
    const missileId = internals.spawnServerMissile(shooter.pid, 0, 0, 1, 0, shortLived);
    expect(missileId).not.toBeNull();
    expect(internals.missileSim.size()).toBe(1);

    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (internals.missileSim.size() === 0) break;
      await harness.advance(50);
    }

    // The missile left the pool via lifetime expiry...
    expect(internals.missileSim.size()).toBe(0);
    // ...AND a missile_detonated broadcast fired for it (FAILS on current main:
    // releaseAtPos is silent, so no broadcast → client freeze-then-fade).
    const mine = detonations.filter((e) => e['missileId'] === missileId);
    expect(mine.length, 'lifetime expiry broadcast a missile_detonated').toBeGreaterThan(0);
    // ...and the fizzle dealt NO damage (impact-only preserved).
    expect(dmgEvents.length, 'a lifetime fizzle deals no splash damage').toBe(0);
  }, 15_000);

  it('missile pool overflow → spawnServerMissile returns null', async () => {
    const shooter = await joinPlayer('missile-frigate', 0, 0);
    const internals = shooter.room as unknown as MissileTestInternals;
    const heatSeeker = getWeapon('heat-seeker') as MissileWeaponDef;

    // Saturate the pool. Capacity = 256 per MissileSimulation.
    const POOL_CAP = 256;
    let lastResult: number | null = null;
    for (let i = 0; i < POOL_CAP; i++) {
      lastResult = internals.spawnServerMissile(shooter.pid, 0, 0, 1, 0, heatSeeker);
      if (lastResult === null) break;
    }
    expect(lastResult).not.toBeNull();
    expect(internals.missileSim.size()).toBe(POOL_CAP);

    // Next spawn returns null.
    const overflow = internals.spawnServerMissile(shooter.pid, 0, 0, 1, 0, heatSeeker);
    expect(overflow).toBeNull();
    // Pool stays at capacity.
    expect(internals.missileSim.size()).toBe(POOL_CAP);
  }, 15_000);
});
