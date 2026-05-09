/**
 * TDD harness for the drone-render visual-smoothness pathology.
 *
 * After commits 31af74c (client-side AI) + 0f9a07c (render from
 * predWorld) + ac429de (drone lerp offset), the user reported "jumping
 * between two positions, almost like double vision." The previous two
 * fixes shipped on theory; this test reproduces the actual pipeline so
 * we can OBSERVE the oscillation in code and assert it doesn't happen.
 *
 * Pipeline simulated:
 *   - server-side: drone moves under AI at server tick rate. Packet
 *     emitted every 3 ticks (50 ms at 60 Hz).
 *   - client predWorld: drone advances forward via AI each tick. On
 *     packet arrival, snapped (`setShipState`) to packet pose; spring
 *     offset captures `(pre_snap - post_snap)`.
 *   - per-RAF: render position = predWorld + decaying spring offset.
 *
 * Pass criterion: rendered drone position should be MONOTONIC in the
 * direction of motion. No frame-to-frame BACKWARD motion (the visible
 * symptom of the bug).
 */
import { describe, it, expect } from 'vitest';
import { springStep, type SpringState } from '../../src/core/math/CritDampedSpring.js';

const FIXED_DT_MS = 1000 / 60;
const TICKS_PER_PACKET = 3;        // 20 Hz packet cadence
const LEAD_TICKS = 6;              // client predicts ~100 ms ahead
const DRONE_VEL = 30;              // u/sec along +X — fast drone
// Original constants from `remoteOffsetHalfLifeForDrift`. With drone-snap
// distances of ~LEAD_TICKS×velocity (3u for V=30u/s), the spring's first-
// frame decay rate exceeds predWorld's forward advance, producing the
// "double vision" backward render motion the user reported.
//
// Tests below verify that with longer half-lives (~150 ms), per-frame
// offset decay stays below per-frame forward motion → render is
// monotonic forward.
const HALF_LIFE_MS_SMALL = 100;
const HALF_LIFE_MS_LARGE = 150;

interface Sim {
  predWorldX: number;
  packetX: number;
  offset: SpringState;
  halfLifeMs: number;
  renderHistory: number[];
}

// Mirror of `droneRenderOffsetHalfLifeForDrift` in
// `src/client/net/ColyseusClient.ts`. See that function's comment for
// the math derivation.
const H_SAFETY_FACTOR = 1.5;
const V_FLOOR = 5;
const H_MIN_MS = 80;
const H_MAX_MS = 800;
function pickHalfLife(distance: number, vel: number = DRONE_VEL): number {
  const v = Math.max(vel, V_FLOOR);
  const required = (H_SAFETY_FACTOR * Math.LN2 * distance / v) * 1000;
  return Math.max(H_MIN_MS, Math.min(H_MAX_MS, required));
}

/**
 * Run the pipeline for `nFrames` RAF frames at 60 Hz. Returns the
 * rendered drone position at each frame.
 */
