/**
 * Phase 4 iteration 3 swift-otter — synthetic reproduction of the
 * 2026-05-30 phone-smoke "DC enable correlates with more WS-handler
 * loafs" finding.
 *
 * Three phone captures (htdqz5 / 7enlft / xspb1t) showed
 * `DOMWebSocket.onmessage` → `onMessageCallback` long-animation-frame
 * events at 0.21-0.51/s when ?webrtc=1, vs 0.02/s on the WS-only
 * anchor (g6l26y). 10-25× more per second. Combat volume was ~1.9×
 * higher in the DC captures, which doesn't explain the magnitude.
 *
 * This spec replicates the conditions in Playwright + iPhone device
 * emulation + 4× CPU throttle + realistic mobile network so we can
 * iterate fixes without re-asking the user for phone smokes (user
 * directive 2026-05-30: "No more phone smokes now until we are more
 * certain. You need to replicate with the phone emulator").
 *
 * Print-only test (no gates) — we want the numbers, not a pass/fail.
 * Outputs per arm: loaf invoker distribution, raf_stutter count,
 * snapshot count, correction count, DC routing %.
 */

import { test, expect, chromium, devices } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const PLAY_DURATION_MS = 30_000;
// Pixel 4a (5G) — Android Chrome 131 UA, 412×765 viewport, DPR 2.63,
// touch enabled. Chosen over iPhone descriptors because the first
// attempt with iPhone 14 produced 0 snapshots in both arms (likely a
// Safari-UA / WebKit interaction with our auth storage state; the
// Android Chrome path is closer to the actual phone test environment
// anyway). The late-throttle pattern below (apply CPU/network throttle
// AFTER the game has booted) avoids the secondary issue where pre-
// navigate throttle starved asset loading.

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

interface ArmResult {
  arm: 'ws' | 'dc';
  durationMs: number;
  loafTotal: number;
  loafByInvoker: Record<string, number>;
  wsLoafs: number;
  rafCallbackLoafs: number;
  rafStutter: number;
  rafGap: number;
  longtask: number;
  corrections: number;
  snapshots: number;
  snapsDc: number;
  snapsWs: number;
  recvGapLong: number;
  webrtcConnected: boolean;
}

async function runOneArm(arm: 'ws' | 'dc'): Promise<ArmResult> {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['Pixel 4a (5G)'] });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');

  // Navigate FIRST, wait for the game to be alive, THEN apply
  // throttling. Applying throttle pre-navigate slowed asset loading
  // enough that the meta-landing screen never advanced (first attempt
  // produced 0 snapshots in both arms).
  const params = new URLSearchParams({
    room: 'feel-test-25',
    diag: '1',
    testId: `mobile-emul-${arm}-${Date.now()}`,
    spawnX: '0', spawnY: '0',
    startHostile: '1',
    webrtc: arm === 'dc' ? '1' : '0',
  });
  await page.goto(`${BASE_URL}?${params}`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 30_000 },
  );

  // DC needs to open BEFORE we apply throttle — the 5 s connect
  // deadline doesn't survive 4× CPU + 100 ms latency together. 30 s
  // ceiling (v2 timed out at 20 s).
  if (arm === 'dc') {
    await page.waitForFunction(
      () => {
        const logs = (window as unknown as { __eqxLogs?: { tag: string }[] }).__eqxLogs ?? [];
        return logs.some((e) => e.tag === 'webrtc_connected');
      },
      { timeout: 30_000 },
    );
  }

  // v3: no CPU/network throttle, just device emulation. Get the
  // scaffolding working first — v1 and v2 both produced 0 snapshots
  // in both arms despite waitForFunction(ship-count > 0) passing.
  // If this v3 sees snapshots, the throttle was the cause of the
  // zero-snapshot mystery and we add it back in v4 at a lower
  // intensity (2× CPU, modest network).
  await page.waitForTimeout(3_000);

  const startPerf = await page.evaluate(() => performance.now());
  await page.waitForTimeout(PLAY_DURATION_MS);
  const endPerf = await page.evaluate(() => performance.now());

  const loafs = await readDiagSince(page, startPerf, 'loaf');
  const rafStutter = (await readDiagSince(page, startPerf, 'raf_stutter')).length;
  const rafGap = (await readDiagSince(page, startPerf, 'raf_gap')).length;
  const longtask = (await readDiagSince(page, startPerf, 'longtask')).length;
  const corrections = (await readDiagSince(page, startPerf, 'correction')).length;
  const snaps = await readDiagSince(page, startPerf, 'snapshot_received');
  const recvGapLong = (await readDiagSince(page, startPerf, 'recv_gap_long')).length;
  const webrtcConnected = await page.evaluate(() => {
    const logs = (window as unknown as { __eqxLogs?: { tag: string }[] }).__eqxLogs ?? [];
    return logs.some((e) => e.tag === 'webrtc_connected');
  });

  // Diagnostic dump: total __eqxLogs size + top tag counts in window.
  // The v1 + v2 runs both showed snapshots:0 with WS arm working
  // elsewhere — need to see what IS being logged to localise.
  const dump = await page.evaluate((sinceTs) => {
    const logs = (window as unknown as { __eqxLogs?: { tag: string; ts: number }[] }).__eqxLogs ?? [];
    const inWindow = logs.filter((e) => e.ts >= sinceTs);
    const tagCounts: Record<string, number> = {};
    for (const e of inWindow) tagCounts[e.tag] = (tagCounts[e.tag] ?? 0) + 1;
    return {
      totalLogsInBuffer: logs.length,
      inWindowCount: inWindow.length,
      topTags: Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 20),
      shipCountEl: document.querySelector('[data-testid="ship-count"]')?.textContent,
    };
  }, startPerf);
  // eslint-disable-next-line no-console
  console.log(`[${arm}] diag dump:`, JSON.stringify(dump));

  // Build invoker-bucket histogram from loaf entries — same shape as
  // the phone-capture grep that surfaced the WS-handler dominance.
  const loafByInvoker: Record<string, number> = {};
  for (const e of loafs) {
    const ts = e.data as { topScripts?: Array<{ invoker?: string }> };
    const invoker = ts.topScripts?.[0]?.invoker ?? '(no-script)';
    loafByInvoker[invoker] = (loafByInvoker[invoker] ?? 0) + 1;
  }
  const wsLoafs = loafByInvoker['DOMWebSocket.onmessage'] ?? 0;
  const rafCallbackLoafs = loafByInvoker['FrameRequestCallback'] ?? 0;

  const snapsDc = snaps.filter((e) => e.data['via'] === 'dc').length;
  const snapsWs = snaps.filter((e) => e.data['via'] === 'ws').length;

  // Restore + teardown. (v3 doesn't actually throttle yet, but the
  // restore is harmless and stays in place for v4.)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await ctx.close();
  await browser.close();

  return {
    arm,
    durationMs: endPerf - startPerf,
    loafTotal: loafs.length,
    loafByInvoker,
    wsLoafs,
    rafCallbackLoafs,
    rafStutter,
    rafGap,
    longtask,
    corrections,
    snapshots: snaps.length,
    snapsDc,
    snapsWs,
    recvGapLong,
    webrtcConnected,
  };
}

