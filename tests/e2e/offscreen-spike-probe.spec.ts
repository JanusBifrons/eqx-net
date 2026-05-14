import { test, expect, type ConsoleMessage } from '@playwright/test';

/**
 * Loads the OffscreenCanvas + worker spike, runs three interaction
 * checks, captures the log + console + page errors. Diagnostic only —
 * lets me iterate on the spike without needing the user's eyeballs.
 *
 *   1. Boot: worker should emit READY within ~3 s.
 *   2. Pan: pointer drag should NOT fire HEX_TAP (the camera detects
 *      drag-vs-tap via distance threshold).
 *   3. Zoom: wheel event should not throw.
 *   4. Tap: a quick pointerdown→pointerup at a hex centre should fire
 *      HEX_TAP for that hex's index.
 *
 * Result is in the printed `SPIKE LOG`. Spec passes if the page mounts;
 * the assertions are best-effort signals only.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

test('spike — boot + pan + zoom + tap, captured via Playwright', async ({ page }) => {
  test.setTimeout(45_000);

  const consoleMsgs: string[] = [];
  const pageErrors: string[] = [];

  page.on('console', (m: ConsoleMessage) => {
    consoleMsgs.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e: Error) => {
    pageErrors.push(`PAGEERROR ${e.message}`);
  });

  await page.goto(`${BASE_URL}/__offscreen-spike__/`, {
    waitUntil: 'domcontentloaded',
    timeout: 15_000,
  });

  // === 1. Boot ===
  await page.waitForTimeout(1500);
  const bootLog = await page.locator('#log').innerText();
  expect(bootLog, 'worker should emit READY').toContain('[ready]');

  // Canvas dimensions for screen-space pointer positions.
  const canvas = page.locator('#canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // === 2. Pan ===
  // Drag 100 px right + 50 px down. Should NOT fire HEX_TAP (drag, not tap).
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 50, cy + 30, { steps: 5 });
  await page.mouse.move(cx + 100, cy + 50, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  // === 3. Zoom ===
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -100); // wheel-up = zoom-in
  await page.waitForTimeout(200);
  await page.mouse.wheel(0, 200); // wheel-down = zoom-out
  await page.waitForTimeout(300);

  // === 4. Tap on a hex ===
  // The hexes are at world coords (400,400)..(800,600), with world initially
  // centred around (600,500). After our pan they've moved 100 px right +
  // 50 px down. After zoom changes scale may differ. Just tap at the
  // current canvas-centre — hex index 1 (world 600,400) is the one
  // initially at canvas-centre minus pan offset.
  //
  // The point of this test isn't pixel-perfect hex location; it's that
  // a quick tap (< tapThresholdPx, < tapThresholdMs) fires SOME hex
  // callback, proving the tap-vs-drag detection works.
  //
  // Strategy: re-load the page so we have a known initial state, then
  // tap at canvas-centre (where hex index 1 is initially).
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const box2 = await canvas.boundingBox();
  if (!box2) throw new Error('canvas has no bounding box after reload');
  const cx2 = box2.x + box2.width / 2;
  const cy2 = box2.y + box2.height / 2;

  await page.mouse.move(cx2, cy2);
  await page.mouse.down();
  await page.waitForTimeout(50); // < tapThresholdMs (250 ms)
  await page.mouse.up();
  await page.waitForTimeout(300);

  const finalLog = await page.locator('#log').innerText();

  // eslint-disable-next-line no-console
  console.log('\n=== SPIKE LOG (oldest at bottom) ===\n' + finalLog);
  // eslint-disable-next-line no-console
  console.log('\n=== PAGE CONSOLE ===\n' + consoleMsgs.join('\n'));
  // eslint-disable-next-line no-console
  console.log('\n=== PAGE ERRORS ===\n' + pageErrors.join('\n'));

  // Signal assertions — these are advisory not strict.
  expect(finalLog, 'a hex tap should have fired').toContain('[hex-tap]');
  expect(pageErrors.length, `unexpected page errors: ${pageErrors.join('; ')}`).toBe(0);
});
