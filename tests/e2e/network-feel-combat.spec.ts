/**
 * Autonomous combat repro for the 2026-05-09 network-feel reset plan.
 *
 * Drives a Playwright headless client through ~10 s of close-quarters drone
 * combat in `swarm-soak` with controlled spawn parameters, then reads the
 * client's `__eqxLogs` ring buffer and asserts on bounded metrics. This
 * replaces the manual smoke-test loop that produced 8 commits without
 * resolving the felt-feel issues — now every fix gets a deterministic
 * data-backed verification.
 *
 * The acceptance bounds below describe the post-architectural-fix target
 * (drones predicted client-side via deterministic AI). Currently the test
 * **FAILS** on `main` — that's deliberate: it locks in the failing
 * baseline so any future fix has a measurable bar to clear.
 *
 * Repro scenario (deterministic by design):
 *   1. URL params spawn the client into `swarm-soak` with 8 drones (no
 *      asteroids) within 300 u of origin. Drones immediately AI-pursue.
 *   2. Hold thrust for 8 s, fire continuously via `Space`, alternating
 *      turn-left / turn-right every 200 ms to provoke close-quarters
 *      manoeuvring.
 *   3. Read `window.__eqxLogs` snapshot + correction events, compute
 *      diagnostic metrics, assert.
 *
 * Run via:
 *   pnpm e2e --project=chromium tests/e2e/network-feel-combat.spec.ts --reporter=line
 */
import { test, expect } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

interface LogEntry {
  ts: number;
  tag: string;
  data: Record<string, unknown>;
}

interface CombatMetrics {
  snapshots: number;
  corrections: number;
  corrRate: number;
  maxDrift: number;
  stuckOffsets: Record<number, number>;
  ticksAheadP99: number;
  ticksAheadMax: number;
  rttMin: number;
  rttMax: number;
  intervalP99: number;
}

function computeMetrics(logs: LogEntry[]): CombatMetrics {
  const snapshots = logs.filter((l) => l.tag === 'snapshot');
  const corrections = logs.filter((l) => l.tag === 'correction');

  const drifts = corrections.map((c) => Number(c.data['driftUnits'] ?? 0));
  const offsets = snapshots.map(
    (s) => Number(s.data['serverTick'] ?? 0) - Number(s.data['ackedTick'] ?? 0),
  );
  const ticksAhead = snapshots.map((s) => Number(s.data['ticksAhead'] ?? 0));
  const rtts = snapshots.map((s) => Number(s.data['rttMs'] ?? 0));
  const intervals = snapshots
    .map((s) => Number(s.data['intervalMs'] ?? 0))
    .filter((x) => x > 0);

  const taSorted = [...ticksAhead].sort((a, b) => a - b);
  const intSorted = [...intervals].sort((a, b) => a - b);

  // Group offsets that occur ≥ 5 times — those are the "stuck" states.
  // Healthy: +1 dominant, occasional +2/+3. The 2026-05-09 anomaly was
  // 35 snapshots stuck at +11.
  const offsetHist: Record<number, number> = {};
  for (const o of offsets) offsetHist[o] = (offsetHist[o] ?? 0) + 1;
  const stuckOffsets: Record<number, number> = {};
  for (const [k, v] of Object.entries(offsetHist)) {
    if (v >= 5 && Math.abs(Number(k)) >= 5) stuckOffsets[Number(k)] = v;
  }

  return {
    snapshots: snapshots.length,
    corrections: corrections.length,
    corrRate: snapshots.length > 0 ? corrections.length / snapshots.length : 0,
    maxDrift: drifts.length > 0 ? Math.max(...drifts) : 0,
    stuckOffsets,
    ticksAheadP99: taSorted.length > 0 ? taSorted[Math.floor(taSorted.length * 0.99)]! : 0,
    ticksAheadMax: ticksAhead.length > 0 ? Math.max(...ticksAhead) : 0,
    rttMin: rtts.length > 0 ? Math.min(...rtts) : 0,
    rttMax: rtts.length > 0 ? Math.max(...rtts) : 0,
    intervalP99: intSorted.length > 0 ? intSorted[Math.floor(intSorted.length * 0.99)]! : 0,
  };
}

// Override the project-default 30 s timeout via describe.configure — the
// per-test `{ timeout }` option doesn't always win against the playwright.config
// default reliably (depends on retry path), so describe-level is the
// belt-and-braces approach.
test.describe.configure({ timeout: 60_000 });

