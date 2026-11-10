/**
 * testMode `lockTimeCapS` (room option) through a real SectorRoom: the bespoke
 * test/recording trigger that caps how long a NON-player lock may take.
 * Lock-to-fire stays universal (#19): the lock is still acquired, only faster.
 *
 *  - A structure turret with the cap at 0 has its lock complete on its first
 *    turret tick on a fresh ship target and fires as soon as its barrel is on
 *    target; with no cap the same turret is still acquiring after that tick
 *    and fires only after its normal lock time.
 *  - An NPC capital on a pilot: with the cap at 0 the pilot never sees the
 *    battleship's lock in the acquiring stage (it is LOCKED the first step it
 *    starts); with no cap it builds (acquiring) first.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SCENARIO, STRUCTURE_SCENARIO_PREBUILT } from '../../../src/server/rooms/scenarioLayouts.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';

interface LockedBy { t: string; s: number; p: number }

describe('SectorRoom integration — testMode lockTimeCapS', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 10_000);

  /** Boot the structure scenario, spawn a fresh drone in the turret's reach,
   *  and tick the turrets by hand until the drone takes damage. */
  async function turretArm(lockTimeCapS: number | undefined) {
    harness = await bootSectorTestServer({
      asteroidConfig: [],
      prebuiltStructures: [...STRUCTURE_SCENARIO_PREBUILT],
      ...(lockTimeCapS !== undefined ? { lockTimeCapS } : {}),
    });
    await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;
    for (let i = 0; i < 3; i++) internals.pulseStructureGrid();
    const turret = [...internals.structureRegistry.all()].find((s) => s.kind === 'turret')!;
    expect(turret.isConstructed).toBe(true);

    // A fresh target: the turret starts its lock now, not during boot.
    expect(internals.spawnTestDrone('cap-target', SCENARIO.drone.x, SCENARIO.drone.y)).toBe(true);
    const hp0 = internals.swarmHealth.get('cap-target')!;
    const t0 = Date.now();
    internals.tickStructureTurrets();
    const stageAfterFirstTick = internals.structureTurretLock(turret.id, 0)?.stage;
    let hitAfterMs = -1;
    for (let i = 0; i < 60 && hitAfterMs < 0; i++) {
      const hp = internals.swarmHealth.get('cap-target');
      if (hp === undefined || hp < hp0) { hitAfterMs = Date.now() - t0; break; }
      await harness.advance(100);
      internals.tickStructureTurrets();
    }
    if (hitAfterMs < 0) {
      const hp = internals.swarmHealth.get('cap-target');
      if (hp === undefined || hp < hp0) hitAfterMs = Date.now() - t0;
    }
    return { stageAfterFirstTick, hitAfterMs };
  }

  it('a structure turret with the cap at 0 locks on its first tick and fires on the ship well before its normal lock time', async () => {
    const capped = await turretArm(0);
    expect(capped.stageAfterFirstTick, 'locked on the first turret tick').toBe('locked');
    expect(capped.hitAfterMs, 'the capped turret hit the ship').toBeGreaterThanOrEqual(0);
    await harness!.cleanup();
    harness = undefined;

    const normal = await turretArm(undefined);
    expect(normal.stageAfterFirstTick, 'no cap: still acquiring after the first tick').toBe('acquiring');
    expect(normal.hitAfterMs, 'the uncapped turret hit the ship eventually').toBeGreaterThanOrEqual(0);
    // The uncapped lock (~1.9 s for this gun on a fighter at 550 u) is the wait the cap removes.
    expect(normal.hitAfterMs).toBeGreaterThanOrEqual(1000);
    expect(capped.hitAfterMs).toBeLessThan(normal.hitAfterMs - 500);
  }, 40_000);

  /** A battleship 1,200 u from a fighter pilot (AA reach), hostile on sight. */
  async function capitalArm(lockTimeCapS: number | undefined) {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0,
      dronePoses: [{ kind: 'battleship', x: 1200, y: 0, angle: Math.PI / 2 }],
      ...(lockTimeCapS !== undefined ? { lockTimeCapS } : {}),
    });
    const pid = randomUUID();
    const room = await harness.connectActive(pid, {
      shipKind: 'fighter', spawnX: 0, spawnY: 0, startHostile: true, initialHull: 1_000_000, noselfdmg: 1,
    });
    let sawAcquiring = false;
    let lockedAt = 0;
    room.onMessage('snapshot', (snap: { states?: Record<string, { playerId?: string; lockedBy?: LockedBy[] }> }) => {
      for (const st of Object.values(snap.states ?? {})) {
        if (st.playerId !== pid) continue;
        if (!lockedAt && st.lockedBy?.some((l) => l.s === 1)) sawAcquiring = true;
        if (!lockedAt && st.lockedBy?.some((l) => l.s === 2)) lockedAt = Date.now();
      }
    });
    const deadline = Date.now() + 15_000;
    while (!lockedAt && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    return { sawAcquiring, locked: lockedAt > 0 };
  }

  it('an NPC capital on a pilot: cap 0 locks at once, no cap builds the lock first', async () => {
    const capped = await capitalArm(0);
    expect(capped.locked, 'the battleship locked the pilot').toBe(true);
    expect(capped.sawAcquiring, 'cap 0: never seen acquiring').toBe(false);
    await harness!.cleanup();
    harness = undefined;

    const normal = await capitalArm(undefined);
    expect(normal.locked, 'no cap: the battleship still locks in the end').toBe(true);
    expect(normal.sawAcquiring, 'no cap: the lock builds first').toBe(true);
  }, 45_000);
});
