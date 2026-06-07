/**
 * Turret-aim pose-source lock — laser detach/jitter SECONDARY cause
 * (on-device smoke follow-up handoff 2026-06-06, Issue 1 Bug #2;
 * companion to the already-landed `ColyseusClient.liveBeamPose.test.ts`).
 *
 * Symptom (on-device, Interceptor twin beams locked onto a hostile while
 * turning): the beam direction lags the hull — it points at where the
 * ship *was predicted*, snapping to the drawn pose only after the
 * reconciler lerp settles.
 *
 * Root cause: `tickLocalMountAim` computes the per-mount turret angle
 * (`pickTarget` + `tickLocalMountAngles`) from the PREDICTED pose
 * (`predWorld.getShipState(localId)` → `state.x/y/angle`), but the beam
 * is DRAWN from the RENDERED (mirror) pose (`mirror.ships.get(localId)` →
 * `ship.x/y/angle`, locked by `liveBeamPose.test.ts`). The reconciler
 * lerp angle offset (up to ~0.5 rad mid-turn) leaks into the turret
 * bearing, so the mount aims for a different ship orientation than the
 * one the barrel is rendered at.
 *
 * Why this layer (Invariant #13 — "test where the bug LIVES"): the defect
 * is the POSE `tickLocalMountAim` derives the mount bearing from. We
 * instantiate the real client + a real predWorld, set the mirror angle
 * DIFFERENT from the predWorld angle (the mid-turn lerp-offset condition),
 * place one hostile drone, run the aim tick with a large `dtSec` so the
 * slew saturates to the clamped desired bearing, and assert each active
 * mount's resulting angle matches the MIRROR-pose computation — the pose
 * the beam is drawn from — NOT the predicted pose. Same integration seam
 * as `ColyseusClient.liveBeamPose.test.ts`.
 *
 * The fix is in the CALLER (`tickLocalMountAim`): pass mirror
 * `ship.x/y/angle` to `pickTarget` + `tickLocalMountAngles` instead of the
 * predicted `state.*`. The pure helper `combat/localMountAim.ts` is
 * unchanged.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { PhysicsWorld } from '../../core/physics/World.js';
import { getShipKind, type WeaponMount } from '@shared-types/shipKinds';
import { wrapPi, clampToArc } from '@core/ai/WeaponMountController';
import type { SwarmRenderState } from '@core/contracts/IRenderer';

interface Internals {
  tickLocalMountAim(dtSec: number): void;
  predWorld: PhysicsWorld | null;
  mirror: {
    ships: Map<
      string,
      { x: number; y: number; vx: number; vy: number; angle: number; kind?: string; mountAngles?: number[] }
    >;
    swarm: Map<number, SwarmRenderState>;
    localPlayerId: string | null;
  };
}
const asInternals = (c: ColyseusGameClient): Internals => c as unknown as Internals;

/** Mirror the production aim maths (`combat/localMountAim.ts`) for a given
 *  ship pose, returning the per-mount angle after a saturated slew (clamped
 *  desired bearing). Used to compute BOTH the mirror-pose expectation and
 *  the pred-pose value the bug would produce. */
function expectedMountAngle(
  mount: WeaponMount,
  shipX: number,
  shipY: number,
  shipAngle: number,
  targetX: number,
  targetY: number,
): number {
  const cosA = Math.cos(shipAngle);
  const sinA = Math.sin(shipAngle);
  const mountWorldX = shipX + (mount.localX * cosA - mount.localY * sinA);
  const mountWorldY = shipY + (mount.localX * sinA + mount.localY * cosA);
  const worldBearing = Math.atan2(-(targetX - mountWorldX), targetY - mountWorldY);
  const desired = wrapPi(worldBearing - shipAngle - mount.baseAngle);
  return clampToArc(desired, mount);
}

describe('local turret aim is computed from the RENDERED (mirror) pose, not the predicted pose', () => {
  let client: ColyseusGameClient;
  let internals: Internals;
  const LOCAL_ID = 'player-1';

  // Predicted (predWorld) pose vs rendered (mirror) pose. They share a
  // position here so the divergence is a pure ANGLE offset — the dominant
  // mid-turn reconciler-lerp case the handoff describes (~0.3 rad).
  const PRED = { x: 0, y: 0, angle: 0 };
  const MIRROR = { x: 0, y: 0, angle: 0.3 };
  // One hostile drone, dead ahead of the angle-0 ship (forward = +y) and
  // well within HITSCAN_RANGE (250). Within the ±30° wing arc from both
  // poses, so the bug shows as a wrong (but unclamped) bearing, not a clamp.
  const DRONE = { x: 0, y: 150 };

  beforeEach(async () => {
    client = new ColyseusGameClient();
    internals = asInternals(client);
    internals.predWorld = await PhysicsWorld.create();
    // PredWorld body sits at the PRED pose (angle 0).
    internals.predWorld.spawnShip(LOCAL_ID, PRED.x, PRED.y, 'interceptor');
    internals.mirror.localPlayerId = LOCAL_ID;
    // The RENDERED pose the hull + beam are drawn from — angle 0.3.
    internals.mirror.ships.set(LOCAL_ID, {
      x: MIRROR.x, y: MIRROR.y, vx: 0, vy: 0, angle: MIRROR.angle, kind: 'interceptor',
    });
    // One hostile drone (kind 1) at a fixed pose.
    internals.mirror.swarm = new Map();
    internals.mirror.swarm.set(1, {
      kind: 1, x: DRONE.x, y: DRONE.y, vx: 0, vy: 0, angle: 0,
      radius: 8, isHostileToLocal: true,
    } as unknown as SwarmRenderState);
  });

  it('slews each active wing mount toward the target as seen from the mirror pose', () => {
    // Large dtSec → the slew saturates to the clamped desired bearing, so
    // the resulting mount angle == the pose-derived desired (independent of
    // the per-tick rotation-speed limit).
    internals.tickLocalMountAim(1000);

    const mounts = getShipKind('interceptor').mounts ?? [];
    expect(mounts.length, 'interceptor has its twin wing mounts').toBe(2);

    const angles = internals.mirror.ships.get(LOCAL_ID)!.mountAngles;
    expect(angles, 'tickLocalMountAim writes catalogue-indexed mountAngles').toBeDefined();

    for (let i = 0; i < mounts.length; i++) {
      const mount = mounts[i]!;
      const expMirror = expectedMountAngle(mount, MIRROR.x, MIRROR.y, MIRROR.angle, DRONE.x, DRONE.y);
      const expPred = expectedMountAngle(mount, PRED.x, PRED.y, PRED.angle, DRONE.x, DRONE.y);

      // Sanity: the two poses genuinely disagree (else the test proves nothing).
      expect(
        Math.abs(expMirror - expPred),
        `pose divergence must be observable for mount ${mount.id}`,
      ).toBeGreaterThan(0.1);

      const got = angles![i]!;
      const msg = [
        `Mount ${mount.id}: turret aim computed from the PREDICTED pose, not the rendered/mirror pose.`,
        `  got        = ${got.toFixed(4)}`,
        `  mirror exp = ${expMirror.toFixed(4)}  <- the pose the beam is DRAWN from`,
        `  pred  exp  = ${expPred.toFixed(4)}  <- the lagging predicted pose (the bug)`,
        `Fix: tickLocalMountAim must pass mirror ship.x/y/angle to pickTarget + tickLocalMountAngles.`,
      ].join('\n');

      expect(got, msg).toBeCloseTo(expMirror, 4);
    }
  });
});
