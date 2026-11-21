/**
 * A turret fires the moment a ray down its barrel hits the target (owner,
 * 2026-11-16: "as the turret's turning to face the target ... it should do a
 * simple ray trace between the barrel and the target, and the moment that
 * that intersects with the target's shield or hull, it fires. It doesn't
 * wait until it's like on the 0, 0 of the target").
 *
 * A lance battlecruiser trains its heavy beams onto a pilot missile frigate
 * (shield up) at the REAL traverse rate. Every heavy beam it fires at the
 * pilot must have its CENTRE line (muzzle along its direction, a thin ray) on
 * the frigate's weapon hit shape (the shield bubble) at the tick it fired,
 * AND the turrets must start firing while still turning onto the frigate's
 * centre, not hold fire until they line up on it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { LaserFiredEvent } from '../../../src/shared-types/messages.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { shipRayHit } from '../../../src/core/combat/shipHitShape.js';

/** A pulse further than this (u) from the still frigate's centre was fired
 *  before the turret lined up on the centre. */
const CENTRED = 5;

interface RoomInternals {
  aiFireResolver: { deps: { broadcast: (type: string, msg: LaserFiredEvent) => void } };
  swarmRegistry: { all: () => Iterable<{ id: string; entityId: number; shipKind?: string | null }> };
  testTraverseTicksCap: number | undefined;
}

describe('SectorRoom integration — a turret fires the moment its barrel ray hits', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 10_000);

  it('heavy beams fire as soon as the barrel ray touches the frigate\'s shield, every one on it', { timeout: 20_000 }, async () => {
    const kind = getShipKind('battlecruiser-lance');
    const beamMounts = new Set(kind.mounts.filter((m) => m.weaponId === 'heavy_beam').map((m) => m.id));
    harness = await bootSectorTestServer({
      sectorKey: null, droneCount: 0, testMode: true, asteroidConfig: [], capitalWrecks: true,
      lockTimeCapS: 0, traverseTicksCap: 0,
      dronePoses: [{ kind: 'battlecruiser-lance', x: 5000, y: 0, angle: Math.PI }],
    });
    const pid = randomUUID();
    await harness.connectActive(pid, {
      shipKind: 'missile-frigate', initialHull: 1_000_000_000, initialShield: 1_000_000_000, startHostile: true, instantLock: true,
    });
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const r = room as unknown as RoomInternals;
    let wireId = '';
    for (const rec of r.swarmRegistry.all()) if (rec.shipKind === 'battlecruiser-lance') wireId = `swarm-${rec.entityId}`;
    expect(wireId).not.toBe('');
    const shieldUp = (): boolean => {
      for (const [, s] of room.state.ships) if (s.playerId === pid && s.isActive) return (s as unknown as { shield: number }).shield > 0;
      return false;
    };

    // Each heavy beam at the pilot once `watch` is set, checked against the
    // pilot's pose as it fired.
    let watch = false;
    let fired = 0;
    let shielded = 0;
    let offCentre = 0;
    const misses: string[] = [];
    const deps = r.aiFireResolver.deps;
    const orig = deps.broadcast.bind(deps);
    deps.broadcast = (type, msg) => {
      if (type === 'laser_fired' && msg.shooterId === wireId && msg.mountId && beamMounts.has(msg.mountId) && msg.targetId === pid) {
        fired++;
        if (watch) {
          if (shieldUp()) shielded++;
          const pose = room._internals.playerPose(pid)!;
          const dx = msg.toX - msg.fromX, dy = msg.toY - msg.fromY;
          const len = Math.hypot(dx, dy);
          const hit = shipRayHit('missile-frigate', true, msg.fromX, msg.fromY, dx / len, dy / len, len + 10_000,
            pose.x, pose.y, pose.angle, 0);
          const px = pose.x - msg.fromX, py = pose.y - msg.fromY;
          const off = Math.abs((px * dy - py * dx) / len);
          if (hit === null) misses.push(`${msg.mountId}: centre line ${off.toFixed(1)} u from the frigate's centre`);
          if (off > CENTRED) offCentre++;
        }
      }
      orig(type, msg);
    };

    // The turrets snap on and fire (a quick start) ...
    const d1 = Date.now() + 8_000;
    while (Date.now() < d1 && fired === 0) await harness.advance(20);
    expect(fired, 'the heavy beams fired at the frigate').toBeGreaterThan(0);
    // ... then the frigate jumps sideways across the beams and the turrets
    // train back onto it at their REAL rate, firing as their rays touch it.
    r.testTraverseTicksCap = undefined;
    const p = room._internals.playerPose(pid)!;
    room._internals.postToWorker({ type: 'SET_POSITION', entityId: pid, x: p.x, y: p.y + 2_000, angle: p.angle, vx: 0, vy: 0, angvel: 0 });
    await harness.advance(2);
    watch = true;
    fired = 0;
    const d2 = Date.now() + 10_000;
    while (Date.now() < d2 && fired < 8) await harness.advance(10);
    expect(fired, 'the heavy beams came back onto the frigate').toBeGreaterThanOrEqual(8);
    expect(shielded, 'the frigate shield was up for every shot').toBe(fired);
    expect(misses, 'heavy beams fired with the centre line off the frigate\'s shield').toEqual([]);
    expect(offCentre, 'the turrets fired as their rays touched the frigate, before lining up on its centre').toBeGreaterThan(0);
  });
});
