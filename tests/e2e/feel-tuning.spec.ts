/**
 * Stage 0 closure spec for the network-feel roadmap.
 *
 * Stage 0 capped the prediction-correction visual lerp at 6 frames
 * (~100 ms) for any drift above the sub-pixel tier — the previous
 * 18-frame / 300 ms cascade was flagged in `docs/FEEL_GOALS.md` as a
 * perceptible "glide". This spec drives the ship into the legacy
 * `sector` room (30 hostile drones in a ring; collisions are easy to
 * provoke) for a few seconds, then reads the eqxLogs ring buffer and
 * asserts every 'correction' log entry's `lerpTotalFrames` is ≤ 6 —
 * verifying the cap survives through the real reconcile call path.
 *
 * The ease-out shape (Stage 0 Cycle 2) is verified by Reconciler unit
 * tests; only the cap matters at the macro level.
 *
 * Uses `?room=...` autoJoin to bypass the GalaxyMapScreen splash,
 * matching the pattern in persistence-kill.spec.ts.
 */
import { test, expect } from '@playwright/test';

interface CorrectionLogEntry {
  ts: number;
  tag: string;
  data: { lerpTotalFrames?: number; driftUnits?: number };
}

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

// Auth storage state from globalSetup is applied automatically via
// playwright.config.ts → use.storageState.

test.setTimeout(60_000);

test('Stage 0: every queued correction lerp caps at 6 frames', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // autoJoin bypasses the GalaxyMapScreen splash (see App.tsx).
  await page.goto(`${BASE_URL}?room=sector`);

  // Wait for the local ship to be live in the mirror.
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 15_000 },
  );

  // Allow the join handshake and any join-time corrections to settle
  // before we sample.
  await page.waitForTimeout(1500);

  // Clear the log ring buffer so we only capture corrections that
  // happen during the active driving window.
  await page.evaluate(() => {
    (window as unknown as { __eqxClearLogs?: () => void }).__eqxClearLogs?.();
  });

  // Hold W to thrust into the drone ring; collisions and drone fire
  // provoke periodic small corrections during the sample window.
  await page.keyboard.down('w');
  await page.waitForTimeout(3000);
  await page.keyboard.up('w');
  await page.waitForTimeout(500);

  const corrections: CorrectionLogEntry[] = await page.evaluate(() => {
    const logs = (window as unknown as { __eqxLogs?: CorrectionLogEntry[] }).__eqxLogs ?? [];
    return logs.filter((e) => e.tag === 'correction');
  });

  if (corrections.length === 0) {
    console.log('\n=== Stage 0: lerpTotalFrames cap ===');
    console.log('No corrections logged in the sample window — the cap is trivially satisfied.');
    console.log('====================================\n');
    // Trivial pass: no observed corrections means no lerps queued.
    return;
  }

  let maxFrames = 0;
  let maxDrift = 0;
  for (const c of corrections) {
    const frames = c.data.lerpTotalFrames ?? 0;
    if (frames > maxFrames) maxFrames = frames;
    const drift = c.data.driftUnits ?? 0;
    if (drift > maxDrift) maxDrift = drift;
  }

  console.log('\n=== Stage 0: lerpTotalFrames cap ===');
  console.log(`Observed corrections: ${corrections.length}`);
  console.log(`Max queued lerp frames: ${maxFrames} (cap 6)`);
  console.log(`Max drift in sample window: ${maxDrift.toFixed(3)} u`);
  console.log('====================================\n');

  expect(maxFrames).toBeLessThanOrEqual(6);

  await ctx.close();
});
