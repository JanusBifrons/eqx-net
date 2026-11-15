/**
 * Heavy-beam follow-through (owner, game feel: "the beam should not turn
 * after the kill and show for half a second or one second through the clean
 * cut"). When a heavy-beam turret's shot KILLS its target, that turret holds
 * its angle and keeps firing at its own cadence down the same line for the
 * weapon's `followThroughTicks`, so the beam burns on through the slice; then
 * it resumes normal targeting.
 *
 * A lance battlecruiser broadside to a pilot heavy cruiser (the beamFits
 * setup; `traverseTicksCap: 0` snaps the turrets, so without the hold a
 * turret would swing home the very tick after the kill). The pilot is left
 * one beam's worth of hull, so the next heavy-beam hit is the kill. Every
 * `laser_fired` and the killing turret's angle are read server-side, per tick.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { LaserFiredEvent } from '../../../src/shared-types/messages.js';
import { getWeapon } from '../../../src/core/combat/WeaponCatalogue.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { wrapPi } from '../../../src/core/ai/WeaponMountController.js';

interface RoomInternals {
  aiFireResolver: { deps: { broadcast: (type: string, msg: LaserFiredEvent) => void } };
  mountTicker: { droneMountAngles: Map<string, Float32Array> };
  swarmRegistry: { all: () => Iterable<{ id: string; entityId: number; shipKind?: string | null }> };
}

interface Shot { tick: number; mountId: string; dir: number; mountAngle: number; targetId?: string }

const angleOf = (x: number, y: number): number => Math.atan2(-x, y);

describe('SectorRoom integration — heavy-beam follow-through after a kill', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 10_000);

  it('the killing turret holds its angle and keeps burning down the same line, then resumes', { timeout: 15_000 }, async () => {
    const beam = getWeapon('heavy_beam');
    const follow = beam.followThroughTicks ?? 0;
    expect(follow).toBeGreaterThan(0);
    const kind = getShipKind('battlecruiser-lance');
    const beamMounts = new Set(kind.mounts.filter((m) => m.weaponId === 'heavy_beam').map((m) => m.id));
    harness = await bootSectorTestServer({
      sectorKey: null, droneCount: 0, testMode: true, asteroidConfig: [], pilotCapitals: true, capitalWrecks: true,
      lockTimeCapS: 0, traverseTicksCap: 0,
      dronePoses: [{ kind: 'battlecruiser-lance', x: 5000, y: 0, angle: Math.PI }],
    });
    const pid = randomUUID();
    await harness.connectActive(pid, {
      shipKind: 'heavy-cruiser', initialHull: 1_000_000_000, initialShield: 0, startHostile: true, instantLock: true,
    });
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const r = room as unknown as RoomInternals;
    let lanceId = '';
    let wireId = '';
    for (const rec of r.swarmRegistry.all()) if (rec.shipKind === 'battlecruiser-lance') { lanceId = rec.id; wireId = `swarm-${rec.entityId}`; }
    expect(lanceId).not.toBe('');

    const shots: Shot[] = [];
    const deps = r.aiFireResolver.deps;
    const orig = deps.broadcast.bind(deps);
    deps.broadcast = (type, msg) => {
      if (type === 'laser_fired' && msg.shooterId === wireId && msg.mountId && beamMounts.has(msg.mountId)) {
        const i = kind.mounts.findIndex((m) => m.id === msg.mountId);
        shots.push({
          tick: room._internals.serverTick, mountId: msg.mountId,
          dir: angleOf(msg.toX - msg.fromX, msg.toY - msg.fromY),
          mountAngle: r.mountTicker.droneMountAngles.get(lanceId)?.[i] ?? NaN,
          targetId: msg.targetId,
        });
      }
      orig(type, msg);
    };

    // The beams hit the pilot first; then leave it one beam's worth of hull.
    const d1 = Date.now() + 8_000;
    while (Date.now() < d1 && !shots.some((s) => s.targetId === pid)) await harness.advance(20);
    expect(shots.some((s) => s.targetId === pid), 'a heavy beam hit the pilot').toBe(true);
    for (const [, s] of room.state.ships) if (s.playerId === pid && s.isActive) s.health = beam.damage / 2;

    // Sample the killing turret's angle every few ms (each server tick).
    const angleByTick = new Map<number, number>();
    let killTick = -1;
    let killMount = '';
    const d2 = Date.now() + 8_000;
    while (Date.now() < d2) {
      const hits = shots.filter((s) => s.targetId === pid);
      const last = hits[hits.length - 1];
      const pilotAlive = [...room.state.ships.values()].some((s) => s.playerId === pid && s.isActive && s.alive);
      if (killMount === '' && !pilotAlive && last !== undefined) { killTick = last.tick; killMount = last.mountId; }
      if (killMount !== '') {
        const i = kind.mounts.findIndex((m) => m.id === killMount);
        const a = r.mountTicker.droneMountAngles.get(lanceId)?.[i];
        if (a !== undefined) angleByTick.set(room._internals.serverTick, a);
        if (room._internals.serverTick > killTick + follow + 20) break;
      }
      await harness.advance(4);
    }
    expect(killTick, 'a heavy beam killed the pilot').toBeGreaterThan(0);

    const killShot = shots.filter((s) => s.mountId === killMount && s.tick === killTick).pop()!;
    const window = shots.filter((s) => s.mountId === killMount && s.tick > killTick && s.tick < killTick + follow);
    // It keeps firing at its normal cadence through the window ...
    expect(window.length, 'the killing turret kept firing through the follow-through')
      .toBeGreaterThanOrEqual(Math.floor((follow - 1) / beam.cooldownTicks) - 1);
    // (A room update can step the worker 2+ ticks on a loaded host, so a shot
    // may land a tick or two after its reload.)
    for (let k = 1; k < window.length; k++) {
      const gap = window[k]!.tick - window[k - 1]!.tick;
      expect(gap).toBeGreaterThanOrEqual(beam.cooldownTicks);
      expect(gap).toBeLessThanOrEqual(beam.cooldownTicks + 3);
    }
    // ... down the same line, its turret not turning.
    for (const s of window) {
      expect(s.mountAngle, 'turret angle held through the follow-through').toBeCloseTo(killShot.mountAngle, 6);
      expect(Math.abs(wrapPi(s.dir - killShot.dir)), 'beam along the kill line').toBeLessThan(0.02);
    }
    for (const [t, a] of angleByTick) {
      if (t > killTick && t < killTick + follow) expect(a, `turret angle at kill+${t - killTick}`).toBeCloseTo(killShot.mountAngle, 6);
    }
    // Then it resumes: with no target left it trains home (snaps, traverse cap 0).
    let resumed = false;
    for (const [t, a] of angleByTick) if (t >= killTick + follow && Math.abs(wrapPi(a - killShot.mountAngle)) > 0.1) resumed = true;
    expect(resumed, 'the turret resumed normal targeting after the follow-through').toBe(true);
  });
});
