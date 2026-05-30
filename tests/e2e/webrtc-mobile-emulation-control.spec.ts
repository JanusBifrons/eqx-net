/**
 * Mobile emulation CONTROL spec — minimal scaffolding test that boots
 * Playwright with Pixel 4a (5G) emulation, joins the test sector, and
 * asserts that AT LEAST ONE `snapshot_received` event lands in the
 * client's diag ring buffer within a short window.
 *
 * Purpose: fast iteration for the mobile-emulator reproduction work
 * (`webrtc-mobile-emulation-stutter.spec.ts`). v1 (iPhone 14) and v2
 * (Pixel 4a + late-throttle) both produced `snapshots: 0` despite
 * `waitForFunction(ship-count > 0)` passing. We need a ~30 s test that
 * proves: emulation boots, game joins, snapshots flow, diag ring is
 * populated. Without this primitive every full-spec iteration costs
 * 4-5 min wall-clock.
 *
 * Two tests:
 *   1. WS-only (?webrtc=0) — proves the snapshot pipeline reaches the
 *      diag ring under mobile emulation.
 *   2. DC-enabled (?webrtc=1) — proves WebRTC handshake completes
 *      under emulation AND snapshots flow over the DC path.
 *
 * Plan: swift-otter (Phase 4 iteration 3, control-spec subtask 2026-05-30).
 */

import { test, expect, chromium, devices } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

interface BootedSession {
  browser: import('@playwright/test').Browser;
  ctx: import('@playwright/test').BrowserContext;
  page: import('@playwright/test').Page;
}

async function bootMobile(arm: 'ws' | 'dc'): Promise<BootedSession> {
  // `channel: 'chromium'` uses the FULL Chromium binary (new headless
  // mode) instead of Playwright's bundled chromium-headless-shell.
  // The shell falls back to SwiftShader software WebGL under mobile
  // emulation, which throttles render to ~10 Hz; the full binary
  // ships with proper Vulkan / ANGLE GPU paths. v3 with the swiftshader
  // flag still measured snapshot_received stopping at ~5 s under Pixel
  // emulation — the render loop couldn't keep the simulation alive.
  const browser = await chromium.launch({ channel: 'chromium' });
  const ctx = await browser.newContext({ ...devices['Pixel 4a (5G)'] });
  const page = await ctx.newPage();
  const params = new URLSearchParams({
    room: 'feel-test-25',
    diag: '1',
    testId: `mobile-control-${arm}-${Date.now()}`,
    spawnX: '0', spawnY: '0',
    startHostile: '1',
    webrtc: arm === 'dc' ? '1' : '0',
  });
  await page.goto(`${BASE_URL}?${params}`);
  return { browser, ctx, page };
}

/**
 * Wait for the game to be alive: `[data-testid="ship-count"]` shows
 * a count > 0 (proves a snapshot has applied to the local mirror).
 * 20 s ceiling — anything slower than that on emulated Pixel without
 * throttle is a real defect, not a slow boot.
 */
async function waitForShipCount(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 20_000 },
  );
}

async function waitForFirstSnapshot(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const logs = (window as unknown as { __eqxLogs?: { tag: string }[] }).__eqxLogs ?? [];
      return logs.filter((e) => e.tag === 'snapshot_received').length > 0;
    },
    { timeout: 10_000 },
  );
}

