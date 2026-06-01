/**
 * Phone-driven harness PoC.
 *
 * Proves end-to-end that we can drive Chrome on the user's
 * USB-tethered Android phone via Playwright's `_android` API and that
 * the EQX game boots interactively on the device. Manual smoke-test
 * surrogate: if this spec is green, the entire smoke-test workflow is
 * expressible as automation.
 *
 * What we assert:
 *   - `playwright._android` connect succeeds (`conn.kind === 'android'`
 *     — silent fallback would be a wrong-test signal, so this is a
 *     hard assertion not a soft one).
 *   - `data-testid="game-surface"` mounts (canvas alive).
 *   - `data-hull-pct` > 0 (Colyseus join completed, server snapshot
 *     applied, hull state propagated to DOM telemetry).
 *   - `data-ship-x`/`data-ship-y` are finite numbers (render mirror
 *     populated).
 *
 * Prerequisites — all documented in
 * `docs/HANDOFF-phone-test-harness-2026-06-01.md`:
 *   - USB debugging ON, phone unlocked, `adb devices` shows `device`.
 *   - `chrome://flags/#enable-command-line-on-non-rooted-devices`
 *     ENABLED on the phone (Chrome relaunched). Without this,
 *     `device.launchBrowser()` throws — the helper translates that to
 *     an actionable message.
 *   - Phone and host on the same Wi-Fi. The host's LAN IP is
 *     auto-picked via `pickLanIp()`; override with `HOST_LAN_IP=<ip>`
 *     env if the auto-pick misses (e.g. multiple NICs).
 *
 * Run:
 *   pnpm e2e:phone
 *
 * Expected wall-clock: 15-30 s (cold-boot Chrome on phone +
 * page load + Colyseus join + snapshot apply).
 */
import { test, expect } from '@playwright/test';
import { connectAndroidOrFallback } from './helpers/androidConnect';
import { pickLanIp, listLanCandidates } from './helpers/lanIp';

test('phone PoC — game boots on real Android device + DOM telemetry live', async () => {
  const lanIp = pickLanIp();
  const lanOrigin = `http://${lanIp}:5173`;
  // eslint-disable-next-line no-console
  console.log(`[phone-poc] LAN IP: ${lanIp} (candidates: ${JSON.stringify(listLanCandidates())})`);

  const testId = `phone-poc-${Date.now()}`;
  const url =
    `${lanOrigin}/?room=test-sector&spawnX=2000&spawnY=2000` +
    `&testId=${testId}&shipKind=Frigate`;
  // eslint-disable-next-line no-console
  console.log(`[phone-poc] navigating phone to: ${url}`);

  const conn = await connectAndroidOrFallback({
    mode: 'force-device',
    baseURL: url,
    extraOrigins: [lanOrigin],
  });

  try {
    expect(conn.kind, 'connected via _android (not desktop fallback)').toBe('android');

    await conn.page.waitForSelector('[data-testid="game-surface"]', { timeout: 30_000 });

    await conn.page.waitForFunction(
      () => {
        const el = document.querySelector('[data-hull-pct]');
        return el !== null && Number(el.getAttribute('data-hull-pct')) > 0;
      },
      undefined,
      { timeout: 20_000 },
    );

    const hullPct = Number(await conn.page.getAttribute('[data-hull-pct]', 'data-hull-pct'));
    const shipX = Number(await conn.page.getAttribute('[data-ship-x]', 'data-ship-x'));
    const shipY = Number(await conn.page.getAttribute('[data-ship-y]', 'data-ship-y'));

    expect(hullPct, 'hull-pct > 0 (server snapshot applied)').toBeGreaterThan(0);
    expect(Number.isFinite(shipX), 'ship-x is a finite number').toBe(true);
    expect(Number.isFinite(shipY), 'ship-y is a finite number').toBe(true);

    // eslint-disable-next-line no-console
    console.log(
      `[phone-poc] live game state on phone: hullPct=${hullPct}, shipX=${shipX}, shipY=${shipY}`,
    );

    await conn.page.screenshot({
      path: 'tests/mobile-perf/screenshots/phone-poc.png',
      fullPage: false,
    });
  } finally {
    await conn.cleanup();
  }
});
