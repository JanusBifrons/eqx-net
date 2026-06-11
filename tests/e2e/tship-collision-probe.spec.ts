import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * T-ship collision VISUAL probe (screenshot-first) — playtest 2026-06-10
 * Issue 4. Drives `tship-collision-probe.html` — a real main-thread
 * `PixiRenderer` rendering the two CROSSGUARD T-ships at the exact
 * `hull-collision-test` interlocking poses — and captures the frame into
 * `diag/e2e-screenshots/tship-collision/`.
 *
 * NOT a pixel-assertion test; it's the casual-verification artifact the user
 * asked for ("identifiable via screenshot"). Captures TWO scenarios:
 *   - `interlock` — A(-40.5,10.5,0) + B(40.5,-10.5,π): the exact 1-unit-gap
 *     interlock. T's render as true clean T's (upright + inverted), nested as
 *     tightly as possible WITHOUT touching (all three contact faces 1 u apart).
 *   - `overlap` — same A, B pulled in to (10.5,-10.5,π): the stems now overlap
 *     by ~20 u, so the silhouettes visibly intersect (the case the collision
 *     POSITIVE control fires on).
 *
 * Collision behaviour is locked deterministically by the physics unit test
 * `src/core/physics/hullCollisionNoTouch.test.ts` (1 u gap → 0 contacts;
 * interlock closed + same-point → contacts fire) and the full-stack E2E
 * `t-ship-no-self-collision.spec.ts`; this spec is the human/agent eyeball.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
/** Camera zoom (higher = closer). ~1.8 frames both ~280×280 crossguards. */
const ZOOM = 1.8;
const OUT_DIR = join(process.cwd(), 'diag', 'e2e-screenshots', 'tship-collision');

interface TShipProbeApi {
  setShip: (which: 'a' | 'b', x: number, y: number, angle: number) => void;
  postFrame: () => void;
  runFrames: (frames: number) => Promise<void>;
}
interface ProbeWindow extends Window {
  __tshipProbe?: TShipProbeApi;
}

async function capture(page: Page, name: string): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  await page.screenshot({ path: join(OUT_DIR, `${name}.png`), fullPage: false });
}

test('crossguard interlocking-T orientation (visual)', async ({ page }) => {
  // Infrastructural budget (Vite cold-compile of the probe page + browser boot
  // + two screenshot scenarios) — NOT a game-time wait; the rAF render loops
  // are sub-second. The probe is a diagnostic artifact, so a generous infra
  // timeout is appropriate (harness philosophy: bump for infra, not gameplay).
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`));

  await page.goto(`${BASE_URL}/__offscreen-spike__/tship-collision-probe.html?zoom=${ZOOM}`, {
    waitUntil: 'domcontentloaded',
    timeout: 15_000,
  });
  await page.waitForFunction(
    () => (window as unknown as ProbeWindow).__tshipProbe !== undefined,
    { timeout: 15_000 },
  );

  // Scenario 1 — the exact 1 u-gap interlock (default poses). Settle the
  // camera on ship A + build both silhouettes.
  await page.evaluate(async () => {
    await (window as unknown as ProbeWindow).__tshipProbe!.runFrames(30);
  });
  await capture(page, 'interlock');

  // Scenario 2 — pull B in toward A so the stems OVERLAP by ~20 u (the
  // collision POSITIVE case). A stays put; B moves from x=40.5 to x=10.5.
  await page.evaluate(async () => {
    const p = (window as unknown as ProbeWindow).__tshipProbe!;
    p.setShip('b', 10.5, -10.5, Math.PI);
    await p.runFrames(20);
  });
  await capture(page, 'overlap');

  const probeErr = await page.locator('#host').getAttribute('data-probe-error');
  expect(probeErr, `probe boot error: ${probeErr}`).toBeNull();
  expect(errors, errors.join('\n')).toEqual([]);
});
