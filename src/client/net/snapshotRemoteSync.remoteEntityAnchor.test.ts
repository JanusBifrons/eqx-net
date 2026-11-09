/**
 * The remote-entity anchor (2026-11-08, one paradigm for every remote moving
 * entity). `preResetRemoteShips` resets remote PLAYER ships to their snapshot
 * state AND, in the same step, drones + scrap to their latest authoritative
 * binary-wire state at the snapshot's serverTick. The replay and tickPhysics
 * then carry all of them on the prediction timeline.
 *
 * Locks:
 *   - drones/scrap are anchored from the pose RING (server state), never from
 *     the display-delayed `entry.x/y` that updateMirror overwrites;
 *   - the ring pose is carried to the anchor tick when the wire cadence
 *     doesn't land on it;
 *   - asteroids and structures are untouched (their own handling);
 *   - remote player ships behave exactly as before (regression lock): same
 *     state with and without the swarm half switched on.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier2d-compat';
import { PhysicsWorld } from '../../core/physics/World.js';
import type { RenderMirror, SwarmRenderState, PoseRingEntry } from '../../core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../core/contracts/IRenderer.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';
import {
  preResetRemoteShips,
  anchorRemoteSwarmBodies,
  authoritativeSwarmStateAt,
  type PreResetRemoteCtx,
} from './snapshotRemoteSync.js';

beforeAll(async () => {
  await RAPIER.init();
});

function ring(): PoseRingEntry[] {
  const r: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) {
    r.push({ x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0, serverTick: 0, sleeping: false, empty: true });
  }
  return r;
}

/** A swarm entry whose ring holds server poses at `ticks` moving at (vx, 0)
 *  from x0, and whose DRAWN pose (`entry.x/y`) is somewhere else entirely. */
function entry(kind: number, x0: number, vx: number, ticks: number[]): SwarmRenderState {
  const r = ring();
  ticks.forEach((t, i) => {
    const s = r[i]!;
    s.x = x0 + vx * (t / 60); s.y = 0; s.vx = vx; s.vy = 0; s.angle = 0.5; s.angvel = 0.25;
    s.serverTick = t; s.arrivalMs = t * 16; s.empty = false;
  });
  return {
    x: -999, y: -999, vx, vy: 0, angle: 0, angvel: 0, radius: 12, kind,
    sleeping: false, lastUpdateTick: ticks[ticks.length - 1] ?? 0,
    prevX: 0, prevY: 0, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: r, ringHead: ticks.length % POSE_RING_DEPTH,
  } as SwarmRenderState;
}

function snapshot(serverTick: number): SnapshotMessage {
  return {
    serverTick,
    ackedTick: serverTick - 1,
    states: {
      me: { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 },
      remote: { x: 40, y: 50, vx: 3, vy: 4, angle: 0.2, angvel: 0.1, lastInput: { thrust: true, turnLeft: false, turnRight: false, boost: false, reverse: false } },
    },
  } as unknown as SnapshotMessage;
}

async function world(): Promise<PhysicsWorld> {
  const w = await PhysicsWorld.create();
  w.spawnShip('me', 0, 0);
  w.spawnShip('remote', 400, 400);
  w.spawnObstacle('swarm-1', 0, 0, 12, 3);   // drone
  w.spawnObstacle('swarm-2', 0, 0, 12, 1);   // scrap
  w.spawnObstacle('swarm-3', 77, 77, 30, 3); // asteroid
  w.spawnObstacle('swarm-4', 88, 88, 30, 3); // structure
  return w;
}

function ctxFor(w: PhysicsWorld, mirror: RenderMirror, withSwarm: boolean): PreResetRemoteCtx {
  return {
    predWorld: w,
    mirror,
    preResetRemotePosScratch: new Map(),
    preResetRemotePosEntries: [],
    remoteLastInputs: new Map(),
    remoteForwardTicks: new Map(),
    ...(withSwarm
      ? {
          swarmBodyKeys: new Map([[1, 'swarm-1'], [2, 'swarm-2'], [3, 'swarm-3'], [4, 'swarm-4']]),
          swarmAnchorScratch: { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 },
        }
      : {}),
  };
}

