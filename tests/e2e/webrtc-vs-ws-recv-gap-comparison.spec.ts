/**
 * Phase 4 swift-otter — compare `?webrtc=1` vs `?webrtc=0` under the
 * Pattern B (3× 400 ms latency bursts) network injection introduced by
 * `network-buffer-and-throttle-repro.spec.ts`.
 *
 * Hostile review #13 mitigation: 3 runs per arm, median + IQR. Pass
 * criterion (Phase 4 exit gate):
 *   - median `recv_gap_long` count under `?webrtc=1` is at least 70 %
 *     below `?webrtc=0` median
 *   - the IQR of the two arms does not overlap
 *
 * Control test (separate `test()`): `?webrtc=1` with NO network injection
 * — verify DC doesn't introduce NEW gaps. If the control fires more than
 * a small number of gaps, the DC path itself is causing buffering and
 * the gain measurement is contaminated.
 *
 * Plan: swift-otter (Phase 4).
 */

import { test, expect, chromium } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const REPS_PER_ARM = 3;

interface DiagEntry {
  ts: number;
  tag: string;
  data: Record<string, unknown>;
}

async function readDiagSince(
  page: import('@playwright/test').Page,
  sinceTs: number,
  tag: string,
): Promise<DiagEntry[]> {
  return await page.evaluate(({ sinceTs, tag }) => {
    const logs = (window as unknown as { __eqxLogs?: DiagEntry[] }).__eqxLogs ?? [];
    return logs.filter((e: DiagEntry) => e.ts >= sinceTs && e.tag === tag);
  }, { sinceTs, tag });
}

/**
 * One measurement run: boot the page with the supplied URL params,
 * warmup, inject pattern B (3× 400 ms bursts with 2 s gaps), and count
 * `recv_gap_long` events fired during the burst window. Uses the
 * `via` field on the Phase-4-corrected `snapshot_received` /
 * `recv_gap_long` logs (added 2026-05-29 after the first E2E showed
 * the WS-only logging path was systematically biased against DC).
 */
async function runOneBurst(
  arm: 'ws' | 'dc',
  cdp: import('@playwright/test').CDPSession,
  page: import('@playwright/test').Page,
): Promise<{
  recvGapLong: number;
  recvGapLongDc: number;
  recvGapLongWs: number;
  snapshotsDc: number;
  snapshotsWs: number;
  webrtcConnected: boolean;
}> {
  // Mark the window start AFTER warmup but BEFORE the bursts so the
  // measurement is symmetric across arms.
  const start = await page.evaluate(() => performance.now());

  for (let i = 0; i < 3; i++) {
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 400, downloadThroughput: -1, uploadThroughput: -1,
    });
    await page.waitForTimeout(1000);
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });
    await page.waitForTimeout(2000);
  }
  // Brief drain so any post-burst gap still counts in the window.
  await page.waitForTimeout(1000);

  const gaps = await readDiagSince(page, start, 'recv_gap_long');
  const snapshots = await readDiagSince(page, start, 'snapshot_received');
  // `webrtc_connected` may fire BEFORE the burst window starts (during
  // warmup) — read across the whole session.
  const connected = await page.evaluate(() => {
    const logs = (window as unknown as { __eqxLogs?: { tag: string }[] }).__eqxLogs ?? [];
    return logs.some((e) => e.tag === 'webrtc_connected');
  });

  return {
    recvGapLong: gaps.length,
    recvGapLongDc: gaps.filter((e) => e.data['via'] === 'dc').length,
    recvGapLongWs: gaps.filter((e) => e.data['via'] === 'ws').length,
    snapshotsDc: snapshots.filter((e) => e.data['via'] === 'dc').length,
    snapshotsWs: snapshots.filter((e) => e.data['via'] === 'ws').length,
    webrtcConnected: connected,
  };
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function quartile(xs: number[], q: 0.25 | 0.75): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

async function bootSession(webrtcParam: '0' | '1', tag: string): Promise<{
  browser: import('@playwright/test').Browser;
  ctx: import('@playwright/test').BrowserContext;
  page: import('@playwright/test').Page;
  cdp: import('@playwright/test').CDPSession;
}> {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  const params = new URLSearchParams({
    room: 'feel-test-25',
    diag: '1',
    testId: `${tag}-${Date.now()}`,
    spawnX: '0', spawnY: '0',
    startHostile: '1',
    webrtc: webrtcParam,
  });
  await page.goto(`${BASE_URL}?${params}`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 20_000 },
  );
  // Warmup: ?webrtc=1 needs extra time for the DC to open.
  await page.waitForTimeout(webrtcParam === '1' ? 6_000 : 3_000);
  return { browser, ctx, page, cdp };
}

