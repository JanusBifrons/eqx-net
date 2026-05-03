/**
 * Phase 5e bandwidth acceptance gate.
 *
 * Joins 4 Playwright clients into the `swarm-soak` room (500 entities,
 * 80% asteroids / 20% drones), holds for 30 seconds, then reads the
 * `__EQX_BW_STATS` DEV-only ring exposed by ColyseusClient. Asserts that
 * the per-client mean inbound bandwidth (swarm + snapshot) is below the
 * blueprint's 60 KB/s target.
 *
 * The 60 KB/s target counts the binary swarm channel — the snapshot
 * cost is dominated by the per-player ship state, not the swarm — but
 * we report both so a regression in either is visible.
 *
 * Run with:
 *   pnpm e2e --project=chromium tests/e2e/swarm-bandwidth.spec.ts
 */
import { test, expect } from '@playwright/test';
import type { Browser } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const TARGET_KBPS_MEAN = 60;
const TARGET_KBPS_P95 = 90;
const SAMPLE_DURATION_MS = 30_000;
const NUM_CLIENTS = 4;

interface BwSnapshot {
  startedAt: number;
  swarmBytes: number;
  swarmPackets: number;
  snapshotBytes: number;
  snapshotCount: number;
}

async function joinSoak(browser: Browser, idx: number): Promise<{ ctx: Awaited<ReturnType<Browser['newContext']>>; page: Awaited<ReturnType<Awaited<ReturnType<Browser['newContext']>>['newPage']>> }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}?room=swarm-soak&__bw=${idx}`);
  // Auto-join via ?room=. Wait for swarm packets to start arriving.
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __EQX_BW_STATS?: { swarmPackets: number } };
      return (w.__EQX_BW_STATS?.swarmPackets ?? 0) > 0;
    },
    { timeout: 20_000 },
  );
  return { ctx, page };
}

async function readAndReset(page: Awaited<ReturnType<Awaited<ReturnType<Browser['newContext']>>['newPage']>>): Promise<BwSnapshot> {
  return await page.evaluate((): BwSnapshot => {
    const w = window as unknown as { __EQX_BW_STATS?: { startedAt: number; swarmBytes: number; swarmPackets: number; snapshotBytes: number; snapshotCount: number; reset: () => void } };
    const s = w.__EQX_BW_STATS!;
    const out: BwSnapshot = {
      startedAt: s.startedAt,
      swarmBytes: s.swarmBytes,
      swarmPackets: s.swarmPackets,
      snapshotBytes: s.snapshotBytes,
      snapshotCount: s.snapshotCount,
    };
    s.reset();
    return out;
  });
}

test.describe('Phase 5e — bandwidth acceptance', () => {
  // 30 s sample + 4 clients sequentially booted. Headroom for boot + connect.
  test.setTimeout(120_000);

  test('500 entities × 4 clients sustains ≤ 60 KB/s mean per client', async ({ browser }) => {
    const clients = await Promise.all(
      Array.from({ length: NUM_CLIENTS }, (_, i) => joinSoak(browser, i)),
    );

    try {
      // Reset stats now that everyone has joined and the first packet is in.
      // The connect-time full snapshot is excluded so the steady-state cost
      // is what we measure.
      await Promise.all(clients.map((c) => readAndReset(c.page)));

      // Hold the sample window. Clients sit idle (no inputs sent).
      await clients[0]!.page.waitForTimeout(SAMPLE_DURATION_MS);

      const samples = await Promise.all(clients.map((c) => readAndReset(c.page)));
      const elapsedSec = SAMPLE_DURATION_MS / 1000;
      const perClientKbps = samples.map((s) => ({
        swarmKbps: (s.swarmBytes / 1024) / elapsedSec,
        snapshotKbps: (s.snapshotBytes / 1024) / elapsedSec,
        totalKbps: ((s.swarmBytes + s.snapshotBytes) / 1024) / elapsedSec,
        swarmPackets: s.swarmPackets,
        snapshotCount: s.snapshotCount,
      }));

      const totals = perClientKbps.map((p) => p.totalKbps).sort((a, b) => a - b);
      const swarms = perClientKbps.map((p) => p.swarmKbps).sort((a, b) => a - b);
      const meanTotal = totals.reduce((a, b) => a + b, 0) / totals.length;
      const meanSwarm = swarms.reduce((a, b) => a + b, 0) / swarms.length;
      const p95Total = totals[Math.min(totals.length - 1, Math.floor(totals.length * 0.95))]!;

      console.log(
        `\nPhase 5e bandwidth (${NUM_CLIENTS} clients × 500 entities, ${elapsedSec}s):\n` +
        perClientKbps.map((p, i) => `  client ${i}: total=${p.totalKbps.toFixed(1)} KB/s (swarm=${p.swarmKbps.toFixed(1)}, snap=${p.snapshotKbps.toFixed(1)}), swarmPkts=${p.swarmPackets}, snapshots=${p.snapshotCount}`).join('\n') +
        `\n  swarm-only mean=${meanSwarm.toFixed(1)} KB/s\n  total mean=${meanTotal.toFixed(1)} KB/s p95=${p95Total.toFixed(1)} KB/s\n` +
        `  targets: mean ≤ ${TARGET_KBPS_MEAN}, p95 ≤ ${TARGET_KBPS_P95}\n`,
      );

      expect(meanTotal).toBeLessThanOrEqual(TARGET_KBPS_MEAN);
      expect(p95Total).toBeLessThanOrEqual(TARGET_KBPS_P95);
    } finally {
      await Promise.all(clients.map((c) => c.ctx.close()));
    }
  });
});
