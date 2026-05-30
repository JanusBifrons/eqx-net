/**
 * Phase 4 iteration 3 swift-otter — maxDrift investigation diagnostic.
 *
 * Full-defer syncMirror causes maxDriftUnits regression (12→36 in
 * netgate 5-rep median). Mechanism unknown despite earlier analysis.
 * This spec dumps EVERY `snapshot_applied` event (now extended with
 * `driftUnits`, `ticksAhead`, `snapshotIndex`) so we can identify:
 *   - WHEN big drifts happen (first N reconciles? specific patterns?)
 *   - WHAT context (replayWindow size, applyMs, ticksAhead)
 *   - WHETHER drift correlates with snapshot_coalesced (burst) events
 *
 * Print-only; no assertions. Run on demand to gather data.
 */

import { test, expect, chromium } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

interface SnapshotApplied {
  ts: number;
  serverTick: number;
  driftUnits: number;
  ticksAhead: number;
  snapshotIndex: number;
  applyMs: number;
  reconcileMs: number;
  replayWindow: number;
}

test('maxDrift investigation: dump per-snapshot drift for analysis', async () => {
  test.setTimeout(90_000);

  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  const params = new URLSearchParams({
    room: 'feel-test-25',
    diag: '1',
    testId: `maxdrift-inv-${Date.now()}`,
    spawnX: '0', spawnY: '0',
    startHostile: '1',
    webrtc: '0',
  });
  await page.goto(`${BASE_URL}?${params}`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 30_000 },
  );

  // Match netgate's PRIMARY profile + the runScenario from
  // netcode-health.spec.ts (W+Space+strafe). The drift only manifests
  // under ACTIVE GAMEPLAY + JITTER combined.
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 120, downloadThroughput: -1, uploadThroughput: -1,
  });
  // Oscillate latency in background while the scenario runs.
  let oscillating = true;
  const oscillator = (async () => {
    while (oscillating) {
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false, latency: 180, downloadThroughput: -1, uploadThroughput: -1,
      }).catch(() => undefined);
      await page.waitForTimeout(300).catch(() => undefined);
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false, latency: 60, downloadThroughput: -1, uploadThroughput: -1,
      }).catch(() => undefined);
      await page.waitForTimeout(300).catch(() => undefined);
    }
  })();
  // Same gameplay as netcode-health.spec.ts: thrust + fire + strafe.
  const RUN_MS = 30_000;
  await page.keyboard.down('w');
  await page.keyboard.down('Space');
  await page.keyboard.down('a');
  await page.waitForTimeout(RUN_MS * 0.25);
  await page.keyboard.up('a');
  await page.keyboard.down('d');
  await page.waitForTimeout(RUN_MS * 0.25);
  await page.keyboard.up('d');
  await page.keyboard.down('a');
  await page.waitForTimeout(RUN_MS * 0.25);
  await page.keyboard.up('a');
  await page.keyboard.up('w').catch(() => undefined);
  await page.keyboard.up('Space').catch(() => undefined);
  await page.waitForTimeout(RUN_MS * 0.1);
  oscillating = false;
  await oscillator;

  const applied = await page.evaluate(() => {
    const logs = (window as unknown as {
      __eqxLogs?: Array<{ ts: number; tag: string; data: Record<string, unknown> }>;
    }).__eqxLogs ?? [];
    return logs
      .filter((e) => e.tag === 'snapshot_applied')
      .map((e) => ({
        ts: Math.round(e.ts),
        serverTick: Number(e.data['serverTick'] ?? -1),
        driftUnits: Number(e.data['driftUnits'] ?? 0),
        ticksAhead: Number(e.data['ticksAhead'] ?? 0),
        snapshotIndex: Number(e.data['snapshotIndex'] ?? 0),
        applyMs: Number(e.data['applyMs'] ?? 0),
        reconcileMs: Number(e.data['reconcileMs'] ?? 0),
        replayWindow: Number(e.data['replayWindow'] ?? 0),
      })) as SnapshotApplied[];
  });

  // eslint-disable-next-line no-console
  console.log(`\n=== snapshot_applied count: ${applied.length} ===`);
  const sorted = [...applied].sort((a, b) => b.driftUnits - a.driftUnits);
  // eslint-disable-next-line no-console
  console.log('\n=== Top 10 drifts ===');
  for (const e of sorted.slice(0, 10)) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(e));
  }
  // eslint-disable-next-line no-console
  console.log('\n=== First 20 (bootstrap window) ===');
  for (const e of applied.slice(0, 20)) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(e));
  }
  const drifts = applied.map((e) => e.driftUnits);
  drifts.sort((a, b) => a - b);
  const p50 = drifts[Math.floor(drifts.length * 0.5)] ?? 0;
  const p95 = drifts[Math.floor(drifts.length * 0.95)] ?? 0;
  const maxD = drifts[drifts.length - 1] ?? 0;
  // eslint-disable-next-line no-console
  console.log(`\n=== Drift stats: p50=${p50.toFixed(3)} p95=${p95.toFixed(3)} max=${maxD.toFixed(3)} ===`);

  // Also capture coalesce events to see if drift spikes correlate with bursts.
  const coalesced = await page.evaluate(() => {
    const logs = (window as unknown as {
      __eqxLogs?: Array<{ ts: number; tag: string; data: Record<string, unknown> }>;
    }).__eqxLogs ?? [];
    return logs
      .filter((e) => e.tag === 'snapshot_coalesced')
      .map((e) => ({
        ts: Math.round(e.ts),
        dropped: Number(e.data['dropped'] ?? 0),
        newestServerTick: Number(e.data['newestServerTick'] ?? -1),
      }));
  });
  // eslint-disable-next-line no-console
  console.log(`\n=== snapshot_coalesced count: ${coalesced.length} ===`);
  if (coalesced.length > 0) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(coalesced.slice(0, 10)));
  }

  expect(applied.length, 'at least 50 snapshot_applied events').toBeGreaterThan(50);

  await ctx.close();
  await browser.close();
});
