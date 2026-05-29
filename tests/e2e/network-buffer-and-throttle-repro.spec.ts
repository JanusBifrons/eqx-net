/**
 * Reproduces the two phone-smoke symptoms (network buffering causing
 * recv_gap_long with serverToClientDelta burst-decay; CPU throttling
 * dropping effectiveHz) using CDP's Network + Emulation domains.
 *
 * plan: imperative-taco-r2 — replaces a phone-smoke iteration loop with
 * an in-Playwright reproduction. Each iteration of a candidate fix (e.g.
 * client-side jitter-buffer increase, adaptive frame-rate cap) can be
 * validated against this test instead of waiting for a phone session.
 *
 * The phone capture `5vjj4e` (Android Chrome 148) showed:
 *   - 5 recv_gap_long events with `serverToClientDeltaMs` exhibiting
 *     burst-decay around t=42.6 s — packets queued in the network stack
 *     for 500 ms then released in a decreasing-age burst.
 *   - effectiveHz dropping from native 90 Hz to 38-77 Hz at t=91.9,
 *     118.4, 142.4 s — frame-rate throttle without recovery to native.
 *
 * This spec reproduces BOTH symptoms via CDP under a 60 s budget so
 * we can iterate fixes against it without waiting for phone smokes.
 *
 * Diagnostic-only — the assertions verify the INSTRUMENTATION captures
 * the signature, not that the symptom is fixed. Once a fix lands (e.g.
 * adaptive jitter buffer absorbing network bursts), add a sibling
 * spec that asserts the user-visible symptom (drone snap / stutter
 * cadence) is absent under the same injected conditions.
 */
import { test, expect, chromium } from '@playwright/test';
import type { CDPSession } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

interface DiagEntry {
  ts: number;
  tag: string;
  data: Record<string, unknown>;
}

async function readDiagSince(page: import('@playwright/test').Page, sinceTs: number, tag: string): Promise<DiagEntry[]> {
  return await page.evaluate(({ sinceTs, tag }) => {
    const logs = (window as unknown as { __eqxLogs?: DiagEntry[] }).__eqxLogs ?? [];
    return logs.filter((e: DiagEntry) => e.ts >= sinceTs && e.tag === tag);
  }, { sinceTs, tag });
}

test('CDP network latency burst reproduces recv_gap_long with serverToClientDelta evidence', async () => {
  test.setTimeout(60_000);

  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');

  // Boot at hostile combat. ?diag=1 so the full diag stream (including
  // snapshot_received with serverSendPerfNow) is retained in __eqxLogs.
  const params = new URLSearchParams({
    room: 'feel-test-25',
    diag: '1',
    testId: `net-throttle-repro-${Date.now()}`,
    spawnX: '0', spawnY: '0',
    startHostile: '1',
  });
  await page.goto(`${BASE_URL}?${params}`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 15_000 },
  );
  // Warmup so snapshot cadence stabilises before injecting latency.
  await page.waitForTimeout(3000);

  // Mark a timestamp so we only read events from the injection window.
  const injectionStartTs = await page.evaluate(() => performance.now());

  // ── Inject a 500 ms network latency burst ────────────────────────────
  // 500 ms one-way latency = roughly equivalent to a WiFi power-save
  // wake or AP buffer flush window. After the burst, return to no
  // latency so the queued packets release in a burst-decay pattern.
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 500,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await page.waitForTimeout(1500);
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await page.waitForTimeout(2000);

  // ── Verify recv_gap_long fired with the new evidence fields ─────────
  const gapEvents = await readDiagSince(page, injectionStartTs, 'recv_gap_long');
  expect(gapEvents.length, 'at least one recv_gap_long fired during the 500ms latency burst').toBeGreaterThanOrEqual(1);

  const firstGap = gapEvents[0]!;
  // The r2 instrumentation added these fields — they MUST be present.
  expect(firstGap.data, 'recv_gap_long carries serverSendPerfNow').toHaveProperty('serverSendPerfNow');
  expect(firstGap.data, 'recv_gap_long carries clientRecvPerfNow').toHaveProperty('clientRecvPerfNow');
  expect(firstGap.data, 'recv_gap_long carries serverToClientDeltaMs').toHaveProperty('serverToClientDeltaMs');
  expect(typeof firstGap.data['serverToClientDeltaMs']).toBe('number');

  // ── Verify snapshot_received events around the gap also carry the fields ─
  const snapRecv = await readDiagSince(page, injectionStartTs, 'snapshot_received');
  expect(snapRecv.length, 'multiple snapshots received during window').toBeGreaterThan(20);
  const samplesWithEvidence = snapRecv.filter((e) =>
    typeof e.data['serverSendPerfNow'] === 'number' &&
    typeof e.data['clientRecvPerfNow'] === 'number',
  );
  expect(samplesWithEvidence.length / snapRecv.length, 'most snapshot_received events carry server-send timestamps').toBeGreaterThan(0.9);

  await ctx.close();
  await browser.close();
});

