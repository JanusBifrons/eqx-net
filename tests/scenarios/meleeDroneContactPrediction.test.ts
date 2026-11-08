/**
 * WS7.1 (plan machine-independent-perf) — prediction corrections in dense melee.
 *
 * Reported symptom (showcase 2026-11-08, fast desktop, server at 60 Hz):
 * the `pack-battle` shot (`feel-test-25`, interceptor, hostile pack) failed
 * all 3 takes on the pose-trace gate — 4 / 3 / 6 prediction corrections
 * (max 2) — and `new-effects` (the same scene) 4 and 14. Other shots: 0.
 *
 * Browser probe (2026-11-08, the shot's input script, 8 takes): 0–10
 * correction onsets per take, and EVERY onset is within ~30 u of a drone
 * hull; the one take with zero local contacts had zero corrections. So it
 * is not host starvation: it is local-player CONTACT with drones.
 *
 * Root cause (this test models it with the REAL production pieces —
 * `PhysicsWorld`, `Reconciler`, `interpolateSwarmPose`, and the
 * `ColyseusClient.updateMirror` kinematic-follower rule):
 *
 *   The local ship is predicted AHEAD of the server (inputTick ≈ serverTick
 *   + lead), but each drone's predWorld collision body is the kinematic
 *   follower posed at the DISPLAY-DELAYED interpolated pose
 *   (now − DISPLAY_DELAY_MS = 100 ms in the past). So in predWorld the ship
 *   meets each drone where it was ~(100 ms + lead) ago, while the server
 *   resolves the same contact against the drone's real pose. Different
 *   contact geometry ⇒ different post-contact ship state ⇒ a reconcile
 *   correction on the next snapshot, every contact. The reconcile replay
 *   cannot fix it: it re-runs the ticks against the same lagging bodies.
 *
 * The test flies a boosting ship into a crossing pack (no latency, no
 * jitter, 60 Hz swarm packets, 20 Hz snapshots, lead 6 ticks) and counts
 * reconcile corrections above the pose gate's 0.3 u onset
 * (`showcase/wobble.ts`) plus the largest drift.
 *
 *   - control, no drones: 0 corrections (the harness itself is clean);
 *   - production follower (display-delayed pose): 7 corrections, 16 u peak —
 *     `it.fails`, the open bug; flip to `it` when it is fixed;
 *   - candidate fix model, drone bodies dead-reckoned to the PREDICTED tick
 *     (latest server pose + v·(tick − poseTick)/60, re-seated at
 *     ackedTick+1 before replay): ~1.9 u peak. A browser A/B of the same
 *     idea (an in-page patch, pack-battle input script) took the shot from
 *     mean 6.4 onsets/take (1/8 takes within the gate) to 1.9 (8/10).
 *     Not shipped: the collision body would lead the drawn sprite by
 *     ~(100 ms + lead)·v, against the documented render == collision rule
 *     (src/client/CLAUDE.md), and the local hitscan rays test predWorld
 *     bodies — a design call. See docs/LESSONS.md 2026-11-08.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PhysicsWorld } from '../../src/core/physics/World.js';
import { Reconciler, type InputRecord } from '../../src/core/prediction/Reconciler.js';
import { interpolateSwarmPose, DISPLAY_DELAY_MS, type InterpolatedPose } from '../../src/client/net/swarmInterpolation.js';
import type { PoseRingEntry, SwarmRenderState } from '../../src/core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../src/core/contracts/IRenderer.js';
import { getShipKind } from '../../src/shared-types/shipKinds.js';
import { massOf } from '../../src/shared-types/shipScale/tuning.js';
import type { Clock } from '../../src/core/clock/Clock.js';

const FIXED_MS = 1000 / 60;
/** `ColyseusClient.leadTicks` default. */
const LEAD_TICKS = 6;
/** Snapshot every 3 server ticks (20 Hz). */
const SNAPSHOT_EVERY = 3;
/** The showcase pose gate: an onset is a lerp jump above 0.3 u; max 2 per take. */
const ONSET_U = 0.3;
const GATE_MAX = 2;
/** A contact correction above this is a visible hop of the ship. */
const MAX_CONTACT_DRIFT_U = 3;
const PLAYER = 'p1';
const SHIP_KIND = 'interceptor';
const DRONE_KIND = 'fighter';
const TICKS = 360; // 6 s

