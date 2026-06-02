/**
 * Live-beam pose-source lock — laser detach/jitter regression
 * (diagnostic capture 2026-06-02T15-04-54Z-e628gi; weapons/energy/AI
 * overhaul playtest).
 *
 * Symptom (on-device, Interceptor twin beams): the continuous hitscan
 * beam visibly detaches from the hull and the far endpoint jitters,
 * worst while maneuvering or right after a network hiccup.
 *
 * Root cause: the beam is DRAWN from the rendered (mirror) pose
 * (`PixiRenderer` `applyMountOffset(localShip.x/y/angle)` +
 * `mirror.liveBeams[mount].dist`), but `updateLiveBeam` CAST the
 * `predWorld.hitscan` that produces `dist` from the raw PREDICTED pose
 * (`predWorld.getShipState`). The predicted pose lags the mirror pose by
 * the reconciler's lerp offset — small when settled, but up to ~45 u
 * during a correction (capture e628gi: predState↔mirror gap p95 8.5 u,
 * max 45 u, corr 0.87 with `lerping`). So `dist` belonged to a different
 * ray than the one drawn, and the endpoint popped frame-to-frame.
 *
 * The MUZZLE/origin was already hull-attached (locked by
 * `tests/e2e/laser-smoothness.spec.ts`, which asserts
 * `beam.from === ship + 20·forward`). That E2E does NOT catch this bug:
 * it (a) checks only the origin, not the dist's ray pose, and (b) uses
 * `?room=sector` (default single-mount ship, not the twin-beam hitscan
 * Interceptor). This deterministic seam-level lock fills both gaps.
 *
 * Why this layer (Invariant #13 — "test where the bug LIVES"): the
 * defect is the POSE `updateLiveBeam` casts the ray from. We instantiate
 * the real client + a real predWorld, set the mirror pose DIFFERENT from
 * the predWorld pose (the lerp-offset condition), spy on every
 * `predWorld.hitscan` call, and assert each beam ray originates from the
 * MIRROR pose — the one the renderer draws from. Same integration seam
 * as `ColyseusClient.mountAnglesPreservation.test.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { PhysicsWorld } from '../../core/physics/World.js';
import { applyMountOffset } from '../render/pixi/spriteBuilders.js';

interface MountLike {
  id: string;
  localX: number;
  localY: number;
  baseAngle: number;
  weaponId: string;
}

interface HitscanCall {
  fromX: number;
  fromY: number;
  fwdX: number;
  fwdY: number;
}

interface Internals {
  updateLiveBeam(): void;
  localShipMounts(): ReadonlyArray<MountLike>;
  predWorld:
    | (PhysicsWorld & { hitscan: (...a: number[] | (number | string)[]) => unknown })
    | null;
  reconciler: { lerpOffset: { x: number; y: number }; lerpAngleOffset: number } | null;
  mirror: {
    ships: Map<
      string,
      { x: number; y: number; vx: number; vy: number; angle: number; kind?: string; mountAngles?: number[] }
    >;
    liveBeams: Map<string, { dist: number; hitId?: string }>;
    localPlayerId: string | null;
  };
}
const asInternals = (c: ColyseusGameClient): Internals => c as unknown as Internals;

describe('live-beam ray is cast from the RENDERED (mirror) pose, not the predicted pose', () => {
  let client: ColyseusGameClient;
  let internals: Internals;
  const LOCAL_ID = 'player-1';

  // Predicted (predWorld) pose vs rendered (mirror) pose. The gap between
  // them is the reconciler lerp offset that detaches the beam.
  const PRED = { x: 0, y: 0, angle: 0 };
  const MIRROR = { x: 300, y: -200, angle: 0.7 };

  beforeEach(async () => {
    client = new ColyseusGameClient();
    internals = asInternals(client);
    internals.predWorld = (await PhysicsWorld.create()) as Internals['predWorld'];
    internals.predWorld!.spawnShip(LOCAL_ID, PRED.x, PRED.y, 'interceptor');
    internals.reconciler = { lerpOffset: { x: MIRROR.x - PRED.x, y: MIRROR.y - PRED.y }, lerpAngleOffset: MIRROR.angle - PRED.angle };
    internals.mirror.localPlayerId = LOCAL_ID;
    // The RENDERED pose the hull sprite + beam are drawn from.
    internals.mirror.ships.set(LOCAL_ID, {
      x: MIRROR.x, y: MIRROR.y, vx: 0, vy: 0, angle: MIRROR.angle, kind: 'interceptor',
    });
  });

  it('casts each twin-beam hitscan from the mirror-pose barrel, matching where the beam is drawn', () => {
    const mounts = internals.localShipMounts();
    expect(mounts.length, 'interceptor should resolve its twin wing mounts').toBe(2);

    // Spy on every hitscan call (one per mount), preserving order.
    const calls: HitscanCall[] = [];
    const real = internals.predWorld!.hitscan.bind(internals.predWorld);
    internals.predWorld!.hitscan = ((fromX: number, fromY: number, fwdX: number, fwdY: number, range: number, exclude: string) => {
      calls.push({ fromX, fromY, fwdX, fwdY });
      return real(fromX, fromY, fwdX, fwdY, range, exclude);
    }) as Internals['predWorld']['hitscan'];

    internals.updateLiveBeam();

    expect(calls.length, 'one hitscan per twin-beam mount').toBe(2);

    for (let i = 0; i < mounts.length; i++) {
      const mount = mounts[i]!;
      // Expected ray IF cast from the rendered (mirror) pose — exactly what
      // the renderer draws (PixiRenderer.ts:1059-1064).
      const origin = applyMountOffset(MIRROR.x, MIRROR.y, MIRROR.angle, mount);
      const fireAngle = MIRROR.angle + mount.baseAngle; // mountAngles undefined → baseAngle only
      const fwdX = -Math.sin(fireAngle);
      const fwdY = Math.cos(fireAngle);
      const expFromX = origin.x + fwdX * 20;
      const expFromY = origin.y + fwdY * 20;

      // What it WOULD be from the predicted pose (the bug) — for a clear msg.
      const predOrigin = applyMountOffset(PRED.x, PRED.y, PRED.angle, mount);

      const got = calls[i]!;
      const msg = [
        `Mount ${mount.id}: beam hitscan cast from the PREDICTED pose, not the rendered/mirror pose.`,
        `  got from   = (${got.fromX.toFixed(2)}, ${got.fromY.toFixed(2)})`,
        `  mirror exp = (${expFromX.toFixed(2)}, ${expFromY.toFixed(2)})  <- where the beam is DRAWN`,
        `  pred  pose = (${predOrigin.x.toFixed(2)}, ${predOrigin.y.toFixed(2)})  <- the lagging source`,
        `Fix: updateLiveBeam must derive origin+direction from mirror.ships.get(localId), not predWorld.getShipState.`,
      ].join('\n');

      expect(got.fromX, msg).toBeCloseTo(expFromX, 5);
      expect(got.fromY, msg).toBeCloseTo(expFromY, 5);
      expect(got.fwdX, msg).toBeCloseTo(fwdX, 5);
      expect(got.fwdY, msg).toBeCloseTo(fwdY, 5);
    }
  });
});
