import { test, expect, type ConsoleMessage } from '@playwright/test';

/**
 * Phase 4 verification — loads the renderer-probe page that uses the
 * production `WorkerRendererClient` against the real
 * `renderer.worker.ts`. Verifies the worker boots, accepts mirror
 * updates, and posts FEEDBACK back. Diagnostic only — result is in
 * the printed `PROBE LOG`.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

test('renderer worker — boot + mirror + feedback round-trip', async ({ page }) => {
  test.setTimeout(45_000);

  const consoleMsgs: string[] = [];
  const pageErrors: string[] = [];

  page.on('console', (m: ConsoleMessage) => {
    consoleMsgs.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e: Error) => {
    pageErrors.push(`PAGEERROR ${e.message}`);
  });

  await page.goto(`${BASE_URL}/__offscreen-spike__/renderer-probe.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 15_000,
  });

  await page.waitForTimeout(3000);

  const logText = await page.locator('#log').innerText();

  // eslint-disable-next-line no-console
  console.log('\n=== PROBE LOG (newest at top) ===\n' + logText);
  // eslint-disable-next-line no-console
  console.log('\n=== PAGE CONSOLE ===\n' + consoleMsgs.join('\n'));
  // eslint-disable-next-line no-console
  console.log('\n=== PAGE ERRORS ===\n' + pageErrors.join('\n'));

  expect(logText, 'worker should boot via WorkerRendererClient').toContain('[ready]');
  expect(logText, 'feedback should round-trip back').toContain('[feedback]');
  expect(logText, 'probe should complete cleanly').toContain('[done]');
  expect(pageErrors.length, `unexpected page errors: ${pageErrors.join('; ')}`).toBe(0);
});
