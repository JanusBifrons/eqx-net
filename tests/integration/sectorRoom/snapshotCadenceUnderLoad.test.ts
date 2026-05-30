/**
 * Snapshot cadence under hostile combat load — measures inter-snapshot
 * arrival gaps and asserts no single gap exceeds the recv_gap_long
 * threshold (200 ms) over a sustained combat window.
 *
 * plan: imperative-taco-r2 §P3 (post-pivot to server-side).
 *
 * The phone capture `7k0v95` showed 6 `recv_gap_long` events (230-560 ms
 * inter-snapshot gaps) with ZERO overlap with client-side longtasks. The
 * client was idle during these windows — the SERVER stopped sending. The
 * pattern repeats ~1 per 12-17 s under hostile combat.
 *
 * Root-cause hypothesis: server-side V8 major-GC pauses stall the
 * `setImmediate` tick loop in SectorRoom.ts:1347-1357. The catch-up cap
 * at line 1355 (5 ticks ≈ 83 ms) means any pause longer than 83 ms
 * causes the loop to skip the missed ticks and resume with a single
 * update() — no broadcasts go out during the gap.
 *
 * Test shape: hold-fire combat against 25 hostile drones for 30 s.
 * Record inter-arrival times of `snapshot` messages on a real
 * colyseus.js client. Report distribution (p50, p95, p99, max). Assert
 * **max < 200 ms** (the same threshold the production recv_gap_long
 * detector uses).
 *
 * This test SHOULD FAIL on the current code if server-side GC pauses
 * are the root cause — that's the regression lock per Invariant #13.
 * Once a fix lands (allocation reduction on the server hot path, or
 * V8 flag tuning, or worker-thread broadcast), the test passes.
 *
 * Caveat: this is a HOST-LOAD-SENSITIVE timing test. It will be flaky
 * on a CI runner under heavy load. The threshold (200 ms) is generous —
 * a CLEAN run on quiet host should be well under, often <100 ms p99.
 * If the test passes consistently across reps but the phone still shows
 * recv_gap_long, the node V8 GC heuristics differ from mobile Chrome
 * V8 and the test is missing the real-device pathology — that's
 * acceptable: phone smoke remains the final verdict.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';

describe('snapshot cadence under hostile combat (plan: imperative-taco-r2)', () => {
  let harness: SectorTestHarness | null = null;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
      harness = null;
    }
  });

  it('no inter-snapshot gap exceeds 200 ms over 30 s of held-fire combat against 25 hostile drones', async () => {
    // Boot a real SectorRoom + physics worker + WebSocket transport.
    harness = await bootSectorTestServer({
      droneCount: 25,
      testMode: true,
    });

    // Connect a single player. `startHostile=1` (plan: imperative-taco)
    // pre-marks every drone hostile so the 30 s window is steady-state
    // combat — no IDLE→COMBAT warmup tail.
    const room = await harness.connectAs('test-player', {
      startHostile: true,
      spawnX: 0,
      spawnY: 0,
    });

    // Record inter-arrival times.
    const arrivalTimesMs: number[] = [];
    room.onMessage('snapshot', () => {
      arrivalTimesMs.push(performance.now());
    });

    // Drive combat — thrust input every 16 ms (60 Hz) + a fire message
    // every 167 ms (~6 Hz, weapon-cooldown-friendly). InputMessageSchema
    // is .strict() and `fire` is on a separate FireMessageSchema; sending
    // them mixed would silently drop the whole input via zod.
    let inputTick = 0;
    const inputInterval = setInterval(() => {
      try {
        room.send('input', {
          type: 'input',
          tick: inputTick++,
          thrust: true,
          turnLeft: false,
          turnRight: false,
        });
      } catch { /* room closed mid-test */ }
    }, 16);
    let shotId = 0;
    const fireInterval = setInterval(() => {
      try {
        room.send('fire', {
          type: 'fire',
          tick: inputTick,
          clientShotId: `t${shotId++}`,
          weapon: 'hitscan',
          dirAngle: 0,
        });
      } catch { /* room closed mid-test */ }
    }, 167);

    try {
      // 30 s combat window. Real wall-clock; physics worker drives at
      // 60 Hz, snapshot broadcasts at 20 Hz, so we expect ~600 snapshots.
      await harness.advance(30_000);
    } finally {
      clearInterval(inputInterval);
      clearInterval(fireInterval);
    }

    // Compute inter-arrival gaps. Skip the first arrival (no prior).
    const gapsMs: number[] = [];
    for (let i = 1; i < arrivalTimesMs.length; i++) {
      gapsMs.push(arrivalTimesMs[i]! - arrivalTimesMs[i - 1]!);
    }
    expect(gapsMs.length).toBeGreaterThan(100); // sanity — got plenty of snapshots

    gapsMs.sort((a, b) => a - b);
    const p50 = gapsMs[Math.floor(gapsMs.length * 0.5)]!;
    const p95 = gapsMs[Math.floor(gapsMs.length * 0.95)]!;
    const p99 = gapsMs[Math.floor(gapsMs.length * 0.99)]!;
    const max = gapsMs[gapsMs.length - 1]!;
    const gapsOver200 = gapsMs.filter((g) => g > 200).length;

    // eslint-disable-next-line no-console
    console.log(`Snapshot cadence (${gapsMs.length} gaps over 30 s):`);
    // eslint-disable-next-line no-console
    console.log(`  p50: ${p50.toFixed(1)} ms`);
    // eslint-disable-next-line no-console
    console.log(`  p95: ${p95.toFixed(1)} ms`);
    // eslint-disable-next-line no-console
    console.log(`  p99: ${p99.toFixed(1)} ms`);
    // eslint-disable-next-line no-console
    console.log(`  max: ${max.toFixed(1)} ms`);
    // eslint-disable-next-line no-console
    console.log(`  gaps > 200 ms (recv_gap_long threshold): ${gapsOver200}`);

    // Primary assertion: no recv_gap_long-equivalent events.
    // 200 ms matches `ColyseusClient.ts:998 if (recvGapMs > 200)`.
    expect(max, 'worst inter-snapshot gap (target: ≤ 200 ms)').toBeLessThan(200);
    // Sanity: p99 should be well under the threshold on a healthy server.
    expect(p99, 'p99 inter-snapshot gap (target: ≤ 100 ms)').toBeLessThan(100);
  }, 60_000); // 60 s test timeout (30 s combat + boot/teardown buffer)
});
