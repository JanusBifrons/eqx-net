/**
 * Turret-aim pose-source lock — laser detach SECONDARY cause (Invariant #13).
 *
 * Sibling of `ColyseusClient.liveBeamPose.test.ts` (which locks the beam ORIGIN
 * pose, already fixed on main). THIS locks the turret AIM pose.
 *
 * Symptom (on-device, Interceptor twin beams, locked target while turning): the
 * beam direction lags/leads where it's drawn — the mount aims a hair off the
 * target, worst mid-correction.
 *
 * Root cause: `tickLocalMountAim` derives the aim from the PREDICTED pose
 * (`predWorld.getShipState` → `state.x/y/angle`), feeding it to BOTH `pickTarget`
 * (4336) and `tickLocalMountAngles` (4352-4355). But the beam + turret are DRAWN
 * from the MIRROR pose (`updateLiveBeam` / the renderer read `mirror.ships`). The
 * reconciler lerp offset between the two poses leaks straight into the aimed
 * mount angle. Fix: aim from the mirror `ship.x/y/angle` (the SAME source the
 * beam origin already uses post the prior fix). The pure helpers
 * (`tickLocalMountAngles`, `pickTarget`) are correct — the bug is the CALLER's
 * pose; this is a caller-only fix.
 *
 * Why this layer (Invariant #13 — test where the bug LIVES): the defect is which
 * POSE the aim is computed from. We instantiate the real client + a real predWorld,
 * set the mirror pose DIFFERENT from the predWorld pose (the lerp-offset condition),
 * place ONE hostile drone, slew the mount to convergence, then assert the converged
 * mount — drawn at the MIRROR pose — points AT the target. With the bug the mount
 * aims from the predicted position, so drawn at the mirror position it is off by the
 * parallax (~0.30 rad here). Same integration seam as `liveBeamPose.test.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { PhysicsWorld } from '../../core/physics/World.js';
import { applyMountOffset } from '../render/pixi/spriteBuilders.js';
import { getShipKind, type WeaponMount } from '@shared-types/shipKinds';

interface ShipEntry {
  x: number; y: number; vx: number; vy: number; angle: number;
  kind?: string; mountAngles?: number[];
}
interface SwarmEntry {
  kind: number; x: number; y: number; vx: number; vy: number; angle: number;
  isHostileToLocal?: boolean; healthFrac?: number;
}
interface Internals {
  tickLocalMountAim(dtSec: number): void;
  localShipMounts(): ReadonlyArray<WeaponMount>;
  predWorld: PhysicsWorld | null;
  mirror: {
    ships: Map<string, ShipEntry>;
    swarm: Map<number, SwarmEntry>;
    localPlayerId: string | null;
  };
}
const asInternals = (c: ColyseusGameClient): Internals => c as unknown as Internals;

describe('turret aim is computed from the RENDERED (mirror) pose, not the predicted pose', () => {
  let client: ColyseusGameClient;
  let internals: Internals;
  const LOCAL_ID = 'player-1';

  // Predicted (predWorld) pose vs rendered (mirror) pose. Same angle so the
  // error is pure POSITION parallax: a 30 u x-offset against a target 100 u
  // "north" gives ~0.30 rad of bearing difference (≈ the on-device 0.306 rad),
  // and BOTH bearings sit inside the wing mounts' ±30° (±0.5236 rad) arc so
  // neither clamps — the buggy + correct angles are distinct, not both pinned.
  const PRED = { x: 0, y: 0, angle: 0 };
  const MIRROR = { x: 30, y: 0, angle: 0 };
  const TARGET = { x: 15, y: 100 };

  beforeEach(async () => {
    client = new ColyseusGameClient();
    internals = asInternals(client);
    internals.predWorld = await PhysicsWorld.create();
    internals.predWorld.spawnShip(LOCAL_ID, PRED.x, PRED.y, 'interceptor');
    internals.mirror.localPlayerId = LOCAL_ID;
    // RENDERED pose — where the hull + beam + turrets are drawn.
    internals.mirror.ships.set(LOCAL_ID, {
      x: MIRROR.x, y: MIRROR.y, vx: 0, vy: 0, angle: MIRROR.angle, kind: 'interceptor',
    });
    // One hostile drone the turret should track.
    internals.mirror.swarm = new Map<number, SwarmEntry>([
      [1, { kind: 1, x: TARGET.x, y: TARGET.y, vx: 0, vy: 0, angle: 0, isHostileToLocal: true, healthFrac: 1 }],
    ]);
  });

  it('slews each wing mount to point at the target FROM the mirror pose (not the predicted pose)', () => {
    const mounts = getShipKind('interceptor').mounts ?? [];
    expect(mounts.length, 'interceptor should have twin wing mounts').toBe(2);

    // Slew to convergence: 4 rad/s × 0.1 s × 40 ticks ≫ the ~0.2 rad target.
    for (let t = 0; t < 40; t++) internals.tickLocalMountAim(0.1);

    const angles = internals.mirror.ships.get(LOCAL_ID)!.mountAngles;
    expect(angles, 'tickLocalMountAim must write per-mount angles').toBeTruthy();

    for (let i = 0; i < mounts.length; i++) {
      const mount = mounts[i]!;
      // Where this mount is DRAWN, and where it POINTS, at the mirror pose.
      const mw = applyMountOffset(MIRROR.x, MIRROR.y, MIRROR.angle, mount);
      const abs = MIRROR.angle + mount.baseAngle + (angles![i] ?? 0);
      const fwdX = -Math.sin(abs);
      const fwdY = Math.cos(abs);
      // Direction the mount SHOULD point: straight at the target from where the
      // mount is drawn.
      const dx = TARGET.x - mw.x;
      const dy = TARGET.y - mw.y;
      const dlen = Math.hypot(dx, dy);
      const desX = dx / dlen;
      const desY = dy / dlen;
      const dot = Math.max(-1, Math.min(1, fwdX * desX + fwdY * desY));
      const aimErr = Math.acos(dot);

      // For a clear failure message, what the angle WOULD aim at if it pointed
      // at the target from the PREDICTED mount position (the bug's source).
      const pw = applyMountOffset(PRED.x, PRED.y, PRED.angle, mount);

      const msg = [
        `Mount ${mount.id}: aimed ${aimErr.toFixed(3)} rad off the target as DRAWN (mirror pose).`,
        `  mount drawn at  = (${mw.x.toFixed(1)}, ${mw.y.toFixed(1)})  [mirror]`,
        `  mount pred at    = (${pw.x.toFixed(1)}, ${pw.y.toFixed(1)})  [the lagging source]`,
        `  target          = (${TARGET.x}, ${TARGET.y})`,
        `Fix: tickLocalMountAim must pass mirror ship.x/y/angle to pickTarget + tickLocalMountAngles.`,
      ].join('\n');

      expect(aimErr, msg).toBeLessThan(0.05);
    }
  });
});
