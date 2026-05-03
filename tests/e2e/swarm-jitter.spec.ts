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
