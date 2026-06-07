/**
 * Speed-dial multitouch regression lock (smoke handoff 2026-06-06, Issue 3).
 *
 * User report: "[the speed dial] doesn't allow me to click as I move
 * (still)" — the dial can't be opened / its actions tapped while a steering
 * joystick touch is held.
 *
 * Root cause: MUI `SpeedDial` opens + activates via a synthesized CLICK, and
 * mobile browsers only synthesize a `click` from the PRIMARY touch sequence.
 * A touchstart on a SECOND simultaneous touch point (the dial, while the
 * joystick's first touch is held) produces no click → the dial never opens.
 * FIRE/BOOST escape this only because they bind `onTouchStart`. Fix: the FAB
 * + every action now bind `onTouchStart` too (with a synthesized-click
 * suppression window so they don't double-fire).
 *
 * ── Why a CDP session (Invariant #13: read where the bug LIVES) ──
 * The bug is a SECOND simultaneous touch while a first is held. Playwright's
 * single-pointer `page.touchscreen` / `.tap()` cannot express two concurrent
 * touch points — a single-pointer FAB tap already PASSES today
 * (`speed-dial.spec.ts`), so a test that doesn't hold a concurrent first
 * touch is in the wrong place. We drive `Input.dispatchTouchEvent` with two
 * touchPoints: point A held on the joystick, point B tapping the dial.
 *
 * ⚠️ AUTHORED, UNVERIFIED in the CI container (Playwright browsers blocked).
 * Run on a browser-capable host. If it reveals MUI's Tooltip wrapper does NOT
 * forward `onTouchStart` onto the action Fab, the documented fallback is a
 * custom FAB + absolutely-positioned action stack (see src/client/CLAUDE.md
 * SpeedDial entry).
 */
import { test, expect } from '@playwright/test';
import type { Page, CDPSession } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

interface Pt { x: number; y: number; }

async function centreOf(page: Page, testId: string): Promise<Pt> {
  const box = await page.locator(`[data-testid="${testId}"]`).boundingBox();
  if (!box) throw new Error(`no bounding box for ${testId}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// A held first touch (joystick) + a second tap (target), expressed as two
// concurrent touch points via CDP. `tap`: down then up of B while A stays
// down throughout. Touch ids are stable so the device tracks them.
async function secondTouchTap(cdp: CDPSession, held: Pt, tap: Pt): Promise<void> {
  // A goes down (held).
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: held.x, y: held.y, id: 1 }],
  });
  // B goes down while A is still down — the second simultaneous touch.
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: held.x, y: held.y, id: 1 }, { x: tap.x, y: tap.y, id: 2 }],
  });
  // B lifts (A still held).
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [{ x: tap.x, y: tap.y, id: 2 }],
  });
  // A lifts.
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [{ x: held.x, y: held.y, id: 1 }],
  });
}

test('dial opens and the map toggles via a SECOND touch while the joystick is held', async ({ browser }) => {
  // Touch context so isTouchDevice() (navigator.maxTouchPoints > 0) is true
  // and MobileControls + the joystick mount. `?worker=0` for the main-thread
  // renderer (touch default).
  const ctx = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE_URL}?room=sector&worker=0`);
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="ship-count"]');
        return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
      },
      { timeout: 15000 },
    );
    // Joystick + dial FAB must be present (touch device → MobileControls mounts).
    await expect(page.locator('[data-testid="mobile-joystick"]')).toBeVisible();
    await expect(page.locator('[data-testid="speed-dial-fab"]')).toBeVisible();

    const cdp = await page.context().newCDPSession(page);
    const joystick = await centreOf(page, 'mobile-joystick');
    const fab = await centreOf(page, 'speed-dial-fab');

    const mapToggle = page.locator('[data-testid="galaxy-map-toggle"]');
    const pressedBefore = await mapToggle.getAttribute('aria-pressed');

    // 1) Open the dial via a SECOND touch on the FAB while the joystick is held.
    await secondTouchTap(cdp, joystick, fab);
    // The dial should now be open — its actions become visible/activatable.
    await expect(mapToggle, 'dial did not open from a second-touch FAB tap').toBeVisible({ timeout: 2000 });

    // 2) Toggle the galaxy map via a SECOND touch on its action, joystick held.
    const mapPt = await centreOf(page, 'galaxy-map-toggle');
    await secondTouchTap(cdp, joystick, mapPt);

    await expect
      .poll(async () => mapToggle.getAttribute('aria-pressed'), {
        message: 'galaxy map aria-pressed did not flip from a second-touch action tap',
        timeout: 2000,
      })
      .not.toBe(pressedBefore);
  } finally {
    await ctx.close();
  }
});
