/**
 * Render-mirror post delta (2026-11-13). Two locks, both through the REAL
 * `WorkerRendererClient.update` with a fake Worker that structured-clones
 * every post (transfer list honoured), so they cross the same boundary the
 * game does (#13: test at the level the cost lives):
 *
 * 1. COUNT gate: with N sleeping wreck pieces + M moving ships, the swarm
 *    entries (and floats) posted per frame are O(M), not O(N + M). Before the
 *    delta, every MIRROR_UPDATE carried the whole `mirror.swarm` (N + M
 *    entries with their 10-slot pose rings) every frame.
 * 2. PARITY (#15): over frames mixing moving, sleeping, waking, added and
 *    removed entities, non-pose field changes and a key removed, the worker's
 *    swarm (rebuilt by `SwarmMirrorReplica`, as `renderer.worker.ts` does)
 *    equals the main thread's after every post.
 */
import { describe, expect, it } from 'vitest';
import { POSE_RING_DEPTH, type PoseRingEntry, type RenderMirror, type SwarmRenderState } from '@core/contracts/IRenderer';
import { WorkerRendererClient } from './WorkerRendererClient';
import { SwarmDeltaEncoder, SwarmMirrorReplica, POSE_HEADER, POSE_SLOT_STRIDE } from './swarmMirrorDelta';
import type { MainToWorkerMsg, SwarmDeltaMsg } from './protocol';

type Posted = { mirror: RenderMirror; swarmDelta?: SwarmDeltaMsg };

function ring(): PoseRingEntry[] {
  const r: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) {
    r.push({ x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0, serverTick: 0, sleeping: false, empty: true });
  }
  return r;
}

/** A swarm entry as `BinarySwarmDecoder` makes it on first sighting. */
function make(kind: number, x: number, y: number, tick: number, sleeping: boolean): SwarmRenderState {
  const r = ring();
  Object.assign(r[0]!, { x, y, arrivalMs: tick * 16, serverTick: tick, sleeping, empty: false });
  return {
    x, y, vx: 0, vy: 0, angle: 0, angvel: 0, radius: 20, kind, sleeping, shieldDown: false,
    lastUpdateTick: tick, shipKind: 'fighter',
    ...(kind === 4 ? { componentIndex: 2, wreckId: 7 } : {}),
    prevX: x, prevY: y, prevAngle: 0, prevArrivalMs: tick * 16, latestArrivalMs: tick * 16,
    poseRing: r, ringHead: 1,
  };
}

/** A packet for `e`, as the decoder applies it (pose + ring slot + head). */
function packet(e: SwarmRenderState, x: number, y: number, tick: number, sleeping = false): void {
  e.prevX = e.x; e.prevY = e.y; e.prevAngle = e.angle;
  e.prevArrivalMs = e.latestArrivalMs; e.latestArrivalMs = tick * 16;
  e.x = x; e.y = y; e.vx = sleeping ? 0 : 1.5; e.angle = x * 0.01; e.angvel = sleeping ? 0 : 0.2;
  e.sleeping = sleeping; e.lastUpdateTick = tick;
  const s = e.poseRing[e.ringHead]!;
  Object.assign(s, { x, y, angle: e.angle, vx: e.vx, vy: 0, angvel: e.angvel, arrivalMs: tick * 16, serverTick: tick, sleeping, empty: false });
  e.ringHead = (e.ringHead + 1) % POSE_RING_DEPTH;
}

function mirrorWith(swarm: Map<number, SwarmRenderState>): RenderMirror {
  return { ships: new Map(), projectiles: new Map(), swarm } as unknown as RenderMirror;
}

/** A client wired to a fake worker that structured-clones each post. */
function harness(): { client: WorkerRendererClient; posts: Posted[] } {
  const client = new WorkerRendererClient();
  const posts: Posted[] = [];
  const fake = {
    postMessage(msg: MainToWorkerMsg, transfer?: Transferable[]): void {
      if (msg.type !== 'MIRROR_UPDATE') return;
      posts.push(structuredClone(msg, transfer ? { transfer } : undefined) as Posted);
    },
  };
  (client as unknown as { worker: unknown }).worker = fake;
  return { client, posts };
}

/** Swarm entries + float64 slots the post carried for the swarm. */
function postedSwarmCost(p: Posted): { entries: number; floats: number } {
  const whole = p.mirror.swarm ? p.mirror.swarm.size : 0;
  const d = p.swarmDelta;
  if (!d) return { entries: whole, floats: 0 };
  let poseRecords = 0;
  const b = d.pose ? new Float64Array(d.pose, 0, d.poseLen) : null;
  for (let o = 0; b && o < d.poseLen; poseRecords++) o += POSE_HEADER + b[o + POSE_HEADER - 1]! * POSE_SLOT_STRIDE;
  return { entries: whole + d.full.length + poseRecords, floats: d.poseLen };
}