test('Mobile emulation — DC enable vs WS-only loaf-invoker distribution', async () => {
  test.setTimeout(300_000); // 5 min: 2 sessions × (10s warmup + 30s play + boot/teardown)

  // eslint-disable-next-line no-console
  console.log('=== WS arm (?webrtc=0) ===');
  const ws = await runOneArm('ws');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(ws, null, 2));

  // eslint-disable-next-line no-console
  console.log('=== DC arm (?webrtc=1) ===');
  const dc = await runOneArm('dc');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(dc, null, 2));

  // Comparison summary. Print only — no gates. We want to see if the
  // phone-finding reproduces synthetically; the operator reads the
  // numbers and decides.
  const wsLoafRateWs = ws.wsLoafs / (ws.durationMs / 1000);
  const wsLoafRateDc = dc.wsLoafs / (dc.durationMs / 1000);
  const wsLoafRateRatio = wsLoafRateDc / Math.max(wsLoafRateWs, 0.001);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    comparison: {
      wsLoafsPerSec_wsArm: wsLoafRateWs.toFixed(3),
      wsLoafsPerSec_dcArm: wsLoafRateDc.toFixed(3),
      wsLoafsPerSec_ratio_dc_over_ws: wsLoafRateRatio.toFixed(2),
      rafStutter_wsArm: ws.rafStutter,
      rafStutter_dcArm: dc.rafStutter,
      corrections_wsArm: ws.corrections,
      corrections_dcArm: dc.corrections,
      snapshots_wsArm: ws.snapshots,
      snapshots_dcArm: dc.snapshots,
      dc_routing_pct: dc.snapshots > 0 ? ((dc.snapsDc / dc.snapshots) * 100).toFixed(1) : 'n/a',
    },
    interpretation: wsLoafRateRatio > 5
      ? 'REPRODUCED: DC arm has ≥5× more WS-handler loafs per second — matches phone finding.'
      : wsLoafRateRatio > 2
      ? 'PARTIAL: DC arm has 2-5× more WS-handler loafs — directional match.'
      : 'NOT REPRODUCED: WS-handler loaf rate is similar in both arms — phone finding is environment-specific.',
  }, null, 2));

  // Sanity gates only — never blocks the diagnostic data.
  expect(dc.webrtcConnected, 'DC opened in dc-arm').toBe(true);
  expect(ws.snapshots, 'WS arm produced snapshots').toBeGreaterThan(50);
  expect(dc.snapshots, 'DC arm produced snapshots').toBeGreaterThan(50);
});