test('network feel: sustained drone combat stays within bounded drift', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Surface server-side / client-side console errors in the test log.
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.log(`    [browser ${msg.type()}] ${msg.text()}`);
    }
  });

  // Spawn into `swarm-soak` with 8 drones, no asteroids, drones within 300 u of origin.
  // swarmRatio=1.0 means 100 % drones, 0 % asteroids — isolates the drone-AI seam.
  const params = new URLSearchParams({
    room: 'swarm-soak',
    swarmCount: '8',
    swarmRatio: '1.0',
    swarmRadius: '300',
    spawnX: '0',
    spawnY: '0',
  });
  await page.goto(`${BASE_URL}?${params}`);

  // Wait for ship to spawn (data-testid="ship-count" goes from 0 to ≥ 1).
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 15_000 },
  );

  // Let drones spawn and the AI start pursuing.
  await page.waitForTimeout(800);

  // Clear any logs accumulated during spawn so the metrics reflect combat only.
  await page.evaluate(() => { (window as { __eqxClearLogs?: () => void }).__eqxClearLogs?.(); });

  // Drive combat: thrust + continuous fire, alternating turn every 500 ms.
  // 4 s of combat → ~80 snapshots @ 20 Hz, exercising the drone-AI contact
  // loop. Each `waitForTimeout` is a Playwright round-trip; minimising the
  // count keeps the test inside the project's 60 s timeout including browser
  // launch and trace teardown.
  await page.keyboard.down('w');
  await page.keyboard.down('Space');
  for (let i = 0; i < 8; i++) {
    const turnKey = i % 2 === 0 ? 'a' : 'd';
    await page.keyboard.down(turnKey);
    await page.waitForTimeout(500);
    await page.keyboard.up(turnKey);
  }
  await page.keyboard.up('w').catch(() => undefined);
  await page.keyboard.up('Space').catch(() => undefined);

  // Settle one tick so the final snapshot lands.
  await page.waitForTimeout(200);

  // Pull the log ring buffer, compute metrics, log them, assert.
  const logs: LogEntry[] = await page.evaluate(() =>
    (window as { __eqxLogs?: LogEntry[] }).__eqxLogs ?? [],
  );

  const m = computeMetrics(logs);

  console.log('\n=== Network-feel combat metrics ===');
  console.log(`  snapshots:        ${m.snapshots}`);
  console.log(`  corrections:      ${m.corrections}`);
  console.log(`  corr rate:        ${(m.corrRate * 100).toFixed(1)}%`);
  console.log(`  max drift:        ${m.maxDrift.toFixed(2)} u`);
  console.log(`  ticksAhead p99:   ${m.ticksAheadP99}`);
  console.log(`  ticksAhead max:   ${m.ticksAheadMax}`);
  console.log(`  RTT range:        ${m.rttMin}–${m.rttMax} ms`);
  console.log(`  interval p99:     ${m.intervalP99.toFixed(1)} ms`);
  console.log(`  stuck offsets:    ${JSON.stringify(m.stuckOffsets)}`);
  console.log('====================================\n');

  // ----- Sanity gates -----
  // We must have actually exercised the system. If snapshots are very low,
  // something else is broken (server didn't accept join, network died, etc.).
  expect(m.snapshots).toBeGreaterThan(50);

  // ----- Acceptance bounds (post-fix targets) -----
  // These will FAIL on current `main` and that's the point — they're the bar
  // the architectural fix has to clear.
  //
  // Each bound has a documented current-baseline value from the latest
  // diagnostic captures (cap 2026-05-09T10-58-51-702Z-0qzh3d) — keep these
  // up to date so future readers can see the trend.

  // Max drift bound: post-fix expectation is < 5 u. Current baseline 64 u.
  expect(m.maxDrift).toBeLessThan(5);

  // Correction rate: post-fix expectation < 5 %. Current baseline 6 %.
  expect(m.corrRate).toBeLessThan(0.05);

  // Stuck-offset anomaly: any |offset| ≥ 5 occurring ≥ 5 times indicates
  // either the input-gate stalling (`+11` cluster) or another systemic bug.
  // Current baseline: 35 snapshots stuck at +11. Post-fix expectation: zero.
  expect(Object.keys(m.stuckOffsets)).toHaveLength(0);

  // ticksAhead p99 < 10. With healthy RTT (< 50 ms wired) and leadTicks
  // settled at ~6, the 99th percentile of ticksAhead should be ≤ 9.
  expect(m.ticksAheadP99).toBeLessThan(10);

  await ctx.close();
});