describe('render-mirror post delta', () => {
  it('COUNT gate: swarm entries posted per frame are O(moving), not O(sleeping + moving)', () => {
    const N = 1000; // sleeping wreck pieces
    const M = 12; // moving ships
    const swarm = new Map<number, SwarmRenderState>();
    for (let i = 0; i < N; i++) swarm.set(i, make(4, i * 30, 500, 1, true));
    for (let j = 0; j < M; j++) swarm.set(N + j, make(1, j * 50, 0, 1, false));
    const { client, posts } = harness();
    const mirror = mirrorWith(swarm);
    client.update(mirror); // first post: everything is new
    for (let f = 0; f < 30; f++) {
      const tick = 2 + f;
      for (let j = 0; j < M; j++) {
        const e = swarm.get(N + j)!;
        packet(e, e.x + 3, e.y + 1, tick);
        // The frame's resolved drawn pose (updateMirror writes x/y per frame).
        e.x += 0.5;
      }
      client.update(mirror);
    }
    const steady = posts.slice(1).map(postedSwarmCost);
    const maxEntries = Math.max(...steady.map((c) => c.entries));
    const maxFloats = Math.max(...steady.map((c) => c.floats));
    // O(M): one record per moving ship, each with its one new ring slot.
    expect(maxEntries).toBeLessThanOrEqual(M);
    expect(maxFloats).toBeLessThanOrEqual(M * (POSE_HEADER + 2 * POSE_SLOT_STRIDE));
  });

  it('PARITY: the worker-side swarm equals the main-thread swarm after every post', () => {
    const swarm = new Map<number, SwarmRenderState>();
    for (let i = 0; i < 40; i++) swarm.set(i, make(4, i * 30, 500, 1, true)); // resting pieces
    for (let j = 0; j < 6; j++) swarm.set(100 + j, make(1, j * 50, 0, 1, false)); // ships
    const { client, posts } = harness();
    const replica = new SwarmMirrorReplica();
    const mirror = mirrorWith(swarm);
    let next = 200;
    for (let f = 0; f < 80; f++) {
      const tick = 2 + f;
      // Moving ships: a packet most frames, two in one frame now and then.
      for (let j = 0; j < 6; j++) {
        const e = swarm.get(100 + j);
        if (!e) continue;
        if (f % 4 !== 3) packet(e, e.x + 2, e.y - 1, tick);
        if (f % 9 === 0) packet(e, e.x + 1, e.y, tick);
        e.x += 0.25; // resolved drawn pose
        e.isHostileToLocal = f % 10 < 5; // a per-frame flag
        if (j === 0) e.displayMountAngles = [f * 0.01, -f * 0.01]; // array changes
      }
      // A sleeping piece's 1 Hz full refresh (same pose, ring advances).
      if (f % 20 === 5) for (let i = 0; i < 40; i += 3) { const e = swarm.get(i); if (e) packet(e, e.x, e.y, tick, true); }
      // A piece wakes and drifts, then sleeps again.
      if (f >= 10 && f < 20) packet(swarm.get(7)!, 210 + f, 500, tick, f === 19);
      // More than a whole ring of packets between two posts.
      if (f === 30) for (let k = 0; k < POSE_RING_DEPTH + 3; k++) packet(swarm.get(101)!, 300 + k, 0, tick);
      // Adds and removes.
      if (f % 7 === 2) swarm.set(next++, make(f % 2 === 0 ? 3 : 4, f, f, tick, false));
      if (f % 11 === 4) swarm.delete(f % 40);
      if (f === 15) swarm.delete(102);
      // A key appears, then is removed; a non-pose field changes.
      if (f === 25) swarm.get(103)!.healthFrac = 0.5;
      if (f === 26) delete swarm.get(103)!.healthFrac;
      if (f === 40) swarm.get(104)!.shieldDown = true;
      // The same id gets a new entry object.
      if (f === 50) swarm.set(105, make(1, 0, 0, tick, false));
      client.update(mirror);
      const p = posts[posts.length - 1]!;
      expect(p.mirror.swarm).toBeUndefined(); // the swarm never rides the clone
      const workerSwarm = replica.apply(p.swarmDelta!);
      expect(workerSwarm).toEqual(swarm);
      expect(mirror.swarm).toBe(swarm); // restored on the main thread
    }
    // A new swarm Map (sector handoff) resets the worker's copy.
    const fresh = new Map<number, SwarmRenderState>([[1, make(0, 5, 5, 99, false)]]);
    mirror.swarm = fresh;
    client.update(mirror);
    expect(replica.apply(posts[posts.length - 1]!.swarmDelta!)).toEqual(fresh);
    // No swarm at all.
    mirror.swarm = undefined;
    client.update(mirror);
    expect(replica.apply(posts[posts.length - 1]!.swarmDelta!)).toBeUndefined();
  });

  it('reuses the pose buffer the worker hands back (no per-frame allocation)', () => {
    const swarm = new Map<number, SwarmRenderState>([[1, make(1, 0, 0, 1, false)]]);
    const enc = new SwarmDeltaEncoder();
    enc.encode(swarm);
    enc.posted();
    for (let f = 0; f < 5; f++) {
      packet(swarm.get(1)!, f, 0, 2 + f);
      const d = enc.encode(swarm);
      const sent = d.pose!;
      expect(sent).not.toBeNull();
      // Transfer to the worker (detaches it here), the worker hands it back.
      const back = structuredClone(sent, { transfer: [sent] });
      enc.posted();
      enc.returnBuffer(back);
      packet(swarm.get(1)!, f + 0.5, 0, 2 + f);
      expect(enc.encode(swarm).pose).toBe(back); // reused, not allocated
      const again = structuredClone(back, { transfer: [back] });
      enc.posted();
      enc.returnBuffer(again);
    }
  });
});
