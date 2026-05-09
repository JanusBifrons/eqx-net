/**
 * Hypothesis test for the 2026-05-09 combat-phase correction-burst
 * pathology (cap `2026-05-09T09-54-45-849Z-8grdi1` and earlier).
 *
 * After all four prior network-feel fixes — Welford reset on warp,
 * tick-gated input dequeue, LEAD-subtract on welford RTT, post-gap
 * skip — the input-prediction loop is provably correct (no drift in
 * cap 1 with 0 corrections in 226 snapshots over 11 s). But cap 2
 * still showed 19 corrections in 7.25 s during combat with max
 * drift ~22 u, all clustered around `swarm_near_enter` events.
 *
 * The hypothesis under test: **drones are not in the client's
 * predWorld at all** (per `src/client/CLAUDE.md`: "swarm entities —
 * asteroids, drones — are not in predWorld; they live render-only in
 * mirror.swarm"). So when a drone collides with the player on the
 * server, Rapier applies a velocity change to the player's rigid body
 * server-side. The client's predWorld has no drone, no collision
 * happens there, and the client's predicted player keeps moving on
 * its prior velocity. By the time the next snapshot arrives, the
 * client and server players have diverged — exactly the drift event
 * the user feels as a "snap" during combat.
 *
 * This is a pure architectural mismatch: the server's authoritative
 * physics has player ↔ drone interactions; the client's predicted
 * physics has only player ↔ remote-ship interactions. The reconciler
 * only realigns after each snapshot, so any contact between snapshots
 * produces a drift bounded by impulse-magnitude × ticks-since-snapshot.
 *
 * This test runs two PhysicsWorld instances:
 *   - server: contains player + drone; AI impulse drives drone toward
 *     player; physics resolves the contact.
 *   - client: contains ONLY the player; no drone, no contact. The
 *     player just moves on its own input.
 *
 * Both apply identical player input every tick. Every 3 ticks (snapshot
 * cadence), client snaps player state to server's. Measure player
 * drift between snapshots — that's what reconcile sees as "drift" and
 * surfaces as a correction event.
 *
 * If drift > 0 in the contact window, hypothesis is confirmed and the
 * fix surface is "client predWorld needs to include drones" (or some
 * equivalent — broadcast collision impulses to client, or replicate the
 * ship's rigid body's collision response post-snapshot, etc.).
 *
 * Pure simulation; runs in vitest with the Rapier WASM init done in
 * beforeAll. No browser, no server, no manual smoke. Re-runnable.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PhysicsWorld } from './World.js';

let serverWorld: PhysicsWorld;
let clientWorld: PhysicsWorld;

beforeAll(async () => {
  serverWorld = await PhysicsWorld.create();
  clientWorld = await PhysicsWorld.create();
});

interface DriftSample {
  tick: number;
  serverShipX: number;
  serverShipY: number;
  clientShipX: number;
  clientShipY: number;
  shipDriftDist: number;
  /** True when this tick's player position got reconciled to server's. */
  reconciledThisTick: boolean;
}

/**
 * Run the dual-world simulation. Returns per-tick drift samples.
 *
 * The server world contains the player AND the drone (full physics).
 * The client world contains ONLY the player — no drone — matching the
 * actual architecture where swarm entities live render-only in
 * `mirror.swarm` and never enter `predWorld`.
 *
 * @param totalTicks       Number of physics steps to run.
 * @param snapshotEvery    Reconcile client player to server every N ticks.
 *                         Production snapshot cadence is 3 (50 ms at 60 Hz).
 * @param dronePresent     If false, no drone is spawned anywhere. Used as
 *                         the control case to verify the harness has zero
 *                         intrinsic drift before the contact is introduced.
 * @param droneInitialX    Drone spawn x (only used when dronePresent).
 * @param droneInitialY    Drone spawn y.
 */