async function dumpDiagState(page: import('@playwright/test').Page): Promise<unknown> {
  return await page.evaluate(() => {
    const logs = (window as unknown as {
      __eqxLogs?: Array<{ tag: string; ts: number; data: Record<string, unknown> }>;
    }).__eqxLogs ?? [];
    const tagCounts: Record<string, number> = {};
    for (const e of logs) tagCounts[e.tag] = (tagCounts[e.tag] ?? 0) + 1;
    const snaps = logs.filter((e) => e.tag === 'snapshot_received');
    const dcSnaps = snaps.filter((e) => (e.data as { via?: string }).via === 'dc');
    const wsSnaps = snaps.filter((e) => (e.data as { via?: string }).via === 'ws');
    // Lifecycle-relevant events with their data fields — phase changes,
    // lost-connection, welcome, joystick destruction, etc.
    const interestingTags = new Set([
      'phase_change', 'welcome', 'webrtc_connected', 'webrtc_closed',
      'webrtc_pc_state', 'lost_connection_overlay_shown',
      'lost_connection_overlay_auto_return', 'joystick_destroyed',
      'joystick_initialized', 'component_mount', 'component_unmount',
      'connection_lost', 'connection_restored', 'server_health_change',
      'device_info', 'device_info_calibration',
    ]);
    const lifecycle = logs
      .filter((e) => interestingTags.has(e.tag))
      .slice(-25)
      .map((e) => ({ ts: Math.round(e.ts), tag: e.tag, data: e.data }));
    return {
      totalLogs: logs.length,
      uniqueTagCount: Object.keys(tagCounts).length,
      topTags: Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 20),
      snapshotCount: snaps.length,
      snapshotsDc: dcSnaps.length,
      snapshotsWs: wsSnaps.length,
      firstSnapshot: snaps[0] ?? null,
      lastSnapshot: snaps[snaps.length - 1] ?? null,
      webrtcConnected: logs.some((e) => e.tag === 'webrtc_connected'),
      shipCountEl: document.querySelector('[data-testid="ship-count"]')?.textContent,
      lifecycle,
    };
  });
}

test('mobile-emul control WS-only — at least 1 snapshot_received lands within ~30s', async () => {
  test.setTimeout(60_000);

  const { browser, ctx, page } = await bootMobile('ws');
  // Forward page console + errors to test output so we can see what
  // the page itself is logging when emulation breaks the session.
  page.on('console', (msg) => {
    // eslint-disable-next-line no-console
    console.log(`[page:${msg.type()}]`, msg.text());
  });
  page.on('pageerror', (err) => {
    // eslint-disable-next-line no-console
    console.log(`[pageerror]`, err.message);
  });
  try {
    await waitForShipCount(page);
    // Dump IMMEDIATELY after ship-count > 0 — this is the latest
    // moment we know the connection was alive.
    const earlyDump = await dumpDiagState(page);
    // eslint-disable-next-line no-console
    console.log('[ws-control after ship-count]', JSON.stringify(earlyDump, null, 2));
    // Now poll for 15 seconds, dumping every 5 seconds, so we can
    // see if/when snapshots stop and what events fire in between.
    for (let i = 0; i < 3; i++) {
      await page.waitForTimeout(5_000);
      const dump = await dumpDiagState(page);
      // eslint-disable-next-line no-console
      console.log(`[ws-control t+${(i + 1) * 5}s]`, JSON.stringify(dump, null, 2));
    }
    // Final assert — at least one snapshot should have arrived.
    const finalDump = await dumpDiagState(page);
    expect((finalDump as { snapshotCount: number }).snapshotCount, 'snapshot_received present').toBeGreaterThan(0);
    expect((finalDump as { snapshotsWs: number }).snapshotsWs, 'WS arm has via=ws snapshots').toBeGreaterThan(0);
  } finally {
    await ctx.close();
    await browser.close();
  }
});

test('mobile-emul control DC-enabled — at least 1 snapshot_received via=dc within ~30s', async () => {
  test.setTimeout(60_000);

  const { browser, ctx, page } = await bootMobile('dc');
  try {
    await waitForShipCount(page);
    // For DC: wait for webrtc_connected first, then a DC-routed snapshot.
    await page.waitForFunction(
      () => {
        const logs = (window as unknown as { __eqxLogs?: { tag: string }[] }).__eqxLogs ?? [];
        return logs.some((e) => e.tag === 'webrtc_connected');
      },
      { timeout: 25_000 },
    );
    await page.waitForFunction(
      () => {
        const logs = (window as unknown as {
          __eqxLogs?: Array<{ tag: string; data: { via?: string } }>;
        }).__eqxLogs ?? [];
        return logs.some((e) => e.tag === 'snapshot_received' && e.data?.via === 'dc');
      },
      { timeout: 10_000 },
    );
    const dump = await dumpDiagState(page);
    // eslint-disable-next-line no-console
    console.log('[dc-control]', JSON.stringify(dump, null, 2));
    expect((dump as { webrtcConnected: boolean }).webrtcConnected, 'DC opened').toBe(true);
    expect((dump as { snapshotsDc: number }).snapshotsDc, 'DC arm has via=dc snapshots').toBeGreaterThan(0);
  } finally {
    await ctx.close();
    await browser.close();
  }
});
