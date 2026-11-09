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
 * Root cause: the local ship is predicted AHEAD of the server (inputTick ≈
 * serverTick + lead), but each drone's predWorld collision body was the
 * "kinematic follower", re-posed every frame to the DISPLAY-DELAYED
 * interpolated pose (now − DISPLAY_DELAY_MS = 100 ms in the past). So the
 * ship met each drone where it was ~(100 ms + lead) ago while the server
 * resolved the contact against the real pose: a correction on every contact.
 * The replay could not fix it: it re-ran against the same lagging bodies.
 *
 * Fix (2026-11-08, the remote-entity paradigm — one system): drone and scrap
 * bodies follow the SAME path as remote player ships. On every snapshot they
 * are anchored to their latest server state (`anchorRemoteSwarmBodies`, the
 * production function, called from `preResetRemoteShips`), then the replay
 * and every local tick step them forward on the prediction timeline; nothing
 * re-poses them per frame. Sprites still draw the interpolated pose.
 *
 * The harness flies a boosting ship into a crossing pack (no latency, no
 * jitter, 60 Hz swarm packets, 20 Hz snapshots, lead 6 ticks) and counts
 * reconcile corrections above the pose gate's 0.3 u onset
 * (`showcase/wobble.ts`) plus the largest drift. It uses the REAL
 * `PhysicsWorld`, `Reconciler`, `interpolateSwarmPose` and
 * `anchorRemoteSwarmBodies`; the per-frame mirror step does what
 * `ColyseusClient.updateMirror` does (writes the interpolated pose into the
 * entry, leaves the body alone).
 *
 *   - control, no drones: 0 corrections (the harness itself is clean);
 *   - legacy follower (the pre-fix per-frame re-pose, kept as the contrast):
 *     7 corrections, 16 u peak;
 *   - production: within the pose gate, for drones and for scrap.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PhysicsWorld } from '../../src/core/physics/World.js';
import { Reconciler, type InputRecord } from '../../src/core/prediction/Reconciler.js';
import { interpolateSwarmPose, DISPLAY_DELAY_MS, type InterpolatedPose } from '../../src/client/net/swarmInterpolation.js';
import { anchorRemoteSwarmBodies } from '../../src/client/net/snapshotRemoteSync.js';
import type { PoseRingEntry, SwarmRenderState } from '../../src/core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../src/core/contracts/IRenderer.js';
import { getShipKind } from '../../src/shared-types/shipKinds.js';
import { massOf } from '../../src/shared-types/shipScale/tuning.js';
import { SCRAP_LINEAR_DAMPING } from '../../src/core/swarm/scrapConstants.js';
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
const SCRAP_MASS = 1; // scrapClientLeaf / server SCRAP_DEFAULT_MASS
const SCRAP_RADIUS = 18;
const TICKS = 360; // 6 s

type BodyPath = 'legacy-follower' | 'production';
type Pack = 'drones' | 'scrap';

interface Body { id: number; x: number; y: number; vx: number; vy: number }

/** A crossing pack ahead of a ship that thrusts +y from the origin. */
function dronePack(): Body[] {
  return [
    { id: 1, x: -260, y: 160, vx: 140, vy: 0 },
    { id: 2, x: 300, y: 330, vx: -150, vy: -20 },
    { id: 3, x: -40, y: 520, vx: 30, vy: -120 },
    { id: 4, x: 220, y: 640, vx: -110, vy: -60 },
  ];
}

