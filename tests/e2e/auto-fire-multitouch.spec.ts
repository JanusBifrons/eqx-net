/**
 * AUTO-fire toggle multitouch regression lock (playtest 2026-06-10, Issue 1).
 *
 * User report: "only one input at once on mobile; steering blocks buttons —
 * only the auto button is impacted." The AUTO toggle could not be tapped while
 * a steering joystick touch was held.
 *
 * Root cause (same class as the SpeedDial multitouch bug): mobile browsers
 * synthesize a `click` ONLY for the PRIMARY touch sequence. A touchstart on a
 * SECOND simultaneous touch point (the AUTO toggle, while the joystick's first
 * touch is held) produces no click → the onClick-only toggle never fired.
 * FIRE/BOOST + the SpeedDial escape this by binding `onTouchStart`. Fix: the
 * AUTO toggle now binds `onTouchStart` too (shared `useTouchClickActivate`),
 * with a synthesized-click suppression window so it doesn't double-toggle.
 *
 * ── Why a CDP session (Invariant #13: read where the bug LIVES) ──
 * The bug is a SECOND simultaneous touch while a first is held. Playwright's
 * single-pointer `.tap()` cannot express two concurrent touch points — a
 * single-pointer tap already PASSES today. We drive `Input.dispatchTouchEvent`
 * with two touchPoints: point A held on the joystick, point B tapping AUTO.
 * The flip must happen EXACTLY once (locks the dead-button bug AND the
 * historical double-toggle).
 *
 * ⚠️ AUTHORED, UNVERIFIED in the CI container (Playwright browsers blocked).
 * Run on a browser-capable host.
 */
import { test, expect } from '@playwright/test';
import type { Page, CDPSession } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

interface Pt {
  x: number;
  y: number;
}

async function centreOf(page: Page, testId: string): Promise<Pt> {
  const box = await page.locator(`[data-testid="${testId}"]`).boundingBox();
  if (!box) throw new Error(`no bounding box for ${testId}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// A held first touch (joystick) + a second tap (target), expressed as two
// concurrent touch points via CDP. `tap`: down then up of B while A stays
// down throughout. Touch ids are stable so the device tracks them.
async function secondTouchTap(cdp: CDPSession, held: Pt, tap: Pt): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: held.x, y: held.y, id: 1 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: held.x, y: held.y, id: 1 },
      { x: tap.x, y: tap.y, id: 2 },
    ],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [{ x: tap.x, y: tap.y, id: 2 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [{ x: held.x, y: held.y, id: 1 }],
  });
}

test('AUTO toggles via a SECOND touch while the joystick is held — exactly once', async ({
  browser,
}) => {
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
    await expect(page.locator('[data-testid="mobile-joystick"]')).toBeVisible();
    const auto = page.locator('[data-testid="auto-fire-toggle"]');
    await expect(auto).toBeVisible();

    const stateBefore = await auto.getAttribute('data-state'); // 'on' by default

    const cdp = await page.context().newCDPSession(page);
    const joystick = await centreOf(page, 'mobile-joystick');
    const autoPt = await centreOf(page, 'auto-fire-toggle');

    // A SECOND touch on AUTO while the joystick is held must flip it once.
    await secondTouchTap(cdp, joystick, autoPt);

    await expect
      .poll(async () => auto.getAttribute('data-state'), {
        message: 'AUTO did not toggle from a second-touch tap while steering (dead-button bug)',
        timeout: 2000,
      })
      .not.toBe(stateBefore);

    // And it must NOT double-toggle straight back (the suppression window).
    const stateAfter = await auto.getAttribute('data-state');
    // Give any trailing synthesized click time to (wrongly) land.
    await page.waitForTimeout(300);
    expect(
      await auto.getAttribute('data-state'),
      'AUTO double-toggled back (synthesized click not suppressed)',
    ).toBe(stateAfter);
  } finally {
    await ctx.close();
  }
});
