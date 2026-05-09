/**
 * Hypothesis test for the 2026-05-09 combat-phase correction-burst
 * pathology (cap `2026-05-09T09-54-45-849Z-8grdi1` and earlier).
 *
 * After all four prior network-feel fixes the input-prediction loop is
 * provably correct (cap 1 had 0 corrections in 226 snapshots) but cap 2
 * still showed ~13% corrections during combat. The remaining drift
 * clusters around drone proximity events.
 *
 * Architecture (per `src/client/CLAUDE.md` and the actual code in
 * `ColyseusClient.syncSwarmIntoPredWorld()`):
 *
 *   - Server: drones are dynamic Rapier bodies. AI impulses move
 *     them. They collide with the player ship freely.
 *   - Client: drones ARE in predWorld (so the local ship can collide
 *     with them) but are LOCKED via `lockBody()`. Their pose is set
 *     directly from binary swarm packets (every snapshot) — they
 *     don't integrate under physics. The lock is to prevent
 *     reconciler replay from drifting them between authoritative
 *     packets.
 *
 * The drift mechanism this test exercises:
 *
 *   1. Server's drone moves under AI impulse continuously. By the
 *      next snapshot it has moved Δ units from where the client
 *      thinks it is (since the client locks the drone at the last
 *      snapshot's pose).
 *   2. When the player ship contacts the drone, the contact happens
 *      at server-drone-pos on the server side and at client-drone-pos
 *      (= last-snapshot drone pos) on the client side. Different
 *      contact geometry → different post-collision player velocity.
 *   3. Additionally, the client's drone is LOCKED (effectively
 *      infinite mass), so the entire collision impulse goes into the
 *      player. The server's drone is free, so the impulse splits
 *      between drone and player. Different mass models → different
 *      post-collision velocities even with identical contact geometry.
 *   4. Drift accumulates each tick of contact, gets reconciled at
 *      next snapshot, repeats. Saw-tooth pattern matches the captures.
 *
 * Possible fixes:
 *   A. Don't lock drones on the client; let them integrate with
 *      inertia between snapshots. Bigger between-snapshot desync
 *      possible, but collision mass model matches server.
 *   B. Sync drone state more frequently (every tick instead of every
 *      snapshot) — bandwidth cost.
 *   C. Broadcast AI_INTENT impulses to clients alongside or instead
 *      of just the drone state — client applies the same impulse,
 *      drone stays in sync between snapshots.
 *   D. Don't simulate drone-vs-player collision client-side at all;
 *      handle drone contacts as discrete events (collision_resolved
 *      already broadcasts post-collision velocities — fix that path
 *      to also adjust position).
 *
 * Pure simulation; runs in vitest with Rapier WASM init in beforeAll.
 * No browser, no server, no manual smoke. Re-runnable.
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
 * The server world contains the player + a free dynamic drone that
 * AI impulses push every tick. The client world contains the player
 * + a LOCKED drone whose pose is snapped from the server every
 * snapshotEvery ticks (matching production's `syncSwarmIntoPredWorld`).
 *
 * @param totalTicks       Number of physics steps to run.
 * @param snapshotEvery    Reconcile client + sync drone pose every N ticks.
 * @param dronePresent     If false, no drone in either world. Control case.
 * @param droneInitialY    Drone spawn y (above ship; ship thrusts +Y into it).
 * @param clientDroneLocked If true (production behaviour), client drone is
 *                          `lockBody()`-locked and only updates on snapshots.
 *                          If false, client drone is dynamic and integrates
 *                          freely between snapshots — used to test option A
 *                          ("don't lock drones") without needing the fix
 *                          to be implemented in production yet.
 */