type Follower = 'display-delayed' | 'predicted-tick';

interface Drone { key: string; x: number; y: number; vx: number; vy: number }

/** A crossing pack ahead of a ship that thrusts +y from the origin. */
function pack(): Drone[] {
  return [
    { key: 'swarm-1', x: -260, y: 160, vx: 140, vy: 0 },
    { key: 'swarm-2', x: 300, y: 330, vx: -150, vy: -20 },
    { key: 'swarm-3', x: -40, y: 520, vx: 30, vy: -120 },
    { key: 'swarm-4', x: 220, y: 640, vx: -110, vy: -60 },
  ];
}

function emptyRing(): PoseRingEntry[] {
  const ring: PoseRingEntry[] = new Array(POSE_RING_DEPTH);
  for (let i = 0; i < POSE_RING_DEPTH; i++) {
    ring[i] = { x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0, serverTick: 0, sleeping: false, empty: true };
  }
  return ring;
}

/** Mirrors `BinarySwarmDecoder`'s per-record write (latest pose + ring push). */
function decodeInto(entry: SwarmRenderState, s: { x: number; y: number; vx: number; vy: number; angle: number }, tick: number, nowMs: number): void {
  entry.x = s.x; entry.y = s.y; entry.vx = s.vx; entry.vy = s.vy; entry.angle = s.angle;
  entry.lastUpdateTick = tick;
  const slot = entry.poseRing[entry.ringHead]!;
  slot.x = s.x; slot.y = s.y; slot.angle = s.angle; slot.vx = s.vx; slot.vy = s.vy; slot.angvel = 0;
  slot.arrivalMs = nowMs; slot.serverTick = tick; slot.sleeping = false; slot.empty = false;
  entry.ringHead = (entry.ringHead + 1) % POSE_RING_DEPTH;
}

interface Result { corrections: number; big: number; maxDrift: number; contactTicks: number }

async function run(withDrones: boolean, follower: Follower): Promise<Result> {
  const server = await PhysicsWorld.create();
  const client = await PhysicsWorld.create();
  let nowMs = 0;
  const clock: Clock = { now: () => nowMs };
  const droneKind = getShipKind(DRONE_KIND);
  const drones = withDrones ? pack() : [];
  const entries = new Map<string, SwarmRenderState>();
  for (const w of [server, client]) {
    w.spawnShip(PLAYER, 0, 0, SHIP_KIND);
    for (const d of drones) {
      w.spawnObstacle(d.key, d.x, d.y, droneKind.radius, massOf(droneKind, 3));
      w.setShipState(d.key, { x: d.x, y: d.y, vx: d.vx, vy: d.vy, angle: 0, angvel: 0 });
    }
  }
  for (const d of drones) {
    entries.set(d.key, {
      x: d.x, y: d.y, vx: d.vx, vy: d.vy, angle: 0, angvel: 0, radius: droneKind.radius, kind: 1,
      sleeping: false, lastUpdateTick: 0, prevX: d.x, prevY: d.y, prevAngle: 0, prevArrivalMs: 0,
      latestArrivalMs: 0, poseRing: emptyRing(), ringHead: 0,
    } as SwarmRenderState);
  }
  const reconciler = new Reconciler(client, PLAYER, clock);
  const interp: InterpolatedPose = { x: 0, y: 0, angle: 0 };
  const follow = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };

  /** Pose a drone follower body at the tick `T` (predicted-tick model). */
  const seatAt = (key: string, T: number): void => {
    const e = entries.get(key)!;
    const dt = (T - e.lastUpdateTick) / 60;
    follow.x = e.x + e.vx * dt; follow.y = e.y + e.vy * dt;
    follow.vx = e.vx; follow.vy = e.vy; follow.angle = e.angle; follow.angvel = 0;
    client.setShipState(key, follow);
  };

  const inputAt = (_tick: number): InputRecord => ({ tick: _tick, thrust: true, turnLeft: false, turnRight: false, boost: true, reverse: false, sentAt: 0 });

  let serverTick = 0;
  let inputTick = LEAD_TICKS;
  // The client already predicted its lead ticks (all thrust) before the first snapshot.
  for (let t = 0; t < LEAD_TICKS; t++) {
    const rec = inputAt(t);
    client.applyInput(PLAYER, rec);
    reconciler.recordInput(rec);
    client.tick(1 / 60);
  }
  // Re-sync: both start at tick 0 from the origin; the client's head start is its lead.
  let corrections = 0, big = 0, maxDrift = 0, contactTicks = 0;
  for (let f = 0; f < TICKS; f++) {
    // ---- server tick (applies the input stamped with its own tick) ----
    server.applyInput(PLAYER, inputAt(serverTick));
    server.tick(1 / 60);
    serverTick++;
    nowMs = serverTick * FIXED_MS;
    const sp = server.getShipState(PLAYER)!;
    for (const d of drones) {
      const s = server.getShipState(d.key)!;
      if (Math.hypot(s.x - sp.x, s.y - sp.y) < droneKind.radius + 80) contactTicks++;
      decodeInto(entries.get(d.key)!, s, serverTick, nowMs); // swarm packet (60 Hz, zero latency)
    }
    // ---- client frame: tickPhysics (snapshot → reconcile, then one local tick) ----
    if (serverTick % SNAPSHOT_EVERY === 0) {
      if (follower === 'predicted-tick') for (const d of drones) seatAt(d.key, serverTick);
      reconciler.reconcile(sp, serverTick, inputTick, serverTick - 1);
      if (reconciler.lastDrift > ONSET_U) corrections++;
      if (reconciler.lastDrift > 1) big++;
      maxDrift = Math.max(maxDrift, reconciler.lastDrift);
    }
    const rec = inputAt(inputTick);
    client.applyInput(PLAYER, rec);
    reconciler.recordInput(rec);
    client.tick(1 / 60);
    inputTick++;
    // ---- client frame: updateMirror — the drone kinematic follower ----
    for (const d of drones) {
      const e = entries.get(d.key)!;
      if (follower === 'display-delayed') {
        interpolateSwarmPose(e, nowMs, interp);
        follow.x = interp.x; follow.y = interp.y; follow.vx = e.vx; follow.vy = e.vy;
        follow.angle = interp.angle; follow.angvel = 0;
        client.setShipState(d.key, follow);
      } else {
        seatAt(d.key, inputTick);
      }
    }
  }
  server.dispose();
  client.dispose();
  return { corrections, big, maxDrift, contactTicks };
}

