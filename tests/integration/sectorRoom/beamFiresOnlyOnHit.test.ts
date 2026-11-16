/**
 * A turret fires only when a ray down its barrel hits the target (owner,
 * 2026-11-16, on film: the heavy beam first landed below a missile frigate
 * and snapped ~70 px onto it a pulse later, "it should have a basic ray
 * trace which when it is angled to hit should start firing"). The old gate
 * let a barrel fire while it would still pass up to `TURRET_FIRE_MISS` (60 u)
 * from the aim point, wider than a frigate, and the wide heavy beam's EDGE
 * then grazed the shield bubble, so the first pulse drew off the ship.
 *
 * A lance battlecruiser trains its heavy beams onto a pilot missile frigate
 * at the REAL traverse rate (no snap). Every heavy beam that fires at the
 * pilot must have its CENTRE line (muzzle along its direction, a thin ray)
 * on the frigate's hit shape at the tick it fired.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { LaserFiredEvent } from '../../../src/shared-types/messages.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { shipRayHit } from '../../../src/core/combat/shipHitShape.js';

interface RoomInternals {
  aiFireResolver: { deps: { broadcast: (type: string, msg: LaserFiredEvent) => void } };
  swarmRegistry: { all: () => Iterable<{ id: string; entityId: number; shipKind?: string | null }> };
  testTraverseTicksCap: number | undefined;
}

describe('SectorRoom integration — a turret fires only when its barrel ray hits', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 10_000);

  it('every heavy beam at a frigate is fired with its centre line on the frigate', { timeout: 20_000 }, async () => {
    const kind = getShipKind('battlecruiser-lance');
    const beamMounts = new Set(kind.mounts.filter((m) => m.weaponId === 'heavy_beam').map((m) => m.id));
    harness = await bootSectorTestServer({
      sectorKey: null, droneCount: 0, testMode: true, asteroidConfig: [], pilotCapitals: true, capitalWrecks: true,
      lockTimeCapS: 0, traverseTicksCap: 0,
      dronePoses: [{ kind: 'battlecruiser-lance', x: 5000, y: 0, angle: Math.PI }],
    });
    const pid = randomUUID();
    await harness.connectActive(pid, {
      shipKind: 'missile-frigate', initialHull: 1_000_000_000, startHostile: true, instantLock: true,
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
    // pilot's pose and shield as it fired.
    let watch = false;
    let fired = 0;
    const misses: string[] = [];
    const deps = r.aiFireResolver.deps;
    const orig = deps.broadcast.bind(deps);
    deps.broadcast = (type, msg) => {
      if (type === 'laser_fired' && msg.shooterId === wireId && msg.mountId && beamMounts.has(msg.mountId) && msg.targetId === pid) {
        fired++;
        if (watch) {
          const pose = room._internals.playerPose(pid)!;
          const dx = msg.toX - msg.fromX, dy = msg.toY - msg.fromY;
          const len = Math.hypot(dx, dy);
          const hit = shipRayHit('missile-frigate', shieldUp(), msg.fromX, msg.fromY, dx / len, dy / len, len + 10_000,
            pose.x, pose.y, pose.angle, 0);
          if (hit === null) {
            const px = pose.x - msg.fromX, py = pose.y - msg.fromY;
            misses.push(`${msg.mountId}: centre line ${Math.abs((px * dy - py * dx) / len).toFixed(1)} u from the frigate's centre`);
          }
        }
      }
      orig(type, msg);
    };

    // The turrets snap on and fire (a quick start) ...
    const d1 = Date.now() + 8_000;
    while (Date.now() < d1 && fired === 0) await harness.advance(20);
    expect(fired, 'the heavy beams fired at the frigate').toBeGreaterThan(0);
    // ... then the frigate jumps sideways across the beams and the turrets
    // train back onto it at their REAL rate, firing as they come on.
    r.testTraverseTicksCap = undefined;
    const p = room._internals.playerPose(pid)!;
    room._internals.postToWorker({ type: 'SET_POSITION', entityId: pid, x: p.x, y: p.y + 500, angle: p.angle, vx: 0, vy: 0, angvel: 0 });
    await harness.advance(2);
    watch = true;
    fired = 0;
    const d2 = Date.now() + 10_000;
    while (Date.now() < d2 && fired < 8) await harness.advance(10);
    expect(fired, 'the heavy beams came back onto the frigate').toBeGreaterThanOrEqual(8);
    expect(misses, 'heavy beams fired with the centre line off the frigate').toEqual([]);
  });
});