/** Slow-drifting debris across the ship's path (a wreck field). */
function scrapField(): Body[] {
  return [
    { id: 11, x: 10, y: 140, vx: -20, vy: 10 },
    { id: 12, x: -30, y: 300, vx: 25, vy: -15 },
    { id: 13, x: 25, y: 470, vx: -10, vy: -30 },
    { id: 14, x: -5, y: 650, vx: 15, vy: 5 },
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
function decodeInto(entry: SwarmRenderState, s: { x: number; y: number; vx: number; vy: number; angle: number; angvel?: number }, tick: number, nowMs: number): void {
  entry.x = s.x; entry.y = s.y; entry.vx = s.vx; entry.vy = s.vy; entry.angle = s.angle;
  entry.lastUpdateTick = tick;
  const slot = entry.poseRing[entry.ringHead]!;
  slot.x = s.x; slot.y = s.y; slot.angle = s.angle; slot.vx = s.vx; slot.vy = s.vy; slot.angvel = s.angvel ?? 0;
  slot.arrivalMs = nowMs; slot.serverTick = tick; slot.sleeping = false; slot.empty = false;
  entry.ringHead = (entry.ringHead + 1) % POSE_RING_DEPTH;
}

interface Result { corrections: number; big: number; maxDrift: number; contactTicks: number }

async function run(withBodies: boolean, path: BodyPath, packKind: Pack = 'drones'): Promise<Result> {
  const server = await PhysicsWorld.create();
  const client = await PhysicsWorld.create();
  let nowMs = 0;
  const clock: Clock = { now: () => nowMs };
  const droneKind = getShipKind(DRONE_KIND);
  const isScrap = packKind === 'scrap';
  const radius = isScrap ? SCRAP_RADIUS : droneKind.radius;
  const bodies = withBodies ? (isScrap ? scrapField() : dronePack()) : [];
  const keyOf = (id: number): string => `swarm-${id}`;
  const swarm = new Map<number, SwarmRenderState>();
  const keyCache = new Map<number, string>();
  for (const w of [server, client]) {
    w.spawnShip(PLAYER, 0, 0, SHIP_KIND);
    for (const b of bodies) {
      if (isScrap) w.spawnObstacle(keyOf(b.id), b.x, b.y, SCRAP_RADIUS, SCRAP_MASS, undefined, SCRAP_LINEAR_DAMPING);
      else w.spawnObstacle(keyOf(b.id), b.x, b.y, droneKind.radius, massOf(droneKind, 3));
      w.setShipState(keyOf(b.id), { x: b.x, y: b.y, vx: b.vx, vy: b.vy, angle: 0, angvel: 0 });
    }
  }
  for (const b of bodies) {
    keyCache.set(b.id, keyOf(b.id));
    swarm.set(b.id, {
      x: b.x, y: b.y, vx: b.vx, vy: b.vy, angle: 0, angvel: 0, radius, kind: isScrap ? 3 : 1,
      sleeping: false, lastUpdateTick: 0, prevX: b.x, prevY: b.y, prevAngle: 0, prevArrivalMs: 0,
      latestArrivalMs: 0, poseRing: emptyRing(), ringHead: 0,
    } as SwarmRenderState);
  }
  const reconciler = new Reconciler(client, PLAYER, clock);
  const interp: InterpolatedPose = { x: 0, y: 0, angle: 0 };
  const follow = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
  const anchorScratch = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };

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
  let corrections = 0, big = 0, maxDrift = 0, contactTicks = 0;
  for (let f = 0; f < TICKS; f++) {
    // ---- server tick (applies the input stamped with its own tick) ----
    server.applyInput(PLAYER, inputAt(serverTick));
    server.tick(1 / 60);
    serverTick++;
    nowMs = serverTick * FIXED_MS;
    const sp = server.getShipState(PLAYER)!;
    for (const b of bodies) {
      const s = server.getShipState(keyOf(b.id))!;
      if (Math.hypot(s.x - sp.x, s.y - sp.y) < radius + 80) contactTicks++;
      decodeInto(swarm.get(b.id)!, s, serverTick, nowMs); // swarm packet (60 Hz, zero latency)
    }
    // ---- client frame: tickPhysics (snapshot → reconcile, then one local tick) ----
    if (serverTick % SNAPSHOT_EVERY === 0) {
      // Production: the remote-entity anchor, as `preResetRemoteShips` runs it.
      if (path === 'production') anchorRemoteSwarmBodies(client, swarm, serverTick, keyCache, anchorScratch);
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
    // ---- client frame: updateMirror ----
    for (const b of bodies) {
      const e = swarm.get(b.id)!;
      // Drawing: the single per-frame interpolated pose (both paths).
      interpolateSwarmPose(e, nowMs, interp);
      e.x = interp.x; e.y = interp.y; e.angle = interp.angle;
      if (path === 'legacy-follower') {
        // The RETIRED kinematic follower: body re-posed to the drawn pose.
        follow.x = interp.x; follow.y = interp.y; follow.vx = e.vx; follow.vy = e.vy;
        follow.angle = interp.angle; follow.angvel = 0;
        client.setShipState(keyOf(b.id), follow);
      }
    }
  }
  server.dispose();
  client.dispose();
  return { corrections, big, maxDrift, contactTicks };
}

describe('melee: local-player prediction vs drone/scrap contacts (WS7.1)', () => {
  beforeAll(() => {
    expect(DISPLAY_DELAY_MS).toBe(100);
  });

  it('control: with no drones the prediction never corrects', async () => {
    const r = await run(false, 'production');
    expect(r.corrections).toBe(0);
  });

  it('the scenarios really are melees (the ship meets the pack / the debris)', async () => {
    expect((await run(true, 'production')).contactTicks).toBeGreaterThan(10);
    expect((await run(true, 'production', 'scrap')).contactTicks).toBeGreaterThan(10);
  });

  it('production (remote-entity anchor) stays within the pose gate against drones', async () => {
    const r = await run(true, 'production');
    const why = `corrections ${r.corrections} (>1 u: ${r.big}), max drift ${r.maxDrift.toFixed(2)} u`;
    expect(r.corrections, why).toBeLessThanOrEqual(GATE_MAX);
    expect(r.maxDrift, why).toBeLessThanOrEqual(MAX_CONTACT_DRIFT_U);
  });

  it('production stays within the pose gate against dynamic mass-1 scrap', async () => {
    const r = await run(true, 'production', 'scrap');
    const why = `corrections ${r.corrections} (>1 u: ${r.big}), max drift ${r.maxDrift.toFixed(2)} u`;
    expect(r.corrections, why).toBeLessThanOrEqual(GATE_MAX);
    expect(r.maxDrift, why).toBeLessThanOrEqual(MAX_CONTACT_DRIFT_U);
  });

  // Contrast: the retired per-frame follower fails the same scene. If this
  // ever passes, the harness stopped modelling the bug.
  it('contrast: the retired display-delayed follower corrects on contact', async () => {
    const legacy = await run(true, 'legacy-follower');
    const prod = await run(true, 'production');
    const why = `legacy ${legacy.corrections} corrections / ${legacy.maxDrift.toFixed(2)} u vs production ${prod.corrections} / ${prod.maxDrift.toFixed(2)} u`;
    expect(legacy.maxDrift, why).toBeGreaterThan(MAX_CONTACT_DRIFT_U);
    expect(prod.maxDrift * 4, why).toBeLessThan(legacy.maxDrift);
  });
});
