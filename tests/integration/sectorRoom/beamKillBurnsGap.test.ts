/**
 * A heavy-beam kill burns a gap the beam's width (owner: "it burns a perfect
 * hole like a lightsaber directly through ... so it should shine out the
 * other side"; "the gap is exactly the width of the laser ... 2 or 3 pixels
 * wider ... just to give it a very tiny buffer"; "a very slight force
 * pushing those parts apart"; "without any sort of hack or visual trick").
 *
 * Happy path: both capitals stationary. A lance battlecruiser's heavy beam
 * kills a pilot heavy cruiser; the fracture erases a strip of hull the
 * beam's full width plus `beamCutBuffer` centred on the beam's own line, and
 * the pieces part from it. The killing turret's next pulses fire down the
 * same line (its kill follow-through aim) and are ordinary shots: no
 * exception lets them pass debris, yet nothing is in the gap, so each one
 * runs its full range and no wreck piece is hit.
 *
 * Worker step (found under host load, 1 run in 2 with other integration
 * files sharing the host): the physics worker steps the SAB on its own
 * thread, so it can move the firing hull between the moment its turret
 * ticker aims (reading the hull's pose) and the moment the shot's ray is
 * cast. A shot cast from the newer pose left the aimed line (a turning
 * lance: one tick of turn, ~1.5 u off the kill point at 4.6 km, past the
 * gap's buffer) and stopped on a wreck piece. The second test makes that
 * step happen on every follow-through pulse; the beam must still run down
 * the line it was aimed along.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { LaserFiredEvent } from '../../../src/shared-types/messages.js';
import { getWeapon } from '../../../src/core/combat/WeaponCatalogue.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { wrapPi } from '../../../src/core/ai/WeaponMountController.js';
import { SLOT_ANGLE_OFF, slotBase } from '../../../src/shared-types/sabLayout.js';

interface IntentSink {
  postIntent: (slot: number, fx: number, fy: number, torque: number, setAngvel?: number) => void;
  postInput?: (slot: number, bits: number) => void;
}
interface RoomInternals {
  aiFireResolver: { deps: {
    broadcast: (type: string, msg: LaserFiredEvent) => void;
    applyDamage: (targetId: string, shooterId: string, ...rest: unknown[]) => boolean | void;
  } };
  swarmRegistry: {
    all: () => Iterable<{ id: string; entityId: number; slot: number; kind: number; radius: number; shipKind?: string | null }>;
    get: (id: string) => { kind: number } | undefined;
  };
  aiController: { sink: IntentSink };
  mountTicker: { deps: { fireDroneMount?: (droneId: string, mountIdx: number, ...rest: unknown[]) => boolean | 'killed' | void } };
  sabF32: Float32Array;
}

interface Shot { tick: number; mountId: string; dir: number; len: number; targetId?: string }

const angleOf = (x: number, y: number): number => Math.atan2(-x, y);

describe('SectorRoom integration — a heavy-beam kill burns a gap the beam shines through', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 10_000);

  /** `stepRad` ≠ 0: the worker "steps" the lance's hull this far round
   *  between each follow-through pulse's aim and its shot (its SAB angle,
   *  restored right after the shot). */
  async function stationaryKill(stepRad: number): Promise<void> {
    const beam = getWeapon('heavy_beam');
    const follow = beam.followThroughTicks ?? 0;
    expect(follow).toBeGreaterThan(0);
    const kind = getShipKind('battlecruiser-lance');
    const beamMounts = new Set(kind.mounts.filter((m) => m.weaponId === 'heavy_beam').map((m) => m.id));
    harness = await bootSectorTestServer({
      sectorKey: null, droneCount: 0, testMode: true, asteroidConfig: [], capitalWrecks: true,
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
    // Once `hold` is set the lance's AI pilot keys go dead: it sits still.
    let hold = false;
    const sink = r.aiController.sink;
    const origInput = sink.postInput!.bind(sink);
    const origIntent = sink.postIntent.bind(sink);
    sink.postInput = (slot, bits) => origInput(slot, hold && slot === lanceSlot ? 0 : bits);
    sink.postIntent = (slot, fx, fy, torque, setAngvel) => {
      if (hold && slot === lanceSlot) origInput(slot, 0);
      else origIntent(slot, fx, fy, torque, setAngvel);
    };
    const shots: Shot[] = [];
    const deps = r.aiFireResolver.deps;
    const orig = deps.broadcast.bind(deps);
    deps.broadcast = (type, msg) => {
      if (type === 'laser_fired' && msg.shooterId === wireId && msg.mountId && beamMounts.has(msg.mountId)) {
        shots.push({
          tick: room._internals.serverTick, mountId: msg.mountId,
          dir: angleOf(msg.toX - msg.fromX, msg.toY - msg.fromY),
          len: Math.hypot(msg.toX - msg.fromX, msg.toY - msg.fromY), targetId: msg.targetId,
        });
      }
      orig(type, msg);
    };
    if (stepRad !== 0) {
      const td = r.mountTicker.deps;
      const origFire = td.fireDroneMount!.bind(td);
      td.fireDroneMount = (droneId, mountIdx, ...rest) => {
        // A follow-through pulse has no target (rest[0]).
        if (!hold || droneId !== lanceId || rest[0] !== undefined) return origFire(droneId, mountIdx, ...rest);
        const a = slotBase(lanceSlot) + SLOT_ANGLE_OFF;
        const before = r.sabF32[a]!;
        r.sabF32[a] = before + stepRad;
        try { return origFire(droneId, mountIdx, ...rest); } finally { r.sabF32[a] = before; }
      };
    }
    const wreckHitTicks: number[] = [];
    const origDamage = deps.applyDamage.bind(deps);
    deps.applyDamage = (targetId, shooterId, ...rest) => {
      if (shooterId === lanceId && r.swarmRegistry.get(targetId)?.kind === 4) wreckHitTicks.push(room._internals.serverTick);
      return origDamage(targetId, shooterId, ...rest);
    };

    const d1 = Date.now() + 8_000;
    while (Date.now() < d1 && !shots.some((s) => s.targetId === pid)) await harness.advance(20);
    expect(shots.some((s) => s.targetId === pid), 'a heavy beam hit the pilot').toBe(true);
    // Both ships at rest; then the pilot is left one beam's worth of hull.
    hold = true;
    const st = room._internals.wreckState(lanceId)!;
    room._internals.postToWorker({ type: 'SET_POSITION', entityId: lanceId, x: st.x, y: st.y, angle: st.angle, vx: 0, vy: 0, angvel: 0 });
    await harness.advance(20);
    for (const [, s] of room.state.ships) if (s.playerId === pid && s.isActive) s.health = beam.damage / 2;

    let killTick = -1, killMount = '';
    const d2 = Date.now() + 8_000;
    while (Date.now() < d2) {
      const last = shots.filter((s) => s.targetId === pid).pop();
      const pilotAlive = [...room.state.ships.values()].some((s) => s.playerId === pid && s.isActive && s.alive);
      if (killMount === '' && !pilotAlive && last !== undefined) { killTick = last.tick; killMount = last.mountId; }
      if (killMount !== '' && room._internals.serverTick > killTick + follow) break;
      await harness.advance(4);
    }
    expect(killTick, 'a heavy beam killed the pilot').toBeGreaterThan(0);
    let pieces = 0;
    for (const rec of r.swarmRegistry.all()) if (rec.kind === 4) pieces++;
    expect(pieces, 'the kill left wreck pieces (not vaporised)').toBeGreaterThan(1);

    const killShot = shots.filter((s) => s.mountId === killMount && s.tick === killTick).pop()!;
    const window = shots.filter((s) => s.mountId === killMount && s.tick > killTick && s.tick < killTick + follow);
    expect(window.length, 'the killing turret fired on down the kill line')
      .toBeGreaterThanOrEqual(Math.floor((follow - 1) / beam.cooldownTicks) - 1);
    for (const s of window) {
      const at = `kill+${s.tick - killTick}`;
      expect(Math.abs(wrapPi(s.dir - killShot.dir)), `beam on the kill line at ${at}`).toBeLessThan(0.002);
      expect(s.targetId, `beam at ${at} hit nothing: the gap is clear`).toBeUndefined();
      expect(s.len, `beam at ${at} shines out the other side at full length`).toBeGreaterThan(beam.range - 1);
    }
    expect(wreckHitTicks.filter((t) => t > killTick && t < killTick + follow), 'no wreck piece took a beam').toEqual([]);
  }

  it('both ships stationary: the pulses after the kill pass through the wreck at full length', { timeout: 15_000 }, async () => {
    await stationaryKill(0);
  });

  // 1 mrad: ~4.6 u at the kill point, 3x the gap's buffer each side.
  it('a worker step between a pulse\'s aim and its shot: the beam still runs down the aimed line, through the gap', { timeout: 15_000 }, async () => {
    await stationaryKill(0.001);
  });
});