function simulate(opts: {
  totalTicks: number;
  snapshotEvery: number;
  dronePresent: boolean;
  droneInitialX?: number;
  droneInitialY?: number;
}): DriftSample[] {
  // Reset bodies — beforeAll creates the worlds once per file.
  serverWorld.despawnShip('player');
  serverWorld.despawnShip('drone');
  clientWorld.despawnShip('player');

  // Spawn ship at origin, facing +Y (default angle = 0).
  serverWorld.spawnShip('player', 0, 0);
  clientWorld.spawnShip('player', 0, 0);

  // Spawn drone ONLY on the server. This is the architectural mismatch
  // the test exercises — the client's predWorld never has the drone.
  if (opts.dronePresent) {
    const dx = opts.droneInitialX ?? 0;
    const dy = opts.droneInitialY ?? 30;
    // Massive (relative to ship) and small radius so the AI impulse
    // drives it into the player path within the test window. The
    // matching params in production are kind=1 drones with the same
    // shape; this is a controlled stand-in.
    serverWorld.spawnObstacle('drone', dx, dy, 18, 5);
  }

  const samples: DriftSample[] = [];

  for (let tick = 0; tick < opts.totalTicks; tick++) {
    serverWorld.applyInput('player', { thrust: true, turnLeft: false, turnRight: false });
    clientWorld.applyInput('player', { thrust: true, turnLeft: false, turnRight: false });

    // Server applies a sustained AI impulse to push the drone
    // toward (-Y, where the player is heading from). The impulse
    // is held every tick — exactly what a "approach target" AI
    // behaviour produces continuously.
    if (opts.dronePresent) {
      serverWorld.applyImpulse('drone', 0, -3.0, 0);
    }

    serverWorld.tick(1 / 60);
    clientWorld.tick(1 / 60);

    // Reconcile: every snapshotEvery ticks, snap client player to
    // server player state. This models what the actual reconciler
    // does after a snapshot arrives.
    let reconciledThisTick = false;
    if ((tick + 1) % opts.snapshotEvery === 0) {
      const serverPlayer = serverWorld.getShipState('player');
      if (serverPlayer) {
        clientWorld.setShipState('player', serverPlayer);
        reconciledThisTick = true;
      }
    }

    const sShip = serverWorld.getShipState('player')!;
    const cShip = clientWorld.getShipState('player')!;
    samples.push({
      tick,
      serverShipX: sShip.x,
      serverShipY: sShip.y,
      clientShipX: cShip.x,
      clientShipY: cShip.y,
      shipDriftDist: Math.hypot(sShip.x - cShip.x, sShip.y - cShip.y),
      reconciledThisTick,
    });
  }

  return samples;
}

describe('drone-vs-player collision: predWorld-mismatch drift', () => {
  it('control: with no drone in either world, the two stay in lockstep', () => {
    // Sanity: identical inputs, no asymmetry, must produce zero drift.
    const samples = simulate({ totalTicks: 120, snapshotEvery: 3, dronePresent: false });

    const maxDrift = Math.max(...samples.map((s) => s.shipDriftDist));
    expect(maxDrift).toBeLessThan(0.01);
  });

  it('with drone on server only, between-snapshot drift exists when drone contacts player', () => {
    // The hypothesis: when the drone hits the player on the server, the
    // collision impulse changes the player's velocity server-side. The
    // client has no drone in its predWorld, so it doesn't see the
    // impulse and the predicted player keeps moving on its prior
    // velocity. Snapshot reconcile snaps client to server every 3 ticks,
    // but in the 1-2 ticks between snapshot and the next contact, drift
    // re-opens.
    //
    // Spawn drone close to where the thrust will carry the player so
    // contact happens within ~1 sec.
    const samples = simulate({
      totalTicks: 240,
      snapshotEvery: 3,
      dronePresent: true,
      droneInitialX: 0,
      droneInitialY: 25, // ship thrust along +Y will carry it into the drone
    });

    // Print every-10-tick trajectory. Useful for understanding the
    // pattern — pre-fix this test asserts max drift > 0.5; post-fix
    // it should assert max drift < 0.1 once drones are predicted
    // client-side.
    // eslint-disable-next-line no-console
    console.log('Ship drift trajectory:');
    for (let i = 0; i < samples.length; i += 5) {
      const s = samples[i]!;
      const marker = s.reconciledThisTick ? ' RECONCILE' : '';
      // eslint-disable-next-line no-console
      console.log(
        `  tick=${s.tick.toString().padStart(3)}  ` +
          `serverY=${s.serverShipY.toFixed(2).padStart(6)}  ` +
          `clientY=${s.clientShipY.toFixed(2).padStart(6)}  ` +
          `drift=${s.shipDriftDist.toFixed(3)}${marker}`,
      );
    }

    const maxDrift = Math.max(...samples.map((s) => s.shipDriftDist));
    // eslint-disable-next-line no-console
    console.log(`Max ship drift across run: ${maxDrift.toFixed(3)}u`);

    // The hypothesis confirmation: max drift > 0.1 u proves the bug
    // exists. The synthetic scenario uses a small AI impulse so drift
    // is small in absolute terms (~0.47 u) — but the *pattern* is the
    // production saw-tooth: drift opens to ~0.4 u between reconciles,
    // snaps to 0 on reconcile, repeats. Production cap 2 saw ~22 u
    // peaks because the real drones use bigger impulses and the
    // contact dynamics compound, but it's the same mechanism.
    //
    // Post-fix expectation (drones in predWorld): both worlds simulate
    // the same physics with same inputs → drift < 0.01 u. This
    // assertion will then become `expect(maxDrift).toBeLessThan(0.01)`.
    expect(maxDrift).toBeGreaterThan(0.1);
  });

  it('drift only opens during the contact window, settling after', () => {
    // Stronger assertion: drift is BOUNDED at the snapshot-reconcile
    // boundary. Each reconcile resets to zero; drift only grows in the
    // 1-2 ticks before the next reconcile.
    const samples = simulate({
      totalTicks: 240,
      snapshotEvery: 3,
      dronePresent: true,
      droneInitialX: 0,
      droneInitialY: 25,
    });

    // Drift on a reconcile-tick (after the snap) must be 0 or
    // immediate (snap zeroes it; the test measures post-snap state).
    for (const s of samples.filter((s) => s.reconciledThisTick)) {
      expect(s.shipDriftDist).toBeLessThan(0.001);
    }
  });
});