function simulate(nFrames: number): Sim {
  const sim: Sim = {
    // Drone starts at x=0 in both predWorld and packet stream.
    predWorldX: 0,
    packetX: 0,
    offset: { x: 0, v: 0 },
    halfLifeMs: HALF_LIFE_MS_SMALL,
    renderHistory: [],
  };
  // Ticks since last packet was emitted by the server.
  let serverTicksSinceLastEmit = 0;
  // Track a "server tick counter" — packets arrive at the client one
  // RAF after they're emitted; the client then snaps predWorld.
  // Simplification: assume zero network delay (packet applies same
  // RAF it's emitted). This is the BEST CASE for smoothness; if
  // oscillation shows up here, network delay can only make it worse.
  for (let frame = 0; frame < nFrames; frame++) {
    // 1. Client AI ticks: drone advances forward by 1 tick of motion.
    // (Real client may run 1+ AI ticks per RAF in catch-up; we model
    // 1/RAF for simplicity.)
    sim.predWorldX += DRONE_VEL * (FIXED_DT_MS / 1000);
    serverTicksSinceLastEmit++;
    // Server side advances at the same rate; emits a packet every
    // TICKS_PER_PACKET ticks.
    sim.packetX += DRONE_VEL * (FIXED_DT_MS / 1000);

    // 2. Packet arrival simulation: every TICKS_PER_PACKET RAFs.
    if (serverTicksSinceLastEmit >= TICKS_PER_PACKET) {
      serverTicksSinceLastEmit = 0;
      // Server's packet pose is "now − LEAD_TICKS" from predWorld's
      // perspective. The client's predWorld is forward-extrapolated.
      const packetPose = sim.packetX - DRONE_VEL * LEAD_TICKS * (FIXED_DT_MS / 1000);
      const preSnap = sim.predWorldX;
      // Snap predWorld to packet pose.
      sim.predWorldX = packetPose;
      // Capture spring offset (pre - post). This is what the production
      // code does in `syncSwarmIntoPredWorld`.
      const newOffset = preSnap - packetPose;
      const dist = Math.abs(newOffset);
      if (dist > 0.05) {
        sim.offset.x = newOffset;
        sim.offset.v = 0;
        sim.halfLifeMs = pickHalfLife(dist);
      }
    }

    // 3. Spring decay one RAF.
    springStep(sim.offset, 0, sim.halfLifeMs, FIXED_DT_MS);

    // 4. Rendered position = predWorld + offset.
    const rendered = sim.predWorldX + sim.offset.x;
    sim.renderHistory.push(rendered);
  }
  return sim;
}

