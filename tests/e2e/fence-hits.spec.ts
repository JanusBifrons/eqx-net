/**
 * Fence hits show in the game (bug, user report 2026-11-04: "the fence thing,
 * that's a bug" — shots into a shield fence vanished with no impact).
 *
 * Repro: `gate-test` room; the east gate (x 400, y -900) is owner-only, so a
 * visiting pilot spawned south of it (x 400, y -1300) faces a closed fence.
 * Not -1150: that point touches the gate's footprint, so the game nudges the
 * spawn to (294, -1256), where the gate sits ~0.29 rad off the nose, past the
 * fixed guns' 0.2 rad fire tolerance: the lock completed but no bolt flew
 * (0/6 on 2026-11-09; found with a probe 2026-11-12).
 * Holding fire sends bolts into it. With the new effects the fence must play
 * ripples (`__eqxArtStats().fxFenceHits`). `?worker=0` so the hook reads the
 * live renderer; a cold join plus the first-visit bake is the only wait.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { waitForInPlay } from './helpers/gameScenario';
import { DEFAULT_BASE_URL } from './helpers/ports';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;
test.describe.configure({ timeout: 90_000 });

test('bolts fired into a closed fence ripple on it', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const params = new URLSearchParams({
    room: 'gate-test', spawnX: '400', spawnY: '-1300', shipKind: 'fighter', testId: randomUUID(),
    worker: '0', art: 'machined', fx: 'new', zoom: '1',
    // Lock-to-fire (2026-11-09): anyTarget lets the AUTO group pick the
    // (non-hostile, not-ours) fence gate ahead; instantLock locks it at once.
    instantLock: '1',
    anyTarget: '1',
  });
  await page.goto(`${BASE_URL}?${params}`);
  type S = { fxFences?: number; fxFenceHits?: number };
  await page.waitForFunction(() => ((window as unknown as { __eqxArtStats?: () => S }).__eqxArtStats?.().fxFences ?? 0) > 0,
    undefined, { timeout: 60_000 });
  // The fighter's group starts in AUTO and locks the gate ahead (instantLock +
  // anyTarget), so it fires on its own once the curtain lifts: no input. (The
  // old click + 12 Space presses cost ~45 s on the main-thread renderer in
  // headless Chrome, ~2.8 s per press, and pushed the run past 90 s.)
  await waitForInPlay(page);
  await page.waitForFunction(() => ((window as unknown as { __eqxArtStats?: () => S }).__eqxArtStats?.().fxFenceHits ?? 0) > 0,
    undefined, { timeout: 20_000 });
  expect(await page.evaluate(() => (window as unknown as { __eqxArtStats: () => S }).__eqxArtStats().fxFenceHits)).toBeGreaterThan(0);
  await ctx.close();
});
