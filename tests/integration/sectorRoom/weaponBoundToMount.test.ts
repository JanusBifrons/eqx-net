/**
 * Weapon-bound-to-mount integration test (weapons/energy/AI overhaul §1).
 *
 * Reproduction recipe: a pilot in a SCOUT (catalogue loadout = `laser`
 * bolts) sends a wire `fire` message that CLAIMS `weapon: 'heat-seeker'`.
 * The server must IGNORE the client's claimed weapon and fire the mount's
 * catalogue weapon (the scout's bolt), spawning a `laser` projectile and
 * NOT a missile.
 *
 * This MUST FAIL on pre-Step-3 code: the old `PlayerFireResolver` resolved
 * the single client-selected `weapon` field and fired it from every mount,
 * so a `heat-seeker` claim spawned a missile. The fix binds each barrel to
 * `mount.weaponId` and stops trusting the wire's `weapon`.
 *
 * Crosses the real Colyseus message boundary (the bug lives at the wire →
 * fire-path seam, not in a pure helper), per Invariant #13. White-box reads
 * of `combat.liveProjectiles` + `missileSim` mirror missileLifecycle.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import type { Room as ServerRoom } from 'colyseus';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { ProjectileRecord } from '../../../src/server/rooms/CombatSubsystem.js';

interface FireTestInternals {
  projectiles: { liveProjectiles: Map<string, ProjectileRecord> };
  missileSim: { size(): number };
}

function getRoomById(roomId: string): ServerRoom<SectorState> {
  return matchMaker.getLocalRoomById(roomId) as unknown as ServerRoom<SectorState>;
}

describe('SectorRoom integration — weapon bound to mount (server ignores claimed weapon)', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  async function joinPlayer(shipKind: string): Promise<{
    pid: string;
    cr: ClientRoom<SectorState>;
    room: ServerRoom<SectorState>;
  }> {
    const pid = randomUUID();
    const cr = (await harness.connectAs(pid, { shipKind, spawnX: 0, spawnY: 0 })) as ClientRoom<SectorState>;
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });
    return { pid, cr, room: getRoomById(cr.roomId) };
  }

  it('a SCOUT firing with weapon:"heat-seeker" spawns a BOLT (laser) projectile, not a missile', async () => {
    const shooter = await joinPlayer('scout');
    const internals = shooter.room as unknown as FireTestInternals;

    // Let the worker write the shooter's pose so the fire path resolves a
    // ray origin.
    await harness.advance(100);

    expect(internals.projectiles.liveProjectiles.size).toBe(0);
    expect(internals.missileSim.size()).toBe(0);

    // Wire fire CLAIMING a missile from the scout's primary slot.
    shooter.cr.send('fire', {
      type: 'fire',
      tick: 0,
      clientShotId: 's1',
      weapon: 'heat-seeker',
      dirAngle: 0,
      slotId: 'primary',
    });

    // Give the server a few ticks to process the message + spawn.
    await harness.advance(150);

    // The scout's mount fires its bound `laser` — a projectile, NOT a
    // missile. The claimed `heat-seeker` is ignored.
    expect(internals.missileSim.size()).toBe(0);
    expect(internals.projectiles.liveProjectiles.size).toBeGreaterThan(0);
    for (const [, rec] of internals.projectiles.liveProjectiles) {
      expect(rec.weaponId).toBe('laser');
    }
  }, 20_000);
});