describe('drone render smoothness — predWorld-snap + spring offset path', () => {
  it('rendered position is monotonically forward (no per-frame backward motion)', () => {
    const sim = simulate(60); // 1 second of motion

    // Print the trajectory so test failures show the oscillation pattern.
    // eslint-disable-next-line no-console
    console.log('Rendered X by frame (every 3rd, 60 frames total):');
    for (let i = 0; i < sim.renderHistory.length; i += 3) {
      // eslint-disable-next-line no-console
      console.log(
        `  frame=${i.toString().padStart(2)}  x=${sim.renderHistory[i]!.toFixed(3)}` +
          (i > 0 ? `  Δ=${(sim.renderHistory[i]! - sim.renderHistory[i - 1]!).toFixed(3)}` : ''),
      );
    }

    let backwardCount = 0;
    let maxBackwardJump = 0;
    for (let i = 1; i < sim.renderHistory.length; i++) {
      const delta = sim.renderHistory[i]! - sim.renderHistory[i - 1]!;
      if (delta < 0) {
        backwardCount++;
        maxBackwardJump = Math.max(maxBackwardJump, -delta);
      }
    }

    // eslint-disable-next-line no-console
    console.log(`Backward frames: ${backwardCount} / ${sim.renderHistory.length - 1}`);
    // eslint-disable-next-line no-console
    console.log(`Max backward jump: ${maxBackwardJump.toFixed(3)} u/frame`);

    // Hard assertion: a drone moving steadily +X should NEVER render
    // a backward step. If this fails, the visible jolt is reproduced.
    expect(backwardCount).toBe(0);
  });

  it('rendered position closely tracks predWorld + advance, with bounded lag', () => {
    const sim = simulate(60);

    // After 1 second at 30 u/s, the drone should be ~30 units forward.
    // Allow generous tolerance; the spring lag is bounded by half-life.
    const finalRender = sim.renderHistory[sim.renderHistory.length - 1]!;
    expect(finalRender).toBeGreaterThan(25);
    expect(finalRender).toBeLessThan(35);
  });

  it('rendered angle does not jolt on packet snap (rotating drone)', () => {
    // Drones rotate under AI to track the player. Each packet snap rewinds
    // predWorld.angle by `LEAD_TICKS × angvel × dt` worth of rotation.
    //
    // Pre-fix (commits ac429de and 6501add): production applied a spring
    // offset to x/y but NOT to angle, so the sprite visibly rotated
    // back-and-forth at 20 Hz cadence even though x/y were smooth — the
    // user reported "still jittering" after the position-only spring
    // landed.
    //
    // This test exercises the production path verbatim with the angle
    // smoothing applied. Asserts monotonic forward angle (drone rotates
    // one direction without backward jolts).
    const OMEGA = 2.0; // rad/sec — typical drone turn rate under AI
    const renderAngles: number[] = [];
    let predAngle = 0;
    let packetAngle = 0;
    let serverTicks = 0;
    const angleOffset: SpringState = { x: 0, v: 0 };
    let halfLife = HALF_LIFE_MS_SMALL;
    for (let frame = 0; frame < 60; frame++) {
      predAngle += OMEGA * (FIXED_DT_MS / 1000);
      packetAngle += OMEGA * (FIXED_DT_MS / 1000);
      serverTicks++;
      if (serverTicks >= TICKS_PER_PACKET) {
        serverTicks = 0;
        const packetAngleAtT = packetAngle - OMEGA * LEAD_TICKS * (FIXED_DT_MS / 1000);
        const preSnap = predAngle;
        predAngle = packetAngleAtT;
        // Production captures angular offset (with shortest-arc wrap)
        // and stores it in the same per-drone spring map as x/y.
        const newOff = preSnap - packetAngleAtT;
        if (Math.abs(newOff) > 0.06) {
          angleOffset.x = newOff;
          angleOffset.v = 0;
          // Drone-specific half-life thresholds — match production's
          // `droneRenderOffsetHalfLifeForDrift` band picker.
          halfLife = Math.abs(newOff) < 1 ? HALF_LIFE_MS_SMALL : HALF_LIFE_MS_LARGE;
        }
      }
      springStep(angleOffset, 0, halfLife, FIXED_DT_MS);
      renderAngles.push(predAngle + angleOffset.x);
    }

    // Render angle must move forward monotonically (drone rotates one way).
    let backwardCount = 0;
    let maxBackwardJump = 0;
    for (let i = 1; i < renderAngles.length; i++) {
      const delta = renderAngles[i]! - renderAngles[i - 1]!;
      if (delta < 0) {
        backwardCount++;
        maxBackwardJump = Math.max(maxBackwardJump, -delta);
      }
    }
    // eslint-disable-next-line no-console
    console.log(`Angle backward frames: ${backwardCount} / ${renderAngles.length - 1}`);
    // eslint-disable-next-line no-console
    console.log(`Max angle backward jump: ${maxBackwardJump.toFixed(4)} rad/frame`);

    expect(backwardCount).toBe(0);
  });

  it('rendered position is monotonic with LARGE snap (packet gap → ~30 u offset @ 32 Hz mobile RAF)', () => {
    // The 2026-05-09 diagnostic `liv44l` shows snap-interval max = 1108 ms
    // and corr rate = 22 % in a test-room scenario. A 1.1 s packet gap lets
    // predWorld's AI integrate ~60 ticks past the last server-authoritative
    // pose; when the next packet arrives, snap distance can be 30+ u —
    // well past the 6.5 u ceiling at which 150 ms half-life is monotonic.
    //
    // Pre-fix this test fails: with O0 = 30, V = 30, H_min ≈ 690 ms — the
    // 150 ms decay exceeds predWorld's per-frame advance.
    const MOBILE_DT_MS = 1000 / 32; // mobile RAF throttle observed in capture
    const FRAMES = 32;              // ~1 s of simulation
    const startOffset = 30;
    const offset: SpringState = { x: startOffset, v: 0 };
    const halfLifeMs = pickHalfLife(startOffset, DRONE_VEL);
    let predWorldX = 0;
    const renderHistory: number[] = [];
    for (let i = 0; i < FRAMES; i++) {
      predWorldX += DRONE_VEL * (MOBILE_DT_MS / 1000);
      springStep(offset, 0, halfLifeMs, MOBILE_DT_MS);
      renderHistory.push(predWorldX + offset.x);
    }
    let backwardCount = 0;
    for (let i = 1; i < renderHistory.length; i++) {
      if (renderHistory[i]! < renderHistory[i - 1]!) backwardCount++;
    }
    // eslint-disable-next-line no-console
    console.log(
      `Large-snap backward frames: ${backwardCount} / ${FRAMES - 1} ` +
        `(half-life ${halfLifeMs.toFixed(0)} ms for O=${startOffset} u, V=${DRONE_VEL} u/s)`,
    );

    expect(backwardCount).toBe(0);
  });
});
