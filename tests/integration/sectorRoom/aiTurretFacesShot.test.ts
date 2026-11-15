/**
 * Turrets face their shots in a live AI fight (owner, watching the
 * 2026-11-14 clips `npc-dogfight` / `fleet-melee`: "The turrets also aren't
 * turning to shoot the direction they do").
 *
 * Repro: an interceptor (two turning wing turrets, AI pilot, `drones` side)
 * and a Robot Cube (`robots` side) meet; they fight on sight, no pilot
 * involved (the player watches from out of the fight). Before the fix the
 * interceptor's turrets were trained only on hostile PILOTS, so here they
 * stayed at rest (the snapshot never carried a turned angle) and the beams
 * left down resting barrels whenever the hull was within its 14° cone plus
 * the 30° wing arc of the robot: shots visibly off target, turrets not
 * turning.
 *
 * Asserts, per server-side beam: it left along the barrel (hull + base + the
 * slewed angle the snapshot sends), and that barrel bore on the robot; and on
 * the client side of the wire: the snapshot carried turned turret angles.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { wrapPi } from '../../../src/core/ai/WeaponMountController.js';
import { FC_MOUNT_FIRE_TOLERANCE } from '../../../src/core/combat/fireControlBearing.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import type { LaserFiredEvent } from '../../../src/shared-types/messages.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';

const angleOf = (x: number, y: number): number => Math.atan2(-x, y);

interface Pose { x: number; y: number; angle: number }
interface RoomInternals {
  aiFireResolver: { deps: { broadcast: (type: string, msg: LaserFiredEvent) => void } };
  mountTicker: { droneMountAngles: Map<string, Float32Array> };
  swarmEntitySnapshot: (id: string) => Pose | null;
  swarmRegistry: { get: (id: string) => { entityId: number } | undefined };
}

describe('SectorRoom integration — an AI pilot\'s turrets face its shots', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); });

  it('an interceptor fighting a robot trains its turrets and fires only down barrels that bear', { timeout: 40_000 }, async () => {
    harness = await bootSectorTestServer({
      sectorKey: null, droneCount: 0, asteroidConfig: [], testMode: true,
      defaultSpawnX: -1800, defaultSpawnY: -1800,
    });
    const client = await harness.connectAs(randomUUID());
    const room = harness.getServerRoom()!;
    const r = room as unknown as RoomInternals;
    // The robot sits off the interceptor's nose (inside its wing arc), close.
    expect(room._internals.spawnTestDrone('ti', 0, 0, 'interceptor')).toBe(true);
    expect(room._internals.spawnTestDrone('rb', 130, 220, 'robot-square')).toBe(true);
    const wireId = `swarm-${r.swarmRegistry.get('ti')!.entityId}`;
    const kind = getShipKind('interceptor');

    const shots: Array<{ mount: string; dir: number; barrel: number; toTarget: number }> = [];
    const deps = r.aiFireResolver.deps;
    const orig = deps.broadcast.bind(deps);
    deps.broadcast = (type, msg) => {
      if (type === 'laser_fired' && msg.shooterId === wireId) {
        // The snapshot accessor reuses one scratch pose: read each at once.
        const hullAngle = r.swarmEntitySnapshot('ti')!.angle;
        const i = kind.mounts.findIndex((m) => m.id === msg.mountId);
        const a = r.mountTicker.droneMountAngles.get('ti')?.[i] ?? 0;
        const barrel = hullAngle + kind.mounts[i]!.baseAngle + a;
        const tgt = r.swarmEntitySnapshot('rb');
        shots.push({
          mount: msg.mountId ?? '?',
          dir: angleOf(msg.toX - msg.fromX, msg.toY - msg.fromY),
          barrel,
          toTarget: tgt ? angleOf(tgt.x - msg.fromX, tgt.y - msg.fromY) : barrel,
        });
      }
      orig(type, msg);
    };

    let turnedOnWire = 0;
    client.onMessage('snapshot', (snap: SnapshotMessage) => {
      for (const d of snap.drones ?? []) {
        if (d.mountAngles?.some((v) => Math.abs(v) > 0.05)) turnedOnWire++;
      }
    });

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && shots.length < 12) await harness.advance(100);

    expect(shots.length, 'the interceptor fought the robot').toBeGreaterThan(0);
    for (const s of shots) {
      const alongBarrel = Math.abs(wrapPi(s.dir - s.barrel));
      expect(alongBarrel, `${s.mount} beam left ${alongBarrel.toFixed(3)} rad off its drawn barrel`).toBeLessThan(1e-3);
      // The barrel bore: within the pilot window of the lead (a beam has no
      // lead) plus the target's own size at this range.
      const offTarget = Math.abs(wrapPi(s.barrel - s.toTarget));
      expect(offTarget, `${s.mount} fired ${offTarget.toFixed(3)} rad off the robot`).toBeLessThan(FC_MOUNT_FIRE_TOLERANCE + 0.1);
    }
    expect(turnedOnWire, 'no snapshot ever carried a turned turret').toBeGreaterThan(0);
  });
});
