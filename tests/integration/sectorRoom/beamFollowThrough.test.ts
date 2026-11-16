/**
 * Heavy-beam follow-through (owner, game feel: "the beam should not turn
 * after the kill and show for half a second or one second through the clean
 * cut"). When a heavy-beam turret's shot KILLS its target, that turret aims
 * from its live pivot at the KILL POINT (where the killing beam hit) and
 * keeps firing at its own cadence through it for the weapon's
 * `followThroughTicks`, so the beam burns on through the slice; then it
 * resumes normal targeting. Turning in place barely moves the pivot, so the
 * beam stays on the kill's world line (first test); a hull drifting sideways
 * pivots it slightly, but every pulse still crosses the kill point (second).
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
 *
 * Full length (owner: "its full length is cut short by the ship it's hitting
 * and once it's destroyed it returns to its full length for 0.75 s ... to
 * show it's cut right through"): a follow-through beam passes debris (the
 * victim's wreck pieces, scrap), so on an empty line it ends at the weapon's
 * full range, and no wreck piece takes damage from it.
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
  aiFireResolver: { deps: {
    broadcast: (type: string, msg: LaserFiredEvent) => void;
    applyDamage: (targetId: string, shooterId: string, ...rest: unknown[]) => boolean | void;
  } };
  mountTicker: { droneMountAngles: Map<string, Float32Array> };
  swarmRegistry: {
    all: () => Iterable<{ id: string; entityId: number; slot: number; kind: number; radius: number; shipKind?: string | null }>;
    get: (id: string) => { kind: number } | undefined;
  };
  aiController: { sink: IntentSink };
  testTraverseTicksCap: number | undefined;
}

interface Shot { tick: number; mountId: string; fromX: number; fromY: number; dir: number; len: number; mountAngle: number; targetId?: string }

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
          tick: room._internals.serverTick, mountId: msg.mountId, fromX: msg.fromX, fromY: msg.fromY,
          dir: angleOf(msg.toX - msg.fromX, msg.toY - msg.fromY),
          len: Math.hypot(msg.toX - msg.fromX, msg.toY - msg.fromY),
          mountAngle: r.mountTicker.droneMountAngles.get(lanceId)?.[i] ?? NaN,
          targetId: msg.targetId,
        });
      }
      orig(type, msg);
    };
    // Every lance beam hit on a wreck piece (swarm kind 4), by tick.
    const wreckHitTicks: number[] = [];
    const origDamage = deps.applyDamage.bind(deps);
    deps.applyDamage = (targetId, shooterId, ...rest) => {
      if (shooterId === lanceId && r.swarmRegistry.get(targetId)?.kind === 4) wreckHitTicks.push(room._internals.serverTick);
      return origDamage(targetId, shooterId, ...rest);
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
      if (killMount === '' && !pilotAlive && last !== undefined) {
        killTick = last.tick; killMount = last.mountId;
        // A piece of the victim drifts across the cut: the largest wreck piece
        // is set at rest on the kill line, past where the victim was.
        let piece: { id: string; radius: number } | undefined;
        for (const rec of r.swarmRegistry.all()) if (rec.kind === 4 && (piece === undefined || rec.radius > piece.radius)) piece = rec;
        expect(piece, 'the kill left wreck pieces').toBeDefined();
        const along = last.len + 2_500;
        const ux = -Math.sin(last.dir), uy = Math.cos(last.dir);
        room._internals.postToWorker({
          type: 'SET_POSITION', entityId: piece!.id, x: last.fromX + ux * along, y: last.fromY + uy * along,
          angle: 0, vx: 0, vy: 0, angvel: 0,
        });
      }
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
    // The punch-through coincides with the death (owner, on film: the ship
    // died ~9 frames before the beam ran full length, because the killing
    // pulse ended at the hull and the first follow-through waited a reload):
    // a full-length beam down the kill line within 2 ticks of the kill.
    const punch = window[0];
    expect(punch, 'a follow-through beam fired').toBeDefined();
    expect(punch!.tick - killTick, 'the first full-length beam follows the kill within 2 ticks').toBeLessThanOrEqual(2);
    expect(punch!.len, 'the punch-through beam runs its full length').toBeGreaterThan(beam.range - 1);
    expect(Math.abs(wrapPi(punch!.dir - killShot.dir)), 'the punch-through beam is on the kill line').toBeLessThan(0.002);
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
    // ... at full length: it passes the victim's wreck (no piece takes a hit)
    // and nothing else is on the line, so each beam runs to the weapon's range.
    expect(beam.falloff, 'heavy beam: range is its full reach').toBeUndefined();
    for (const s of window) {
      expect(s.targetId, `follow-through beam at kill+${s.tick - killTick} hit nothing`).toBeUndefined();
      expect(s.len, `follow-through beam at kill+${s.tick - killTick} runs its full length`).toBeGreaterThan(beam.range - 1);
    }
    expect(wreckHitTicks.filter((t) => t > killTick && t < killTick + follow), 'no wreck piece took a follow-through beam')
      .toEqual([]);
    // Then it resumes: with no target left it trains home (snaps, traverse cap 0).
    let resumed = false;
    for (const [t, a] of angleByTick) if (t >= killTick + follow && Math.abs(wrapPi(a - killShot.mountAngle)) > 0.1) resumed = true;
    expect(resumed, 'the turret resumed normal targeting after the follow-through').toBe(true);
  });

  // Owner ("stay on the kill spot"): the firing capital keeps moving through
  // the window, so a held world BEARING slid the beam sideways off where the
  // ship died (filmed ~30 px at fight zoom in 0.5 s). The turret aims every
  // tick from its live pivot at the kill point, so each follow-through pulse
  // still passes through it.
  it('every follow-through beam passes through the kill point while the capital drifts sideways', { timeout: 15_000 }, async () => {
    const beam = getWeapon('heavy_beam');
    const follow = beam.followThroughTicks ?? 0;
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
    let lanceId = '', wireId = '', lanceSlot = -1;
    for (const rec of r.swarmRegistry.all()) {
      if (rec.shipKind === 'battlecruiser-lance') { lanceId = rec.id; wireId = `swarm-${rec.entityId}`; lanceSlot = rec.slot; }
    }
    expect(lanceId).not.toBe('');
    // Once `drift` is set the lance's AI pilot keys go dead (no thrust, no
    // turn), so the hull coasts on the sideways velocity the test gives it.
    let drift = false;
    const sink = r.aiController.sink;
    const origInput = sink.postInput!.bind(sink);
    const origIntent = sink.postIntent.bind(sink);
    sink.postInput = (slot, bits) => origInput(slot, drift && slot === lanceSlot ? 0 : bits);
    sink.postIntent = (slot, fx, fy, torque, setAngvel) => {
      if (drift && slot === lanceSlot) origInput(slot, 0);
      else origIntent(slot, fx, fy, torque, setAngvel);
    };
    const shots: (Shot & { toX: number; toY: number })[] = [];
    const deps = r.aiFireResolver.deps;
    const orig = deps.broadcast.bind(deps);
    deps.broadcast = (type, msg) => {
      if (type === 'laser_fired' && msg.shooterId === wireId && msg.mountId && beamMounts.has(msg.mountId)) {
        shots.push({
          tick: room._internals.serverTick, mountId: msg.mountId, fromX: msg.fromX, fromY: msg.fromY,
          dir: angleOf(msg.toX - msg.fromX, msg.toY - msg.fromY),
          len: Math.hypot(msg.toX - msg.fromX, msg.toY - msg.fromY),
          mountAngle: NaN, targetId: msg.targetId, toX: msg.toX, toY: msg.toY,
        });
      }
      orig(type, msg);
    };
    const d1 = Date.now() + 8_000;
    while (Date.now() < d1 && !shots.some((s) => s.targetId === pid)) await harness.advance(20);
    const first = shots.filter((s) => s.targetId === pid).pop();
    expect(first, 'a heavy beam hit the pilot').toBeDefined();
    // Sideways to the beam at 200 u/s, hull still; turrets at their real rate.
    drift = true;
    r.testTraverseTicksCap = undefined;
    const SIDE = 200;
    const st = room._internals.wreckState(lanceId)!;
    room._internals.postToWorker({
      type: 'SET_POSITION', entityId: lanceId, x: st.x, y: st.y, angle: st.angle,
      vx: Math.cos(first!.dir) * SIDE, vy: Math.sin(first!.dir) * SIDE, angvel: 0,
    });
    await harness.advance(40);
    for (const [, s] of room.state.ships) if (s.playerId === pid && s.isActive) s.health = beam.damage / 2;
    let killTick = -1, killMount = '', killX = 0, killY = 0, startX = 0, startY = 0;
    const d2 = Date.now() + 8_000;
    while (Date.now() < d2) {
      const last = shots.filter((s) => s.targetId === pid).pop();
      const pilotAlive = [...room.state.ships.values()].some((s) => s.playerId === pid && s.isActive && s.alive);
      if (killMount === '' && !pilotAlive && last !== undefined) {
        killTick = last.tick; killMount = last.mountId; killX = last.toX; killY = last.toY;
        const p = room._internals.wreckState(lanceId)!;
        startX = p.x; startY = p.y;
      }
      if (killMount !== '' && room._internals.serverTick > killTick + follow) break;
      await harness.advance(4);
    }
    expect(killTick, 'a heavy beam killed the pilot').toBeGreaterThan(0);
    const end = room._internals.wreckState(lanceId)!;
    expect(Math.hypot(end.x - startX, end.y - startY), 'the capital moved during the follow-through').toBeGreaterThan(60);
    const window = shots.filter((s) => s.mountId === killMount && s.tick > killTick && s.tick < killTick + follow);
    expect(window.length, 'the killing turret kept firing through the follow-through')
      .toBeGreaterThanOrEqual(Math.floor((follow - 1) / beam.cooldownTicks) - 1);
    // Each pulse's line (from its muzzle along its direction) passes the kill
    // point: the perpendicular miss, with the point ahead of the muzzle.
    let worst = 0;
    for (const s of window) {
      const ux = -Math.sin(s.dir), uy = Math.cos(s.dir);
      const px = killX - s.fromX, py = killY - s.fromY;
      expect(px * ux + py * uy, `kill point ahead of the muzzle at kill+${s.tick - killTick}`).toBeGreaterThan(0);
      worst = Math.max(worst, Math.abs(px * uy - py * ux));
    }
    expect(worst, 'worst follow-through miss of the kill point (u)').toBeLessThan(2);
  });
});
