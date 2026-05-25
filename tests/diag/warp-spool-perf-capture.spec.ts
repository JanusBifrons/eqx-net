// @diag (manual-only): see docs/architecture/e2e-framework.md
// Run: pnpm e2e:diag tests/diag/warp-spool-perf-capture.spec.ts
import { test, expect, type Page } from '@playwright/test';

/**
 * Phase F2 of the warp-spool perf investigation
 * (`docs/HANDOFF-warp-spool-perf-followup.md`).
 *
 * This spec is NOT a pass/fail regression lock — it is the **automated
 * data-capture** step (the handoff's "reproduce in Playwright FIRST;
 * the user's device is a last resort"). It drives a real join → warp
 * spool with the F1 per-frame sub-cost markers ACTIVE (markers gate on
 * `navigator.webdriver`, which Playwright sets), lets the warp visual +
 * a few seconds of steady in-game frames run so the markers accumulate,
 * then POSTs the `window.__eqxLogs` ring to `/diag/capture` exactly as
 * `src/client/debug/diagCapture.ts` does. The resulting
 * `diag/captures/<ts>-<id>/perf.ndjson` carries the 5 marker tags
 * (`renderer_update`, `warp_tick`, `grid_update`, `mirror_rebuild`,
 * `mirror_clone`) + `rafTick`/`raf_gap`; `scripts/analyze-frame-markers.mjs`
 * attributes the spool-frame cost from it.
 *
 * It prints `F2_CAPTURE_DIR=<dir>` to stdout so the parent harness can
 * locate the capture and run the analyzer.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function waitForLocalShip(page: Page, timeoutMs = 25_000): Promise<void> {
  await expect(page.locator('[data-testid="ship-stats-card"]')).toBeVisible({ timeout: timeoutMs });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: timeoutMs },
  );
}

test('warp-spool perf capture (F2 — data only, not a regression lock)', async ({ page }) => {
  test.setTimeout(90_000);

  // Sanity: the F1 markers must be active or the capture is useless.
  // They gate on `navigator.webdriver`, which Playwright always sets.
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(`PAGEERROR: ${e.message}`));

  // === Join — this plays the join warp visual (filter chain active)
  // under the 5 s minimum-display floor, with markers firing every
  // frame in the renderer worker. ===
  await page.goto(`${BASE_URL}/?galaxy=sol-prime`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });

  const diagEnabled = await page.evaluate(
    () => (window as unknown as { __eqxDiagEnabled?: boolean }).__eqxDiagEnabled === true,
  );
  expect(diagEnabled, 'F1 markers must be active (navigator.webdriver) for a useful capture').toBe(true);

  await waitForLocalShip(page);

  // Let the warp visual finish + accumulate steady-state in-game frames
  // so the capture spans BOTH the spool window and post-spool baseline
  // (the analyzer compares them). ~8 s of frames at ~60 Hz ≈ ~480
  // marker rows per tag — plenty for stable mean/p95.
  await page.waitForTimeout(8_000);

  // === Trigger the capture (same payload shape as
  // `src/client/debug/diagCapture.ts`; we POST directly so the spec
  // doesn't depend on a window-exposed hook). ===
  const result = await page.evaluate(async () => {
    const w = window as unknown as {
      __eqxLogs?: Array<{ ts: number; tag: string; data: Record<string, unknown> }>;
      __eqxEpoch?: number;
    };
    const logs = w.__eqxLogs ? [...w.__eqxLogs] : [];
    const body = {
      logs,
      note: 'F2 warp-spool perf capture (automated)',
      userAgent: navigator.userAgent,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      clientEpochMs: w.__eqxEpoch,
    };
    const res = await fetch('/diag/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; dir?: string; filename?: string; bytes?: number };
    // Count the F1 marker rows we actually captured, for a fast sanity
    // signal in the test output.
    const tags = ['renderer_update', 'warp_tick', 'grid_update', 'mirror_rebuild', 'mirror_clone'];
    const markerCounts: Record<string, number> = {};
    for (const t of tags) markerCounts[t] = logs.filter((e) => e.tag === t).length;
    return { ok: res.ok, json, markerCounts, totalLogs: logs.length };
  });

  // eslint-disable-next-line no-console
  console.log(`F2_MARKER_COUNTS=${JSON.stringify(result.markerCounts)} totalLogs=${result.totalLogs}`);
  expect(result.ok, 'POST /diag/capture should succeed').toBe(true);
  expect(result.json.ok, 'capture handler should report ok').toBe(true);
  const dir = result.json.dir ?? result.json.filename;
  expect(dir, 'capture should return a directory name').toBeTruthy();
  // The load-bearing sanity: the F1 markers actually fired during the
  // captured window. If any is 0 the instrumentation regressed.
  for (const [tag, n] of Object.entries(result.markerCounts)) {
    expect(n, `marker '${tag}' should have rows in the capture`).toBeGreaterThan(0);
  }
  // eslint-disable-next-line no-console
  console.log(`F2_CAPTURE_DIR=${dir}`);

  expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
});
