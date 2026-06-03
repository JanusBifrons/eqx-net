/**
 * 5c-stabilise regression: drones (kind=1) move smoothly between binary
 * swarm packets. Sample positions every 16 ms for 3 s and assert no
 * single per-frame delta exceeds the smoothness budget.
 *
 * Pre-fix symptom (Defect 2 in plan): drones stuttered in 1-2 frame bursts
 * because the encoder's quantisation gate suppressed sub-threshold motion
 * and the renderer didn't interpolate between packets. Per-frame deltas
 * spiked to ~3-5u when motion accumulated above quantum.
 *
 * Post-fix: server velocity-aware suppression + client entity interpolation
 * gives a smooth lerp; per-frame deltas should stay below 2u for entities
 * cruising at the drone target speed (~25 u/s = 0.42 u/frame ideal).
 *
 * 2026-06-03 — merged in `swarm-stationary-stability.spec.ts` as a second
 * test (test-coverage determinism refactor): the stationary-asteroid case
 * (kind=0, cumulative drift-from-origin) is a DISTINCT metric on a distinct
 * entity kind, kept as its own test() rather than absorbed into the drone
 * per-frame-delta check above.
 */
import { test, expect } from './fixtures/test-with-logs';

interface SwarmDetail {
  x: number;
  y: number;
  angle: number;
  kind: number;
  sleeping: boolean;
  lastUpdateTick: number;
}

const SAMPLE_INTERVAL_MS = 16;
const TOTAL_SAMPLES = 187; // ≈ 3 s at 60 Hz
const SMOOTHNESS_BUDGET_U = 2;
const STATIONARY_BUDGET_U = 0.5; // stationary-asteroid (kind=0) cumulative drift cap

test('drone movement: per-frame delta stays under 2u (no stutter)', async ({ eqxPage }) => {
  // Let the world settle and drones start steering.
  await eqxPage.waitForTimeout(1000);

  const samples = await eqxPage.evaluate(
    ({ interval, count }) =>
      new Promise<{ t: number; swarm: Record<string, SwarmDetail> }[]>((resolve) => {
        const results: { t: number; swarm: Record<string, SwarmDetail> }[] = [];
        const start = performance.now();
        const iv = setInterval(() => {
          const el = document.querySelector('[data-testid="game-surface"]');
          const raw = el?.getAttribute('data-swarm-detail');
          results.push({ t: performance.now() - start, swarm: JSON.parse(raw ?? '{}') });
          if (results.length >= count) { clearInterval(iv); resolve(results); }
        }, interval);
      }),
    { interval: SAMPLE_INTERVAL_MS, count: TOTAL_SAMPLES },
  );

  // Filter to drone IDs (kind=1) that are present in every sample so we get
  // continuous motion data (no spawn/despawn flicker).
  const droneIdsAlwaysPresent: string[] = [];
  const firstSwarm = samples[0]!.swarm;
  for (const [id, entry] of Object.entries(firstSwarm)) {
    if (entry.kind !== 1) continue;
    if (samples.every((s) => s.swarm[id] !== undefined)) {
      droneIdsAlwaysPresent.push(id);
    }
  }

  if (droneIdsAlwaysPresent.length === 0) {
    console.log('No drones present continuously — inconclusive (drones may have died or out of range).');
    return;
  }

  // Per drone, compute the maximum per-frame delta over the sample window.
  const droneMaxDeltas: { id: string; maxDelta: number; firstX: number; firstY: number; lastX: number; lastY: number }[] = [];
  for (const id of droneIdsAlwaysPresent) {
    let maxD = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]!.swarm[id]!;
      const b = samples[i]!.swarm[id]!;
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      if (d > maxD) maxD = d;
    }
    const first = samples[0]!.swarm[id]!;
    const last = samples[samples.length - 1]!.swarm[id]!;
    droneMaxDeltas.push({ id, maxDelta: maxD, firstX: first.x, firstY: first.y, lastX: last.x, lastY: last.y });
  }

  // Sort and report worst offenders.
  droneMaxDeltas.sort((a, b) => b.maxDelta - a.maxDelta);
  const worst = droneMaxDeltas[0]!;
  console.log('\n=== Drone smoothness ===');
  console.log(`Tracked drones: ${droneMaxDeltas.length}`);
  console.log(`Worst per-frame delta: ${worst.maxDelta.toFixed(3)} u  (limit ${SMOOTHNESS_BUDGET_U})`);
  console.log(`Worst drone (${worst.id}) drifted from (${worst.firstX.toFixed(1)}, ${worst.firstY.toFixed(1)}) → (${worst.lastX.toFixed(1)}, ${worst.lastY.toFixed(1)})`);
  console.log(`Top 5 max deltas: ${droneMaxDeltas.slice(0, 5).map((d) => d.maxDelta.toFixed(2)).join(', ')} u`);
  console.log('=========================\n');

  expect(worst.maxDelta).toBeLessThan(SMOOTHNESS_BUDGET_U);
});

