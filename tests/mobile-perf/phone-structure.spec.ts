/**
 * On-device proof for the Generic Entity Pipeline P4 "structure for free":
 * load the `structure-test` room on the real Android phone and confirm the
 * kind=2 STRUCTURE renders (decodes into the client swarm mirror) on hardware,
 * not just in headless chromium. Captures a screenshot for visual evidence.
 *
 * Run: pnpm exec cross-env MOBILE_PERF_MODE=force-device playwright
 *        test --config=playwright.mobile-perf.config.ts
 *        tests/mobile-perf/phone-structure.spec.ts
 */
import { test, expect } from '@playwright/test';
import { connectAndroidOrFallback } from './helpers/androidConnect';
import { pickLanIp } from './helpers/lanIp';
import { assertPhoneAwakeAndUnlocked } from './helpers/adbPreflight';

test('phone — a kind=2 structure renders on the real device (GEP P4)', async () => {
  assertPhoneAwakeAndUnlocked();
  const lanOrigin = `http://${pickLanIp()}:5173`;
  const url = `${lanOrigin}/?room=structure-test&testId=phone-struct-${Date.now()}`;
  // eslint-disable-next-line no-console
  console.log(`[phone-structure] navigating phone to: ${url}`);

  const conn = await connectAndroidOrFallback({ mode: 'force-device', baseURL: url, extraOrigins: [lanOrigin] });
  try {
    expect(conn.kind, 'connected via _android (not desktop fallback)').toBe('android');
    await conn.page.waitForSelector('[data-testid="game-surface"]', { timeout: 30_000 });

    // Joined: hull state propagated.
    await conn.page.waitForFunction(
      () => {
        const el = document.querySelector('[data-hull-pct]');
        return el !== null && Number(el.getAttribute('data-hull-pct')) > 0;
      },
      undefined,
      { timeout: 20_000 },
    );

    // RENDER on-device: the structure decoded into the swarm mirror.
    await conn.page.waitForFunction(
      () => {
        const txt = document.querySelector('[data-testid="swarm-count"]')?.textContent ?? '';
        const m = txt.match(/\d+/);
        return m ? Number(m[0]) >= 1 : false;
      },
      undefined,
      { timeout: 15_000 },
    );

    const swarm = (await conn.page.textContent('[data-testid="swarm-count"]'))?.match(/\d+/)?.[0] ?? '0';
    // eslint-disable-next-line no-console
    console.log(`[phone-structure] on-device swarm-count (structure present): ${swarm}`);
    expect(Number(swarm)).toBeGreaterThanOrEqual(1);

    await conn.page.screenshot({ path: 'tests/mobile-perf/screenshots/phone-structure.png', fullPage: false });
  } finally {
    await conn.cleanup();
  }
});