describe('melee: local-player prediction vs drone contacts (WS7.1)', () => {
  beforeAll(() => {
    expect(DISPLAY_DELAY_MS).toBe(100);
  });

  it('control: with no drones the prediction never corrects', async () => {
    const r = await run(false, 'display-delayed');
    expect(r.corrections).toBe(0);
  });

  it('the scenario really is a melee (the ship meets the pack)', async () => {
    const r = await run(true, 'display-delayed');
    expect(r.contactTicks).toBeGreaterThan(10);
  });

  // OPEN BUG (WS7.1): flip `it.fails` → `it` when the drone collision body is
  // posed on the local prediction's timeline. Today: 7 corrections, 16 u peak.
  it.fails('production follower (display-delayed drone body) stays within the pose gate', async () => {
    const r = await run(true, 'display-delayed');
    const why = `corrections ${r.corrections} (>1 u: ${r.big}), max drift ${r.maxDrift.toFixed(2)} u`;
    expect(r.corrections, why).toBeLessThanOrEqual(GATE_MAX);
    expect(r.maxDrift, why).toBeLessThanOrEqual(MAX_CONTACT_DRIFT_U);
  });

  // Evidence for the fix direction, not production code. Posing the body on
  // the predicted tick shrinks every contact correction ~9× (16 → ~1.9 u).
  // What is left comes from re-posing the follower each frame, which drops
  // the client's own push on the drone (the server keeps it).
  it('candidate fix model (drone body on the predicted tick) keeps contact corrections small', async () => {
    const r = await run(true, 'predicted-tick');
    const prod = await run(true, 'display-delayed');
    const why = `candidate max drift ${r.maxDrift.toFixed(2)} u vs production ${prod.maxDrift.toFixed(2)} u`;
    expect(r.maxDrift, why).toBeLessThanOrEqual(MAX_CONTACT_DRIFT_U);
    expect(r.maxDrift * 4, why).toBeLessThan(prod.maxDrift);
  });
});
