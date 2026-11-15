/**
 * Heavy-beam follow-through (owner, game feel: "the beam should not turn
 * after the kill and show for half a second or one second through the clean
 * cut"). When a heavy-beam turret's shot KILLS its target, that turret holds
 * the beam's WORLD line and keeps firing at its own cadence down it for the
 * weapon's `followThroughTicks`, so the beam burns on through the slice; then
 * it resumes normal targeting.
 *
 * A lance battlecruiser broadside to a pilot heavy cruiser (the beamFits
 * setup; `traverseTicksCap: 0` snaps the turrets onto the pilot). The pilot
 * is left one beam's worth of hull, so the next heavy-beam hit is the kill.
 * From then the lance's hull is held turning (its AI pilot's keys replaced by
 * turn-left, the player controls it flies by) and the turrets train at their
 * REAL traverse rate (the cap lifted): a hold relative to the hull swings the
 * beam with the hull (found on film: it slid down the victim's hull), and a
 * snapping turret would hide whether the real rate keeps up. Every
 * `laser_fired`, the hull angle and the killing turret's angle are read
 * server-side, per tick.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { LaserFiredEvent } from '../../../src/shared-types/messages.js';
import { getWeapon } from '../../../src/core/combat/WeaponCatalogue.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { wrapPi } from '../../../src/core/ai/WeaponMountController.js';
import { AI_INPUT_TURN_LEFT } from '../../../src/core/contracts/IAiBehaviour.js';

interface IntentSink {
  postIntent: (slot: number, fx: number, fy: number, torque: number, setAngvel?: number) => void;
  postInput?: (slot: number, bits: number) => void;
}
interface RoomInternals {
  aiFireResolver: { deps: { broadcast: (type: string, msg: LaserFiredEvent) => void } };
  mountTicker: { droneMountAngles: Map<string, Float32Array> };
  swarmRegistry: { all: () => Iterable<{ id: string; entityId: number; slot: number; shipKind?: string | null }> };
  aiController: { sink: IntentSink };
  testTraverseTicksCap: number | undefined;
}

interface Shot { tick: number; mountId: string; dir: number; mountAngle: number; targetId?: string }

const angleOf = (x: number, y: number): number => Math.atan2(-x, y);

describe('SectorRoom integration — heavy-beam follow-through after a kill', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 10_000);

  it('the killing turret holds the world line while the hull turns, burning on, then resumes', { timeout: 15_000 }, async () => {
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
    let lanceSlot = -1;
    for (const rec of r.swarmRegistry.all()) {
      if (rec.shipKind === 'battlecruiser-lance') { lanceId = rec.id; wireId = `swarm-${rec.entityId}`; lanceSlot = rec.slot; }
    }
    expect(lanceId).not.toBe('');
    const hullAngle = (): number => room._internals.swarmPose(lanceId)?.angle ?? NaN;

    // Hold the lance's hull turning once `spin` is set: its AI pilot's keys
    // (or impulse intent) are replaced by turn-left for that slot.
    let spin = false;
    const sink = r.aiController.sink;
    const origInput = sink.postInput!.bind(sink);
    const origIntent = sink.postIntent.bind(sink);
    sink.postInput = (slot, bits) => origInput(slot, spin && slot === lanceSlot ? AI_INPUT_TURN_LEFT : bits);
    sink.postIntent = (slot, fx, fy, torque, setAngvel) => {
      if (spin && slot === lanceSlot) origInput(slot, AI_INPUT_TURN_LEFT);
      else origIntent(slot, fx, fy, torque, setAngvel);
    };

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
    // From here the hull turns and the turrets train at their real rate;
    // then the kill. A capital takes seconds to spin up, so the test sets the
    // hull already turning at its full rate (left), and the held key keeps it.
    spin = true;
    r.testTraverseTicksCap = undefined;
    const maxTurn = kind.maxAngvel;
    const st = room._internals.wreckState(lanceId)!;
    room._internals.postToWorker({ type: 'SET_POSITION', entityId: lanceId, x: st.x, y: st.y, angle: st.angle, vx: st.vx, vy: st.vy, angvel: maxTurn });
    const d0 = Date.now() + 2_000;
    while (Date.now() < d0 && Math.abs(room._internals.wreckState(lanceId)?.angvel ?? 0) < 0.8 * maxTurn) await harness.advance(4);
    expect(Math.abs(room._internals.wreckState(lanceId)?.angvel ?? 0), 'the hull is turning').toBeGreaterThan(0.8 * maxTurn);
    for (const [, s] of room.state.ships) if (s.playerId === pid && s.isActive) s.health = beam.damage / 2;

    // Sample the killing turret's world bearing (hull + base + mount angle)
    // and the hull angle every few ms (each server tick).
    const worldByTick = new Map<number, number>();
    const hullByTick = new Map<number, number>();
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
        const t = room._internals.serverTick;
        const h = hullAngle();
        if (a !== undefined) {
          angleByTick.set(t, a);
          hullByTick.set(t, h);
          worldByTick.set(t, h + kind.mounts[i]!.baseAngle + a);
        }
        // The window is over: snap again so the resume shows in a few ticks.
        if (t >= killTick + follow) r.testTraverseTicksCap = 0;
        if (t > killTick + follow + 20) break;
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
    // The hull really turned through the window (else this proves nothing).
    let hMin = Infinity, hMax = -Infinity;
    for (const [t, h] of hullByTick) if (t > killTick && t < killTick + follow) { hMin = Math.min(hMin, h); hMax = Math.max(hMax, h); }
    expect(hMax - hMin, 'the hull turned during the follow-through').toBeGreaterThan(0.006);
    // ... down the same WORLD line: the beam doesn't turn with the hull.
    for (const s of window) {
      expect(Math.abs(wrapPi(s.dir - killShot.dir)), `beam on the kill line at kill+${s.tick - killTick}`).toBeLessThan(0.002);
    }
    for (const [t, w] of worldByTick) {
      if (t > killTick && t < killTick + follow) {
        expect(Math.abs(wrapPi(w - killShot.dir)), `turret world bearing at kill+${t - killTick}`).toBeLessThan(0.002);
      }
    }
    // Then it resumes: with no target left it trains home (snaps, traverse cap 0).
    let resumed = false;
    for (const [t, a] of angleByTick) if (t >= killTick + follow && Math.abs(wrapPi(a - killShot.mountAngle)) > 0.1) resumed = true;
    expect(resumed, 'the turret resumed normal targeting after the follow-through').toBe(true);
  });
});
