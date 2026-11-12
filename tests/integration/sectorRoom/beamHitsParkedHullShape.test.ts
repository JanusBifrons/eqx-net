/**
 * Follow-up to the spectate-parked-hull fix (owner decision 2026-11-12: a
 * parked ship is still there). A PLAYER's hitscan beam tested every lingering
 * hull against the fighter-sized `hitRadius` circle (24 u) in
 * `PlayerFireResolver`'s lingering pass, so a beam passing 60 u off a parked
 * heavy cruiser's centre (well inside its hull) went straight through it.
 * Same bug class as the projectile sweep (fixed in `ProjectilePipeline`): a
 * parked hull must be hit with the same per-kind shield/hull shape as the ship
 * when it was flown.
 *
 * Geometry: shooter at the origin, nose +y. The heavy cruiser parks (Spectate)
 * with its centre 60 u off the beam line, its near edge within beam reach.
 * The shooter's lock is on a drone far behind it, so the shot is accepted and
 * the beam's first contact decides the hit.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { DamageEvent } from '../../../src/shared-types/messages.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';

async function waitUntil(pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

const R = getShipKind('heavy-cruiser').radius;
const HULL_Y = R + 120;
const DRONE_Y = HULL_Y + R + 400;

describe('SectorRoom integration — a player beam hits a parked hull by its real shape', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [],
      pilotCapitals: true, peacefulDrones: true,
      dronePoses: [{ kind: 'fighter', x: 0, y: DRONE_Y, angle: 0 }],
    });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('a beam 60 u off a parked heavy cruiser\'s centre hits it', { timeout: 30_000 }, async () => {
    const parkedPid = randomUUID();
    const parked = (await harness.connectActive(parkedPid, {
      shipKind: 'heavy-cruiser', spawnX: 60, spawnY: HULL_Y, initialHull: 1_000_000, initialShield: 0,
    })) as ClientRoom<SectorState>;
    const server = harness.getServerRoom() as unknown as SectorRoom;
    let shipId = '';
    for (const [, s] of server.state.ships) if (s.playerId === parkedPid && s.isActive) shipId = s.shipInstanceId;
    expect(shipId).not.toBe('');
    parked.send('spectate', { type: 'spectate' });
    await waitUntil(() => server._internals.lingeringSlots.has(shipId), 3000, 'the hull is parked');

    const shooterPid = randomUUID();
    const shooter = (await harness.connectActive(shooterPid, {
      shipKind: 'interceptor', spawnX: 0, spawnY: 0, groupMode: 'manual',
    })) as ClientRoom<SectorState>;
    const hits: DamageEvent[] = [];
    shooter.onMessage('damage', (e: DamageEvent) => { if (e.targetId === shipId) hits.push(e); });
    const drone = [...server._internals.swarmRegistry.all()].find((r) => r.kind === 1)!;
    harness.lockTarget(shooterPid, drone.id);

    // Fire a few times (each shot is its own ack; cooldown between).
    for (let i = 0; i < 4 && hits.length === 0; i++) {
      shooter.send('fire', {
        type: 'fire', tick: server._internals.serverTick, clientShotId: `s${i}`,
        weapon: 'hitscan', dirAngle: 0, slotId: 'primary',
      });
      await harness.advance(400);
    }
    expect(hits.length, 'the beam went through the parked hull').toBeGreaterThan(0);
  });
});