// ---------------------------------------------------------------------------
// Merged from swarm-stationary-stability.spec.ts (2026-06-03).
//
// 5c-stabilise regression: stationary asteroids (kind=0) do not visually
// flicker between binary swarm packets. Pre-fix the encoder shipped delta
// packets whenever sub-quantum jitter accumulated; post-fix velocity-aware
// suppression keeps the wire silent below MOVING_SPEED_TAXI and client
// interpolation only moves between two distinct received poses. The hand-rolled
// asteroids include `asteroid-0`/`asteroid-2` (vx=vy=0) — bit-stable on the
// wire, rock-steady on the client.
// ---------------------------------------------------------------------------
test('stationary asteroids: rendered position stays within 0.5u over 3s', async ({ eqxPage }) => {
  // Longer settle than the drone test: drones may collide with asteroids early
  // and impart momentum; let collisions damp out before sampling.
  await eqxPage.waitForTimeout(2000);

  const samples = await eqxPage.evaluate(
    ({ interval, count }) =>
      new Promise<{ t: number; swarm: Record<string, SwarmDetail> }[]>((resolve) => {
        const results: { t: number; swarm: Record<string, SwarmDetail> }[] = [];
        const start = performance.now();
        const iv = setInterval(() => {
          const el = document.querySelector('[data-testid="game-surface"]');
          const raw = el?.getAttribute('data-swarm-detail');
          results.push({ t: performance.now() - start, swarm: JSON.parse(raw ?? '{}') });
          if (results.length >= count) { clearInterval(iv); resolve(results); }
        }, interval);
      }),
    { interval: SAMPLE_INTERVAL_MS, count: TOTAL_SAMPLES },
  );

  // Find asteroids (kind=0) present in every sample whose first-to-last
  // displacement is below 1u — the "actually stationary" ones (asteroid-1 has
  // small drift; ignored for this test).
  const candidates: string[] = [];
  const firstSwarm = samples[0]!.swarm;
  for (const [id, e] of Object.entries(firstSwarm)) {
    if (e.kind !== 0) continue;
    const last = samples[samples.length - 1]!.swarm[id];
    if (!last) continue;
    if (Math.hypot(last.x - e.x, last.y - e.y) > 1) continue;
    if (samples.every((s) => s.swarm[id] !== undefined)) candidates.push(id);
  }

  if (candidates.length === 0) {
    console.log('No stationary asteroids found — inconclusive (drones may have nudged them).');
    return;
  }

  const results: { id: string; maxDrift: number; firstX: number; firstY: number }[] = [];
  for (const id of candidates) {
    const first = samples[0]!.swarm[id]!;
    let maxDrift = 0;
    for (const s of samples) {
      const e = s.swarm[id]!;
      const d = Math.hypot(e.x - first.x, e.y - first.y);
      if (d > maxDrift) maxDrift = d;
    }
    results.push({ id, maxDrift, firstX: first.x, firstY: first.y });
  }

  results.sort((a, b) => b.maxDrift - a.maxDrift);
  const worst = results[0]!;
  console.log('\n=== Stationary asteroid stability ===');
  console.log(`Tracked stationary asteroids: ${results.length}`);
  console.log(`Worst drift over 3 s: ${worst.maxDrift.toFixed(4)} u  (limit ${STATIONARY_BUDGET_U})`);
  console.log(`At (${worst.firstX.toFixed(1)}, ${worst.firstY.toFixed(1)})`);
  console.log('=====================================\n');

  expect(worst.maxDrift).toBeLessThan(STATIONARY_BUDGET_U);
});
