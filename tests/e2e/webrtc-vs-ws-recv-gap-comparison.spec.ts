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
 * Phase 4 iteration 3 diagnostic — pull the Colyseus roomId off
 * `window.__eqxClient.room.id`. TypeScript visibility (`private room`)
 * is compile-time only; at runtime in the browser the field is just a
 * JS property. Returns null if the client hasn't joined yet.
 */
async function readRoomId(page: import('@playwright/test').Page): Promise<string | null> {
  return await page.evaluate(() => {
    const client = (window as unknown as { __eqxClient?: { room?: { id?: string } } }).__eqxClient;
    return client?.room?.id ?? null;
  });
}

/**
 * Phase 4 iteration 3 diagnostic — fetch server-side per-session WebRTC
 * counters via the `/dev/webrtc-counters` endpoint (Vite proxies `/dev/*`
 * to the dev server on :2567). Returns null on any failure so the spec
 * can keep running even if the dev endpoint is unavailable in this env.
 */
async function readServerCounters(
  page: import('@playwright/test').Page,
  roomId: string,
): Promise<{ sessions: Array<{ sessionId: string; sentViaDc: number; sentViaWs: number; dcThrows: number; dcBackpressureHits: number; dcSlowSends: number; degraded: boolean }> } | null> {
  return await page.evaluate(async (rid) => {
    try {
      const r = await fetch(`/dev/webrtc-counters?roomId=${encodeURIComponent(rid)}`);
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }, roomId);
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
  snapDroppedOld: number;
  snapDroppedDecode: number;
  snapDroppedShape: number;
  webrtcConnected: boolean;
  // Phase 4 iteration 3 — server-side counter snapshot for the room
  // we're attached to. `serverFetchOk` flags whether the /dev fetch
  // returned data (false = endpoint unreachable or room unknown).
  // `serverSessionId` is captured to confirm we read the right entry.
  roomId: string | null;
  serverFetchOk: boolean;
  serverSessionId: string | null;
  serverSentDc: number;
  serverSentWs: number;
  serverDcThrows: number;
  serverDcBackpressureHits: number;
  serverDcSlowSends: number;
  serverDegraded: boolean;
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
  const dropOld = await readDiagSince(page, start, 'snap_dropped_old');
  const dropDecode = await readDiagSince(page, start, 'snap_dropped_decode');
  const dropShape = await readDiagSince(page, start, 'snap_dropped_shape');
  // `webrtc_connected` may fire BEFORE the burst window starts (during
  // warmup) — read across the whole session.
  const connected = await page.evaluate(() => {
    const logs = (window as unknown as { __eqxLogs?: { tag: string }[] }).__eqxLogs ?? [];
    return logs.some((e) => e.tag === 'webrtc_connected');
  });

  // Phase 4 iteration 3 swift-otter — server-side counter fetch.
  // `snap_route` events fire server-side via serverLogEvent — they
  // don't reach __eqxLogs. The /dev/webrtc-counters endpoint exposes
  // the WebRtcChannelManager's per-session counters so we can compare
  // server-sent-N against client-received-M (the snapshots/dc count
  // above) and localise where DC throughput variance lives.
  const roomId = await readRoomId(page);
  let serverFetchOk = false;
  let serverSessionId: string | null = null;
  let serverSentDc = 0;
  let serverSentWs = 0;
  let serverDcThrows = 0;
  let serverDcBackpressureHits = 0;
  let serverDcSlowSends = 0;
  let serverDegraded = false;
  if (roomId !== null) {
    const counters = await readServerCounters(page, roomId);
    if (counters !== null && Array.isArray(counters.sessions) && counters.sessions.length > 0) {
      // The Phase 4 spec joins one client per rep so we expect exactly
      // one session; if there are more (unlikely — single feel-test-25
      // room per rep), sum across them rather than pick arbitrarily.
      serverFetchOk = true;
      for (const s of counters.sessions) {
        serverSessionId = serverSessionId ?? s.sessionId;
        serverSentDc += s.sentViaDc;
        serverSentWs += s.sentViaWs;
        serverDcThrows += s.dcThrows;
        serverDcBackpressureHits += s.dcBackpressureHits;
        serverDcSlowSends += s.dcSlowSends;
        serverDegraded = serverDegraded || s.degraded;
      }
    }
  }
  void arm; // arm is kept in the signature for future per-arm handling.

  return {
    recvGapLong: gaps.length,
    recvGapLongDc: gaps.filter((e) => e.data['via'] === 'dc').length,
    recvGapLongWs: gaps.filter((e) => e.data['via'] === 'ws').length,
    snapshotsDc: snapshots.filter((e) => e.data['via'] === 'dc').length,
    snapshotsWs: snapshots.filter((e) => e.data['via'] === 'ws').length,
    snapDroppedOld: dropOld.length,
    snapDroppedDecode: dropDecode.length,
    snapDroppedShape: dropShape.length,
    webrtcConnected: connected,
    roomId,
    serverFetchOk,
    serverSessionId,
    serverSentDc,
    serverSentWs,
    serverDcThrows,
    serverDcBackpressureHits,
    serverDcSlowSends,
    serverDegraded,
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
        `snaps_ws=${result.snapshotsWs} snaps_dc=${result.snapshotsDc} ` +
        `server_fetch=${result.serverFetchOk} ` +
        `server_dc=${result.serverSentDc} server_ws=${result.serverSentWs}`,
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
        `drop_old=${result.snapDroppedOld} drop_dec=${result.snapDroppedDecode} drop_shape=${result.snapDroppedShape} ` +
        `dc_frac=${dcFrac.toFixed(3)} dc_connected=${result.webrtcConnected} ` +
        // Phase 4 iteration 3: server-side authoritative counters.
        // Compare server_dc (server's sentViaDc) against snaps_dc
        // (client's snapshot_received via='dc') to localise variance:
        // server_dc≈snaps_dc → wire+integration clean; server_dc>>snaps_dc
        // → browser-side gap; server_dc<<200 → server-side gap.
        `server_fetch=${result.serverFetchOk} server_dc=${result.serverSentDc} ` +
        `server_ws=${result.serverSentWs} server_throws=${result.serverDcThrows} ` +
        `server_bp=${result.serverDcBackpressureHits} server_slow=${result.serverDcSlowSends} ` +
        `server_degraded=${result.serverDegraded}`,
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
    // Phase 4 iteration 3 — fetch server-side counters for the control
    // window too; if snapsDc < server_dc here we know the gap is browser-
    // side even WITHOUT network injection.
    const roomId = await readRoomId(page);
    const serverCounters = roomId !== null ? await readServerCounters(page, roomId) : null;
    const serverSession = serverCounters?.sessions?.[0];
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      arm: 'dc-control', recv_gap_long: gaps.length, snapshots: snaps.length,
      snapshots_dc: snapsDc, snapshots_ws: snapsWs, webrtc_connected: dcConnected,
      server_fetch_ok: serverSession !== undefined,
      server_dc: serverSession?.sentViaDc ?? 0,
      server_ws: serverSession?.sentViaWs ?? 0,
      server_degraded: serverSession?.degraded ?? false,
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
