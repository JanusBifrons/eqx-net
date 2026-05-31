/**
 * Standalone probe for the recv_gap_long server-dispatch theory
 * (Task #24, capture `hlqxy6` — `recv_gap_long` 227-461 ms 6× over
 * 130 s session). Pair analysis showed:
 *   server-send Δ between consecutive long-gap events ≈ client-recv Δ
 * So the gap is at the server dispatch (NOT network).
 *
 * Procedure:
 *   1. Assumes dev servers are running on localhost:2567 / :5173.
 *   2. Drives a Playwright session into galaxy-sol-prime, held-fire
 *      for 20 s (matches the captured workload).
 *   3. Fetches `/dev/events` and dumps `tick_hitch` + `tick_budget`
 *      entries. tick_hitch fires for any update() > 12 ms (rate-limited
 *      to 250 ms intervals).
 *
 * Run: `pnpm tsx tests/diag/server-dispatch-gap-probe.ts`
 * (NOT a vitest / playwright spec — direct invocation).
 */
import { chromium } from '@playwright/test';

const BASE = process.env['BASE'] ?? 'http://localhost:5173';
const SERVER = process.env['SERVER'] ?? 'http://localhost:2567';
const FIRE_S = 20;

interface ServerEvent { ts: number; tag: string; data: Record<string, unknown> }

async function main(): Promise<void> {
  // 1. Clear server events.
  await fetch(`${SERVER}/dev/events/clear`, { method: 'POST' }).catch(() => {});

  // 2. Boot Playwright session.
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const params = new URLSearchParams({
    diag: '1',
    testId: `dispatch-probe-${Date.now()}`,
  });
  await page.goto(`${BASE}/?room=galaxy-sol-prime&${params}`);

  // Wait for handshake.
  await page.waitForFunction(
    () => document.querySelector('[data-loading-active="0"]') !== null,
    { timeout: 20_000 },
  );

  // 3. Drive 20 s of activity (LW bots will attack).
  await page.keyboard.down('w'); // thrust to wake the sector
  await page.keyboard.down('Space'); // hold fire
  console.log(`[probe] driving combat for ${FIRE_S}s …`);
  await page.waitForTimeout(FIRE_S * 1000);
  await page.keyboard.up('w');
  await page.keyboard.up('Space');

  // 4. Fetch server events.
  const resp = await fetch(`${SERVER}/dev/events?limit=500`);
  const json = (await resp.json()) as { events: ServerEvent[] };
  await browser.close();

  const hitches = json.events.filter((e) => e.tag === 'tick_hitch');
  const budgets = json.events.filter((e) => e.tag === 'tick_budget');
  const sortedHitches = [...hitches].sort(
    (a, b) => (b.data['totalMs'] as number) - (a.data['totalMs'] as number),
  );

  console.log(`\n=== tick_hitch count: ${hitches.length} (over 12 ms threshold, rate-limited 1/250 ms) ===\n`);
  for (const h of sortedHitches.slice(0, 15)) {
    const phases = h.data['phases'] as Record<string, number>;
    const top = Object.entries(phases)
      .filter(([k]) => k !== 'total')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, v]) => `${k}=${v.toFixed(1)}`)
      .join(', ');
    console.log(
      `tick=${h.data['serverTick']} total=${(h.data['totalMs'] as number).toFixed(1)} ms `
      + `workerTick=${(h.data['workerTickMs'] as number).toFixed(1)} ms `
      + `players=${h.data['playerCount']} swarm=${h.data['swarmCount']} `
      + `projectiles=${h.data['liveProjectileCount']} `
      + `topPhases: ${top}`,
    );
  }

  console.log(`\n=== tick_budget summaries (1 per second) ===\n`);
  for (const b of budgets) {
    const avg = b.data['avgMs'] as Record<string, number>;
    const topAvg = Object.entries(avg)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, v]) => `${k}=${v.toFixed(2)}`)
      .join(', ');
    console.log(
      `tick=${b.data['serverTick']} maxTotal=${(b.data['maxTotalMs'] as number).toFixed(1)} ms `
      + `overBudget=${b.data['overBudgetCount']}/${b.data['sampleCount']} `
      + `players=${b.data['playerCount']} swarm=${b.data['swarmCount']} `
      + `topAvgPhases: ${topAvg}`,
    );
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
