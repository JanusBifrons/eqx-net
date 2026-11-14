/**
 * Player fire range is measured from EACH TURRET to the target's HULL.
 *
 * Owner decision (2026-11-14): "weapon fire range is measured from each turret
 * (the mount's world muzzle) to the nearest point of the target's true hull;
 * a mount fires only when that distance <= the mount's own weapon reach." A
 * battleship's AA (reach ~1,428 u) could not fire at another battleship lying
 * alongside: the gate measured centre to centre (~1.7 km), and the server's
 * fire gate checked bearing only, so a turret far out of its own reach still
 * fired at anything the group's centre-measured lock covered.
 *
 * Repro (player battleship at the origin facing +y, AA group in MAN):
 *   1. a hostile battleship alongside, centres 1,700 u apart, hull within the
 *      starboard AA mounts' reach: the AA group's shots are accepted;
 *   2. a small drone 1,550 u off the beam (inside the group's centre-measured
 *      lock reach, so the lock holds) but further than 1,428 u from every AA
 *      mount: every AA shot is refused, spending no energy (on main the
 *      server accepted them once the turrets had trained).
 * The lock is held with the `harness.lockTarget` trigger (#19); locks at any
 * distance are a separate change.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

interface ShipEnergy { energy: number }

async function fireAa(
  harness: SectorTestHarness, droneKind: string,
): Promise<{ accepted: number; rejected: number; energyBefore: number; energyAfter: number }> {
  const pid = randomUUID();
  const room = (await harness.connectActive(pid, {
    shipKind: 'battleship', spawnX: 0, spawnY: 0, initialHull: 10_000_000,
    groupMode: 'manual', instantLock: true, startHostile: true,
  })) as ClientRoom<SectorState>;
  const acks = new Map<string, boolean>(); // clientShotId → rejected
  room.onMessage('hit_ack', (m: { clientShotId: string; rejected?: boolean }) => acks.set(m.clientShotId, m.rejected === true));
  room.onMessage('*', () => { /* drain other messages */ });

  const server = harness.getServerRoom() as unknown as SectorRoom;
  const ship = (): ShipEnergy => (server as unknown as { getActiveShip(p: string): ShipEnergy }).getActiveShip(pid);
  const target = [...server._internals.swarmRegistry.all()].find((r) => r.kind === 1 && r.shipKind === droneKind)!;
  expect(target, `the ${droneKind} is in the room`).toBeTruthy();
  const key = `s:${target.entityId}`;
  const lockBy = Date.now() + 5_000;
  for (;;) {
    try { harness.lockTarget(pid, key, 'aa'); break; } catch (e) {
      if (Date.now() > lockBy) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  // Let the AA turrets train onto it (re-asserting the lock each step).
  for (let i = 0; i < 20; i++) {
    harness.lockTarget(pid, key, 'aa');
    await new Promise((r) => setTimeout(r, 100));
  }
  const energyBefore = ship().energy;
  for (let i = 0; i < 20; i++) {
    harness.lockTarget(pid, key, 'aa');
    const tick = server._internals.serverTick;
    room.send('fire', { type: 'fire', tick, clientShotId: `a${i}`, weapon: 'laser', dirAngle: 0, slotId: 'aa' });
    await new Promise((r) => setTimeout(r, 100));
  }
  const deadline = Date.now() + 3_000;
  while (acks.size < 20 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  const energyAfter = ship().energy;
  let accepted = 0;
  let rejected = 0;
  for (const rej of acks.values()) if (rej) rejected++; else accepted++;
  return { accepted, rejected, energyBefore, energyAfter };
}

describe('SectorRoom integration — a player turret fires by its own range to the hull', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => { if (harness) await harness.cleanup(); harness = undefined; }, 10_000);

  it('the AA fires at a battleship alongside (hull in reach, centres 1.7 km apart)', async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, pilotCapitals: true, asteroidConfig: [],
      dronePoses: [{ kind: 'battleship', x: 1_700, y: 0, angle: 0 }],
    });
    const r = await fireAa(harness, 'battleship');
    expect(r.accepted, `AA shots accepted (${r.rejected} refused)`).toBeGreaterThan(0);
  }, 60_000);

  it('the AA is refused at a drone out of every AA mount\'s reach, spending no energy', async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, pilotCapitals: true, asteroidConfig: [],
      dronePoses: [{ kind: 'heavy', x: 1_550, y: 0, angle: 0 }],
    });
    const r = await fireAa(harness, 'heavy');
    expect(r.rejected, 'every AA shot was answered').toBeGreaterThan(0);
    expect(r.accepted, 'no AA shot accepted out of reach').toBe(0);
    expect(r.energyAfter, 'no energy spent on refused shots').toBeGreaterThanOrEqual(r.energyBefore);
  }, 60_000);
});
