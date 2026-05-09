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

function pickHalfLife(distance: number): number {
  return distance < 0.5 ? HALF_LIFE_MS_SMALL : HALF_LIFE_MS_LARGE;
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
});
