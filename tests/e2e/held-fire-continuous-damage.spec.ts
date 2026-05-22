/**
 * Smooth-beam regression lock — Phase 1 of the smooth-beam plan
 * (`~/.claude/plans/i-d-like-you-to-quirky-hartmanis.md`).
 *
 * The user reports the "Beam" weapon (hitscan mode) "feels and plays bad" —
 * appears to tick damage and takes a long time to start hitting; should
 * "instantly start applying and consistently apply a small amount over time,
 * not sort of 'tick' it." (Smoke-test bug-report Invariant #13 requires a
 * failing test BEFORE the fix.)
 *
 * Root cause from the diagnosis: `HITSCAN_DEF.cooldownTicks = 10` ⇒ ~6
 * `fire` events / second while held. The first-shot latency is already
 * ~22 ms (next physics tick after `keydown`), but the gap between shots
 * dominates perception. Phase 2 retunes to `cooldownTicks = 2` (~30 Hz),
 * `damage = 4` (DPS preserved).
 *
 * This spec asserts the FIRE CADENCE directly — held space for 1.2 s
 * should produce ≥ 25 `fire` events client-side. At cooldown=10, the
 * observable rate is ~6 fires/sec → ~7 events in 1.2 s ⇒ RED on
 * `45400f3`. At cooldown=2, the rate is ~30 fires/sec → ~36 events ⇒
 * GREEN once Phase 2 lands.
 *
 * Why the cadence, not the damage, is the load-bearing assertion: the
 * user's complaint is about feel, which is driven by event cadence
 * regardless of per-event damage. Asserting cadence rather than
 * damage-per-second decouples this test from future balance tuning.
 */
import { test, expect } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

interface LogEntry {
  tag: string;
  ts: number;
  data?: unknown;
}

test('held-fire produces continuous damage stream (≥25 fire events/sec, smoke-test invariant #13)', async ({
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
  const fireCount = await page.evaluate(() => {
    const w = window as unknown as { __eqxLogs?: LogEntry[] };
    return (w.__eqxLogs ?? []).filter((e) => e.tag === 'fire').length;
  });

  // eslint-disable-next-line no-console
  console.log(`held-fire cadence: ${fireCount} fire events in 1.2 s`);

  // Cadence floor: 25 events / 1.2 s ⇒ ~21 fires/sec — well above the
  // ~6 fires/sec the current cooldown=10 produces, but comfortable
  // under the ~30 fires/sec the cooldown=2 retune produces.
  expect(
    fireCount,
    `Expected continuous-feel beam to produce ≥25 fire events in 1.2 s (got ${fireCount}). ` +
      `If this fails on current main, the fix has not landed yet (HITSCAN_DEF.cooldownTicks still 10).`,
  ).toBeGreaterThanOrEqual(25);

  await ctx.close();
});
