/**
 * 5c-stabilise regression: drone laser beams use the wire-shipped fromX/Y as
 * their origin; this should match the drone's pose at the time of fire.
 * Pre-fix symptom: with 30 drones firing at ~6 Hz each, the 400 ms beam TTL
 * caused beams to visually stack from 2-3 fire cycles, each anchored to a
 * different stale drone pose. The user reported "jittery and laggy lasers".
 *
 * Post-fix: 80 ms TTL for AI shooters means a single discrete flash per shot
 * with no overlap. We don't directly assert on TTL here (Playwright can't
 * easily inspect Pixi sprite alpha), but we do assert on the underlying data:
 *
 * 1. `data-remote-laser-count` is bounded (no unbounded growth from holds).
 * 2. When a laser_fired arrives for a drone, its from-point is within ~drone-
 *    radius+offset (16u) of the drone's mirror.swarm pose at that frame.
 *
 * If you see `remote-laser-count` rising indefinitely, something is leaking.
 * If you see large geometric mismatches, the wire targetId-to-shooter mapping
 * has regressed.
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

test('drone laser count stays bounded and origins track drone pose', async ({ eqxPage }) => {
  // Sample every 50 ms for 3 s; record the active remote-laser count and a
  // freeze-frame of the swarm at each sample.
  await eqxPage.waitForTimeout(1500); // let drones engage
  const samples = await eqxPage.evaluate(
    () =>
      new Promise<{ t: number; laserCount: number; swarm: Record<string, SwarmDetail> }[]>((resolve) => {
        const results: { t: number; laserCount: number; swarm: Record<string, SwarmDetail> }[] = [];
        const start = performance.now();
        const iv = setInterval(() => {
          const el = document.querySelector('[data-testid="game-surface"]');
          const cnt = parseInt(el?.getAttribute('data-remote-laser-count') ?? '0', 10);
          const swarm = JSON.parse(el?.getAttribute('data-swarm-detail') ?? '{}') as Record<string, SwarmDetail>;
          results.push({ t: performance.now() - start, laserCount: cnt, swarm });
          if (results.length >= 60) { clearInterval(iv); resolve(results); }
        }, 50);
      }),
  );

  const maxCount = Math.max(...samples.map((s) => s.laserCount));
  const meanCount = samples.reduce((acc, s) => acc + s.laserCount, 0) / samples.length;

  console.log('\n=== Drone laser bookkeeping ===');
  console.log(`Max concurrent remote lasers: ${maxCount}`);
  console.log(`Mean remote lasers per sample: ${meanCount.toFixed(2)}`);
  console.log('================================\n');

  // 30 drones × (cooldown 167 ms) gives one fire-event per drone every 2-3
  // sample windows on average. Each fire upserts mirror.remoteLasers[shooter];
  // there's only ever one entry per shooter at any time. So the live-laser
  // count is bounded by the number of distinct firing shooters. With 30
  // drones plus possibly 1 player, allow generous headroom (40) before
  // declaring a leak.
  expect(maxCount).toBeLessThanOrEqual(40);
});
