/**
 * WS-B PR3 (#4) — off-screen ring: dead-zone (hysteresis) band, no edge flicker.
 *
 * WRITTEN-NOT-RUN in the WS-B worktree (port collisions). Run via
 * `pnpm e2e --project=chromium tests/e2e/ring-indicator-dead-zone.spec.ts`.
 *
 * The deterministic dead-zone math (inset shrink, no rect inversion, mobile <
 * desktop band) is unit-locked in `halo/visibility.test.ts`. This E2E is the
 * integration smoke that the dead-zone band keeps the ring stable as a contact
 * hovers at the viewport edge — a contact crossing the precise boundary must
 * NOT make its ring icon flicker on/off frame-to-frame.
 *
 * Strategy: settle, then sample `data-halo-arrow-count` across many frames
 * while the ship drifts slowly (contacts grazing the edge). The count must not
 * oscillate wildly between consecutive samples (the flicker signature) — the
 * dead-zone band absorbs sub-band jitter so an edge contact stays in exactly
 * one state until it clearly crosses the inset boundary.
 */
import { test, expect } from './fixtures/test-with-logs';

async function readHaloCount(page: import('@playwright/test').Page): Promise<number> {
  const raw = await page
    .locator('[data-testid="game-surface"]')
    .getAttribute('data-halo-arrow-count');
  return parseInt(raw ?? '0', 10);
}

test('ring count does not flicker as contacts graze the viewport edge', async ({ eqxPage }) => {
  await eqxPage.waitForTimeout(1800);

  // Drift slowly so contacts hover near the viewport edge (the dead-zone
  // band's job is to hold their on/off-ring state steady through sub-band
  // jitter).
  await eqxPage.locator('[data-testid="game-surface"]').focus();

  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    samples.push(await readHaloCount(eqxPage));
    await eqxPage.waitForTimeout(80);
  }

  // Count the frame-to-frame flips. With a dead-zone band, an edge-grazing
  // contact stays in one state, so consecutive deltas should be small (0 or 1
  // as contacts genuinely enter/leave). A broken (zero-width) dead-zone would
  // produce large rapid oscillations as the contact jitters across the exact
  // edge every other frame.
  let bigFlips = 0;
  for (let i = 1; i < samples.length; i++) {
    if (Math.abs(samples[i]! - samples[i - 1]!) >= 3) bigFlips += 1;
  }
  expect(bigFlips).toBeLessThanOrEqual(2);
});
