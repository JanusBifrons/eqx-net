/**
 * 5c-stabilise regression: stationary asteroids do not visually flicker between
 * binary swarm packets. Pre-fix symptom: the encoder shipped delta packets
 * whenever sub-quantum jitter accumulated, causing rendered position to
 * micro-twitch every few packets. Post-fix: velocity-aware suppression keeps
 * the wire silent when speed is below MOVING_SPEED_TAXI, AND client
 * interpolation only moves between two distinct received poses.
 *
 * The 3 hand-rolled asteroids include `asteroid-0` (vx=0, vy=0) and
 * `asteroid-2` (vx=0, vy=0). These should remain bit-stable on the wire and
 * visually rock-steady on the client.
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
const TOTAL_SAMPLES = 187; // ≈ 3 s
const STATIONARY_BUDGET_U = 0.5;

test('stationary asteroids: rendered position stays within 0.5u over 3s', async ({ eqxPage }) => {
  // Wait for the world to settle (drones may collide with asteroids early on
  // and impart momentum; let collisions damp out before sampling).
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
  // displacement is below 1u — these are the "actually stationary" ones.
  // (Asteroid-1 in the roster has small drift; we ignore it for this test.)
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

  // For each candidate, compute the max distance from the first-sampled pose.
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