function mirrorWithSwarm(): RenderMirror {
  return {
    ships: new Map(),
    projectiles: new Map(),
    localPlayerId: 'me',
    swarm: new Map([
      [1, entry(1, 100, 60, [96, 97, 98, 99, 100])],
      [2, entry(3, 200, -30, [99, 100])],
      [3, entry(0, 500, 0, [100])],
      [4, entry(2, 600, 0, [100])],
    ]),
  } as unknown as RenderMirror;
}

describe('remote-entity anchor (preResetRemoteShips)', () => {
  it('anchors drones and scrap from the pose ring at the snapshot tick, not the drawn pose', async () => {
    const w = await world();
    preResetRemoteShips(snapshot(100), 'me', ctxFor(w, mirrorWithSwarm(), true));
    const d = w.getShipState('swarm-1')!;
    expect(d.x).toBeCloseTo(100 + 60 * (100 / 60), 4); // ring pose at tick 100 (x0 + v·t)
    expect(d.vx).toBeCloseTo(60, 4);
    expect(d.angle).toBeCloseTo(0.5, 4);
    expect(d.angvel).toBeCloseTo(0.25, 4); // the server spin, like a remote ship
    const s = w.getShipState('swarm-2')!;
    expect(s.x).toBeCloseTo(200 - 30 * (100 / 60), 4);
    expect(s.vx).toBeCloseTo(-30, 4);
    // Static kinds are not this path's business.
    expect(w.getShipState('swarm-3')!.x).toBeCloseTo(77, 4);
    expect(w.getShipState('swarm-4')!.x).toBeCloseTo(88, 4);
    w.dispose();
  });

  it('carries the latest pose to the anchor tick when the wire did not land on it', async () => {
    const out = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
    const e = entry(1, 0, 60, [90, 93]);
    expect(authoritativeSwarmStateAt(e, 95, out)).toBe(true);
    // Pose at 93 (x = 93) carried 2 ticks at 60 u/s ⇒ 95.
    expect(out.x).toBeCloseTo(95, 4);
    expect(out.angle).toBeCloseTo(0.5 + 0.25 * (2 / 60), 6);
    // An exact tick wins over a newer one.
    expect(authoritativeSwarmStateAt(e, 90, out)).toBe(true);
    expect(out.x).toBeCloseTo(90, 4);
    // Only newer poses: carried BACK to the anchor tick.
    expect(authoritativeSwarmStateAt(e, 89, out)).toBe(true);
    expect(out.x).toBeCloseTo(89, 4);
    // Empty ring: nothing to anchor.
    expect(authoritativeSwarmStateAt(entry(1, 0, 0, []), 10, out)).toBe(false);
  });

  it('skips entities with no body yet (no cached key)', async () => {
    const w = await world();
    const mirror = mirrorWithSwarm();
    anchorRemoteSwarmBodies(w, mirror.swarm!, 100, new Map([[2, 'swarm-2']]), { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 });
    expect(w.getShipState('swarm-1')!.x).toBeCloseTo(0, 4); // untouched
    expect(w.getShipState('swarm-2')!.vx).toBeCloseTo(-30, 4);
    w.dispose();
  });

  it('remote PLAYER ships are anchored exactly as before (regression lock)', async () => {
    const a = await world();
    const b = await world();
    const ctxA = ctxFor(a, mirrorWithSwarm(), true);
    const ctxB = ctxFor(b, mirrorWithSwarm(), false); // pre-paradigm ctx: no swarm half
    preResetRemoteShips(snapshot(100), 'me', ctxA);
    preResetRemoteShips(snapshot(100), 'me', ctxB);
    expect(a.getShipState('remote')).toEqual(b.getShipState('remote'));
    expect(a.getShipState('remote')!.x).toBeCloseTo(40, 4);
    expect(ctxA.remoteLastInputs.get('remote')).toEqual(ctxB.remoteLastInputs.get('remote'));
    expect(ctxA.preResetRemotePosScratch.get('remote')).toEqual({ x: 400, y: 400 });
    // The local ship is never touched by the anchor.
    expect(a.getShipState('me')!.x).toBeCloseTo(0, 4);
    // Then the replay steps everything alike: the drone moves on from its
    // anchor at its own velocity (no per-frame re-pose).
    for (let i = 0; i < 6; i++) a.tick(1 / 60);
    expect(a.getShipState('swarm-1')!.x).toBeCloseTo(200 + 60 * (6 / 60), 1);
    a.dispose();
    b.dispose();
  });
});