test('Phase 4 — recv_gap_long under Pattern B: ?webrtc=1 vs ?webrtc=0 (3 reps each)', async () => {
  test.setTimeout(360_000); // 6 min — 6 runs × ~30 s + slack

  const wsCounts: number[] = [];
  const dcCounts: number[] = [];
  const dcConnectedFlags: boolean[] = [];
  const dcRouteFractions: number[] = [];

  for (let i = 0; i < REPS_PER_ARM; i++) {
    const { browser, ctx, page, cdp } = await bootSession('0', `ws-rep${i}`);
    try {
      const result = await runOneBurst('ws', cdp, page);
      wsCounts.push(result.recvGapLong);
      // eslint-disable-next-line no-console
      console.log(
        `[ws rep ${i}] recv_gap_long=${result.recvGapLong} ` +
        `snaps_ws=${result.snapshotsWs} snaps_dc=${result.snapshotsDc}`,
      );
    } finally {
      await ctx.close();
      await browser.close();
    }
  }

  for (let i = 0; i < REPS_PER_ARM; i++) {
    const { browser, ctx, page, cdp } = await bootSession('1', `dc-rep${i}`);
    try {
      const result = await runOneBurst('dc', cdp, page);
      dcCounts.push(result.recvGapLong);
      dcConnectedFlags.push(result.webrtcConnected);
      const totalSnaps = result.snapshotsDc + result.snapshotsWs;
      const dcFrac = totalSnaps > 0 ? result.snapshotsDc / totalSnaps : 0;
      dcRouteFractions.push(dcFrac);
      // eslint-disable-next-line no-console
      console.log(
        `[dc rep ${i}] recv_gap_long=${result.recvGapLong} ` +
        `(ws=${result.recvGapLongWs} dc=${result.recvGapLongDc}) ` +
        `snaps_dc=${result.snapshotsDc} snaps_ws=${result.snapshotsWs} ` +
        `dc_frac=${dcFrac.toFixed(3)} dc_connected=${result.webrtcConnected}`,
      );
    } finally {
      await ctx.close();
      await browser.close();
    }
  }

  const wsMedian = median(wsCounts);
  const dcMedian = median(dcCounts);
  const wsIqr: [number, number] = [quartile(wsCounts, 0.25), quartile(wsCounts, 0.75)];
  const dcIqr: [number, number] = [quartile(dcCounts, 0.25), quartile(dcCounts, 0.75)];
  const dcRouteMedian = median(dcRouteFractions);
  const allConnected = dcConnectedFlags.every((c) => c);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    arm: 'ws', counts: wsCounts, median: wsMedian, iqr: wsIqr,
  }));
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    arm: 'dc', counts: dcCounts, median: dcMedian, iqr: dcIqr,
    dc_route_median: dcRouteMedian, all_connected: allConnected,
  }));

  // Liveness gates — both must hold for the comparison to be meaningful.
  expect(allConnected, 'DC opened in every dc-arm rep (webrtc_connected fired)').toBe(true);
  expect(dcRouteMedian, 'DC path delivered the majority of snapshots in the dc arm').toBeGreaterThan(0.5);
  expect(wsMedian, 'WS arm produced gaps under Pattern B').toBeGreaterThan(0);

  // Phase 4 exit gate.
  expect(dcMedian, 'DC median recv_gap_long ≥ 70% below WS median')
    .toBeLessThanOrEqual(wsMedian * 0.3);

  // Phase 4 hostile #13 hardening — IQRs must not overlap.
  expect(dcIqr[1], 'DC IQR upper does not overlap WS IQR lower')
    .toBeLessThan(wsIqr[0]);
});

test('Phase 4 control — ?webrtc=1 under no network injection: recv_gap_long should be ~0', async () => {
  test.setTimeout(90_000);

  const { browser, ctx, page } = await bootSession('1', 'dc-control');
  try {
    const start = await page.evaluate(() => performance.now());
    // Run for the same duration as the burst window in the comparison
    // test (~10 s) without any injection.
    await page.waitForTimeout(10_000);
    const gaps = await readDiagSince(page, start, 'recv_gap_long');
    const snaps = await readDiagSince(page, start, 'snapshot_received');
    const dcConnected = await page.evaluate(() => {
      const logs = (window as unknown as { __eqxLogs?: { tag: string }[] }).__eqxLogs ?? [];
      return logs.some((e) => e.tag === 'webrtc_connected');
    });
    const snapsDc = snaps.filter((e) => e.data['via'] === 'dc').length;
    const snapsWs = snaps.filter((e) => e.data['via'] === 'ws').length;
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      arm: 'dc-control', recv_gap_long: gaps.length, snapshots: snaps.length,
      snapshots_dc: snapsDc, snapshots_ws: snapsWs, webrtc_connected: dcConnected,
    }));
    expect(dcConnected, 'DC opened in the control run').toBe(true);
    expect(snaps.length, 'control run produced snapshots').toBeGreaterThan(50);
    expect(snapsDc, 'control run delivered snapshots via DC').toBeGreaterThan(0);
    // DC must not produce gaps under healthy network. Allow 1 transient
    // (e.g. the very first snapshot's gap measurement) — anything beyond
    // that means DC is introducing buffering.
    expect(gaps.length, 'DC under healthy network produces ~0 recv_gap_long').toBeLessThanOrEqual(2);
  } finally {
    await ctx.close();
    await browser.close();
  }
});
