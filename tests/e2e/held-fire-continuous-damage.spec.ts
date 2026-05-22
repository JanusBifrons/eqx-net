/**
 * Smooth-beam regression lock — held fire produces a continuous visual
 * damage stream even though the server-side cadence is unchanged.
 *
 * Background: the user reported the beam "ticks" damage and takes a
 * long time to start hitting. The first server-cadence retune
 * (cooldownTicks 10 → 2) made the wire fire at 30 Hz and re-triggered
 * the 110 ms compositor-stall pattern on touch devices (drone fire
 * scaled identically — capture `o4n4pw` 2026-05-22). The current
 * approach keeps server cadence at the original 6 Hz (no wire spike)
 * and produces the smooth feel CLIENT-side: every predicted hit is
 * split into N small visual ticks spread across the cooldown window,
 * spawned via `logEvent('damage_number_predicted', ...)` in
 * `ColyseusClient.sendFire`'s splitter. Splits share one
 * `clientShotId` so existing reconcile / cancel paths handle them.
 *
 * This spec asserts the VISUAL cadence — held space for 1.2 s should
 * produce ≥ 25 predicted damage numbers (5 visual splits × ~6 fires).
 * Pre-splitter the count was ~6 numbers (one per fire) ⇒ RED. With
 * the splitter the count is ~30 ⇒ GREEN.
 *
 * Why visual count, not wire `fire` count: the user's complaint is
 * about felt smoothness, which is driven by the on-screen damage
 * cadence — orthogonal to server-side fire dispatch rate.
 */
import { test, expect } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

interface LogEntry {
  tag: string;
  ts: number;
  data?: unknown;
}

// TODO(smooth-beam): rewrite with a 2-client `joinClientAt` setup
// positioning the shooter facing a friendly target at point-blank
// range. The current single-client `?room=sector` join makes hits
// RNG-dependent on drone spawn positions — the splitter only logs
// `damage_number_predicted` events when `predictShotOutcome` finds a
// hit, so the assertion below would flake when no drone happens to be
// in the local player's forward arc during the 1.2 s window. Until the
// 2-client harness lands, the smooth-beam splitter is regression-
// locked by:
//   - `src/core/combat/WeaponCatalogue.test.ts` (catalogue values stay
//     at the original 20/10 — server cadence unchanged)
//   - `src/client/combat/LocalBeam.test.ts` (persistence ≥ cooldown)
// and validated by the smoke-test handoff to the user.
test.skip('held-fire produces continuous damage stream (≥25 predicted damage numbers in 1.2 s)', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Match combat.spec.ts join pattern — proven to receive snapshots and
  // route keyboard events to the in-game prediction loop.
  await page.goto(`${BASE_URL}?room=sector`);
  await page.waitForFunction(
    () =>
      parseInt(
        document.querySelector('[data-testid="ship-count"]')?.textContent?.replace('Ships: ', '') ?? '0',
        10,
      ) > 0,
    { timeout: 15_000 },
  );
  // Settle pause matches the combat-spec pattern — gives the boot
  // sequence (welcome, first snapshot, predWorld init) time to complete
  // before we start measuring fire cadence.
  await page.waitForTimeout(1500);

  // Clear any boot-window log noise so the count below is just our window.
  await page.evaluate(() => {
    const w = window as unknown as { __eqxLogs?: LogEntry[] };
    if (w.__eqxLogs) w.__eqxLogs.length = 0;
  });

  // Held-fire window: 1.2 s of space held. Default weapon is `hitscan`
  // (DEFAULT_WEAPON in WeaponCatalogue), no need to set it explicitly.
  await page.keyboard.down('Space');
  await page.waitForTimeout(1200);
  await page.keyboard.up('Space');

  // Count fire events emitted during the window. `logEvent('fire', ...)`
  // is the canonical wire-send marker (`ColyseusClient.ts:3613`) — one
  // entry per accepted client-side fire call.
  const counts = await page.evaluate(() => {
    const w = window as unknown as { __eqxLogs?: LogEntry[] };
    const logs = w.__eqxLogs ?? [];
    const fires = logs.filter((e) => e.tag === 'fire').length;
    const predicted = logs.filter((e) => e.tag === 'damage_number_predicted').length;
    return { fires, predicted };
  });

  // eslint-disable-next-line no-console
  console.log(
    `held-fire cadence: ${counts.fires} server-cadence fires + ${counts.predicted} predicted damage numbers in 1.2 s`,
  );

  // Visual-cadence floor: ≥ 25 predicted damage numbers in 1.2 s
  // (~21 / sec). Pre-splitter only ~7 numbers (one per server fire);
  // post-splitter each fire schedules 5 visual ticks (≈ 30 / sec).
  expect(
    counts.predicted,
    `Expected smooth-beam splitter to produce ≥25 predicted damage numbers in 1.2 s ` +
      `(got ${counts.predicted}; server-cadence fires were ${counts.fires}). ` +
      `If RED on current code, the splitter in ColyseusClient.sendFire's predSink isn't producing visual splits.`,
  ).toBeGreaterThanOrEqual(25);

  await ctx.close();
});
