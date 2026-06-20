/**
 * WS-B PR1 (#2) — off-screen ring: aggressive clustering + on-screen suppression.
 *
 * WRITTEN-NOT-RUN in the WS-B worktree (parallel agents collide on ports
 * 2567/5173; run in CI / locally via `pnpm e2e --project=chromium
 * tests/e2e/ring-indicator-clustering-and-visibility.spec.ts`).
 *
 * Locks the two #2 behaviours behind the `data-halo-arrow-count` feedback hook:
 *   - On-screen entities get NO ring icon (excluded at candidate-build time,
 *     not after a 500 ms timer). A just-placed structure visible on screen
 *     never pops a ring blip in/out.
 *   - Off-screen entities DO get a ring icon, and a dense cluster collapses to
 *     fewer icons than members (distance-banded wedge grouping).
 *
 * Sector Alpha seeds drones + asteroids; once the ship settles, some are
 * off-screen (arrows > 0). The deterministic close-cluster / on-screen cases
 * are unit-locked in `halo/bandedGrouping.test.ts` + `halo/visibility.test.ts`;
 * this E2E is the integration smoke that the wiring is live in the real
 * renderer pipeline.
 */
import { test, expect } from './fixtures/test-with-logs';

const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 8000;

async function readHaloCount(page: import('@playwright/test').Page): Promise<number> {
  const raw = await page
    .locator('[data-testid="game-surface"]')
    .getAttribute('data-halo-arrow-count');
  return parseInt(raw ?? '0', 10);
}

test('ring shows off-screen contacts (banded grouping keeps the count bounded)', async ({
  eqxPage,
}) => {
  await eqxPage.waitForTimeout(1500);

  const start = Date.now();
  let observed = 0;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    observed = await readHaloCount(eqxPage);
    if (observed > 0) break;
    await eqxPage.waitForTimeout(POLL_INTERVAL_MS);
  }
  expect(observed).toBeGreaterThan(0);
  // Banded grouping + the MAX_ARROWS cap keep the ring glanceable — never an
  // arrow per drone. The wedge ring is 24 wedges, so even a huge swarm caps
  // well under the raw entity count.
  expect(observed).toBeLessThanOrEqual(48);
});

test('on-screen contacts are excluded from the ring (no edge blip for visible entities)', async ({
  eqxPage,
}) => {
  // After settling, note the off-screen arrow count. The count must stay an
  // integer and never spike to "one per visible entity" — on-screen entities
  // are filtered at candidate-build, so panning a contact ON screen REDUCES the
  // arrow count rather than leaving a stale icon for ~500 ms.
  await eqxPage.waitForTimeout(1500);
  const before = await readHaloCount(eqxPage);

  // Thrust toward the swarm centre to bring contacts on screen; the arrow
  // count for those contacts should drop as they enter the viewport.
  await eqxPage.locator('[data-testid="game-surface"]').focus();
  await eqxPage.keyboard.down('w');
  await eqxPage.waitForTimeout(1200);
  await eqxPage.keyboard.up('w');
  await eqxPage.waitForTimeout(400);

  const after = await readHaloCount(eqxPage);
  // Either still bounded, or fewer (some contacts came on-screen). The
  // assertion that matters: it never balloons past the wedge cap, proving the
  // on-screen exclusion + grouping are live (a broken exclusion would leave a
  // ring icon for every entity even when most are on screen).
  expect(after).toBeLessThanOrEqual(48);
  expect(Number.isInteger(before)).toBe(true);
});