function simulate(opts: {
  totalTicks: number;
  snapshotEvery: number;
  dronePresent: boolean;
  droneInitialY?: number;
  clientDroneLocked?: boolean;
}): DriftSample[] {
  serverWorld.despawnShip('player');
  serverWorld.despawnShip('drone');
  clientWorld.despawnShip('player');
  clientWorld.despawnShip('drone');

  serverWorld.spawnShip('player', 0, 0);
  clientWorld.spawnShip('player', 0, 0);

  const dy = opts.droneInitialY ?? 25;
  if (opts.dronePresent) {
    serverWorld.spawnObstacle('drone', 0, dy, 18, 5);
    clientWorld.spawnObstacle('drone', 0, dy, 18, 5);
    if (opts.clientDroneLocked !== false) {
      clientWorld.lockBody('drone');
    }
  }

  const samples: DriftSample[] = [];

  for (let tick = 0; tick < opts.totalTicks; tick++) {
    serverWorld.applyInput('player', { thrust: true, turnLeft: false, turnRight: false });
    clientWorld.applyInput('player', { thrust: true, turnLeft: false, turnRight: false });

    if (opts.dronePresent) {
      serverWorld.applyImpulse('drone', 0, -3.0, 0);
    }

    serverWorld.tick(1 / 60);
    clientWorld.tick(1 / 60);

    let reconciledThisTick = false;
    if ((tick + 1) % opts.snapshotEvery === 0) {
      const serverPlayer = serverWorld.getShipState('player');
      if (serverPlayer) {
        clientWorld.setShipState('player', serverPlayer);
        reconciledThisTick = true;
      }
      // Sync drone pose from server to client (this is what
      // syncSwarmIntoPredWorld does on every binary swarm packet).
      if (opts.dronePresent) {
        const serverDrone = serverWorld.getShipState('drone');
        if (serverDrone) clientWorld.setShipState('drone', serverDrone);
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

describe('drone-vs-player collision: locked-drone-pose-mismatch drift', () => {
  it('control: with no drone in either world, the two stay in lockstep', () => {
    // Sanity: identical inputs, no asymmetry, must produce zero drift.
    const samples = simulate({ totalTicks: 120, snapshotEvery: 3, dronePresent: false });

    const maxDrift = Math.max(...samples.map((s) => s.shipDriftDist));
    expect(maxDrift).toBeLessThan(0.01);
  });

  it('production architecture (locked client drone): drift opens between snapshots when drone is moving', () => {
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
      droneInitialY: 25, // ship thrust along +Y will carry it into the drone
      clientDroneLocked: true, // matches production
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

    // Hypothesis confirmation: drift > 0.02 u shows the saw-tooth
    // pattern is real even with the production locked-drone
    // architecture. Magnitude is small in this synthetic scenario
    // (~0.06 u) because the AI impulse is gentle and there's only
    // one drone. Production cap 2 sees ~22 u peaks under aggressive
    // drone behaviours, multi-drone contacts, and replay-amplified
    // divergence (each reconciler replay tick re-processes the
    // collision against the stale-locked drone).
    //
    // Post-fix expectation: drift drops sub-noise (< 0.01 u). The
    // assertion will then flip to `toBeLessThan(0.01)`.
    expect(maxDrift).toBeGreaterThan(0.02);
  });

  it('drift only opens between reconcile-ticks, snaps to 0 on each reconcile', () => {
    const samples = simulate({
      totalTicks: 240,
      snapshotEvery: 3,
      dronePresent: true,
      droneInitialY: 25,
      clientDroneLocked: true,
    });

    for (const s of samples.filter((s) => s.reconciledThisTick)) {
      expect(s.shipDriftDist).toBeLessThan(0.001);
    }
  });

  it('FIX (drones unlocked in client predWorld) reduces drift below the locked baseline', () => {
    // The shipped fix in `ColyseusClient.syncSwarmIntoPredWorld()`:
    // drones (kind=1) are no longer `lockBody()`-locked. They stay
    // dynamic so collision response uses the same mass model as the
    // server's; binary-swarm-packet snaps still keep their pose in
    // line with server authority on every snapshot.
    //
    // Asteroids (kind=0) remain locked for the original 5c-stabilise
    // reason: they're static on the server, and locking them stops
    // the player from pushing them out of pose during replay.
    const lockedSamples = simulate({
      totalTicks: 240,
      snapshotEvery: 3,
      dronePresent: true,
      droneInitialY: 25,
      clientDroneLocked: true,
    });
    const unlockedSamples = simulate({
      totalTicks: 240,
      snapshotEvery: 3,
      dronePresent: true,
      droneInitialY: 25,
      clientDroneLocked: false,
    });

    const lockedPeak = Math.max(...lockedSamples.map((s) => s.shipDriftDist));
    const unlockedPeak = Math.max(...unlockedSamples.map((s) => s.shipDriftDist));

    // eslint-disable-next-line no-console
    console.log(
      `Locked drone peak drift: ${lockedPeak.toFixed(3)}u; ` +
        `unlocked: ${unlockedPeak.toFixed(3)}u; ` +
        `reduction: ${((1 - unlockedPeak / lockedPeak) * 100).toFixed(0)}%`,
    );

    // Lock-in: unlocked must be measurably better. ~50% reduction
    // observed; assert at least 30% to leave headroom for floating-
    // point noise from Rapier across versions.
    expect(unlockedPeak).toBeLessThan(lockedPeak * 0.7);
  });
});