test('CDP CPU throttling drops effectiveHz in heap_sample events', async () => {
  test.setTimeout(60_000);

  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);

  const params = new URLSearchParams({
    room: 'feel-test-25',
    diag: '1',
    testId: `cpu-throttle-repro-${Date.now()}`,
    spawnX: '0', spawnY: '0',
    startHostile: '1',
  });
  await page.goto(`${BASE_URL}?${params}`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 15_000 },
  );
  // Warmup so baseline effectiveHz stabilises.
  await page.waitForTimeout(4000);

  // ── Baseline: no throttling, expect ~60 Hz on desktop or whatever
  // the host's refresh rate delivers. We just want to verify the
  // effectiveHz field is populated, not a specific value.
  const baselineWindowStart = await page.evaluate(() => performance.now());
  await page.waitForTimeout(2000);
  const baselineSamples = await readDiagSince(page, baselineWindowStart, 'heap_sample');
  expect(baselineSamples.length, 'heap_sample fires periodically').toBeGreaterThan(5);
  const baselineWithHz = baselineSamples.filter((s) =>
    typeof s.data['effectiveHz'] === 'number' && (s.data['effectiveHz'] as number) > 0,
  );
  expect(baselineWithHz.length, 'baseline heap_sample carries effectiveHz').toBeGreaterThan(0);
  // Use median for stability.
  const baselineHzValues = baselineWithHz.map((s) => s.data['effectiveHz'] as number).sort((a, b) => a - b);
  const baselineHz = baselineHzValues[Math.floor(baselineHzValues.length / 2)]!;

  // ── Apply 6× CPU throttle. On desktop Chrome, this drops the RAF
  // rate substantially even at otherwise idle load.
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  await page.waitForTimeout(3000);

  // Re-read heap_sample events from the throttled window.
  const throttleWindowStart = await page.evaluate(() => performance.now());
  // Wait an extra second so the sliding window only contains throttled samples.
  await page.waitForTimeout(2000);
  const throttledSamples = await readDiagSince(page, throttleWindowStart, 'heap_sample');
  expect(throttledSamples.length, 'heap_sample fires under CPU throttle').toBeGreaterThan(0);
  const throttledWithHz = throttledSamples.filter((s) =>
    typeof s.data['effectiveHz'] === 'number' && (s.data['effectiveHz'] as number) > 0,
  );
  expect(throttledWithHz.length, 'throttled heap_sample carries effectiveHz').toBeGreaterThan(0);
  const throttledHzValues = throttledWithHz.map((s) => s.data['effectiveHz'] as number).sort((a, b) => a - b);
  const throttledHz = throttledHzValues[Math.floor(throttledHzValues.length / 2)]!;

  // Restore CPU before tearing down so the page doesn't leak slow state.
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  // eslint-disable-next-line no-console
  console.log(`baselineHz median: ${baselineHz.toFixed(1)} → throttledHz median: ${throttledHz.toFixed(1)}`);

  // The throttle should at minimum produce a 30 % drop. Real phone
  // captures showed 90 Hz → 38 Hz (58 % drop). Desktop Chrome under
  // 6× throttle should be at least as dramatic.
  expect(throttledHz, 'throttled effectiveHz is < 0.7× baseline').toBeLessThan(baselineHz * 0.7);

  await ctx.close();
  await browser.close();
});

test('LoAF observer fires under sustained CPU throttle', async () => {
  test.setTimeout(45_000);

  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);

  const params = new URLSearchParams({
    room: 'feel-test-25',
    diag: '1',
    testId: `loaf-repro-${Date.now()}`,
    spawnX: '0', spawnY: '0',
    startHostile: '1',
  });
  await page.goto(`${BASE_URL}?${params}`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 15_000 },
  );
  await page.waitForTimeout(2000);

  // The LoAF observer install fires a `loaf_installed` event at boot —
  // verify it landed before we look for actual loaf entries.
  const installEvents = await page.evaluate(() => {
    const logs = (window as unknown as { __eqxLogs?: DiagEntry[] }).__eqxLogs ?? [];
    return logs.filter((e: DiagEntry) => e.tag === 'loaf_installed');
  });
  expect(installEvents.length, 'loaf_installed event fired at boot').toBeGreaterThanOrEqual(1);
  expect(installEvents[0]!.data['supported'], 'desktop Chrome supports LoAF').toBe(true);

  // 6× throttle produces long frames repeatedly.
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  const throttleWindowStart = await page.evaluate(() => performance.now());
  await page.waitForTimeout(5000);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  const loafEvents = await readDiagSince(page, throttleWindowStart, 'loaf');
  // eslint-disable-next-line no-console
  console.log(`loaf events under 6x CPU throttle: ${loafEvents.length}`);

  expect(loafEvents.length, 'LoAF entries fire under sustained throttle').toBeGreaterThanOrEqual(1);
  // The data shape MUST carry the per-script breakdown that motivates LoAF.
  const sampleEntry = loafEvents[0]!.data;
  expect(sampleEntry).toHaveProperty('durationMs');
  expect(sampleEntry).toHaveProperty('blockingDurationMs');
  expect(sampleEntry).toHaveProperty('scriptCount');
  expect(sampleEntry).toHaveProperty('topScripts');
  expect(Array.isArray(sampleEntry['topScripts'])).toBe(true);

  await ctx.close();
  await browser.close();
});
