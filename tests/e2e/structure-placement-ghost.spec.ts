/**
 * Structure placement: world ghost, desktop one-click place, cancel, and the
 * world-anchored touch confirm (smoke handoff 2026-06-06 Issue 5 + WS-10 R2.5).
 *
 * Desktop placement contract (WS-10 / R2.5, user-chosen one-click model):
 *   - pick a kind → translucent blueprint GHOST follows the pointer on HOVER
 *   - LEFT-CLICK places the structure at the cursor immediately (RTS-style)
 *   - RIGHT-CLICK or ESCAPE cancels placement
 * Touch keeps the two-step tap-to-position → Confirm-banner flow (case B) — a
 * mouse pointerup commits, a touch pointerup only parks the ghost.
 *
 * Tests read the REAL artifacts (the projected ghost `data-placement-screen-x/y`,
 * the parked-point `data-placement-world-x/y`, the landed `data-swarm-detail`
 * kind-2 entry, the `structure_place_confirm` log) — never a recompute (the
 * test-observable-reads-actual-output lesson).
 *
 * ⚠️ AUTHORED, UNVERIFIED in the CI container (Playwright browsers blocked).
 * Run on a browser-capable host. `?worker=0` forces the main-thread renderer
 * (the OffscreenCanvas worker path screenshots black); `?worker=1` exercises the
 * worker path (pointer events forwarded via POINTER_EVENT → forwardPointerEvent,
 * the one-click confirm seq crosses the worker FEEDBACK boundary).
 */
import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function joinAndOpenBuild(
  browser: Browser,
  opts: { mobile: boolean; worker?: boolean; extraQuery?: string },
): Promise<{ ctx: Awaited<ReturnType<Browser['newContext']>>; page: Page }> {
  const ctx = await browser.newContext(
    opts.mobile
      ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }
      : { viewport: { width: 1280, height: 800 } },
  );
  const page = await ctx.newPage();
  // `worker !== true` → force the main-thread renderer (?worker=0); pass
  // `worker:true` to exercise the OffscreenCanvas WORKER path.
  const workerParam = opts.worker === true ? '&worker=1' : '&worker=0';
  const extra = opts.extraQuery ?? '';
  await page.goto(`${BASE_URL}?room=test-sector-fast&shipKind=scout${workerParam}${extra}`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="game-surface"]');
      return el !== null && el.getAttribute('data-local-player-id') !== '';
    },
    { timeout: 12_000 },
  );
  await page.locator('[data-testid="speed-dial-fab"]').click();
  await page.locator('[data-testid="speed-dial-build"]').click();
  // WS-13: the Build menu now drills Build ▸ category ▸ kind. Every test here
  // builds a Capital (Core category), so enter Core and leave the dial at the
  // kinds level for the per-test `build-capital` click.
  await page.locator('[data-testid="build-cat-core"]').click();
  return { ctx, page };
}

function swarmCount(page: Page): Promise<number> {
  return page
    .locator('[data-testid="swarm-count"]')
    .textContent()
    .then((t) => parseInt((t ?? '0').replace(/\D/g, '') || '0', 10));
}

const surfaceAttr = (page: Page, name: string): Promise<string | null> =>
  page.locator('[data-testid="game-surface"]').getAttribute(name);

// P3.6 / WS-C4b — the Confirm/Cancel banner is now TOUCH-ONLY, so DESKTOP tests
// can no longer use `placement-banner` visibility as the "placement active"
// signal. `data-placement-screen-x` is the render-path-independent signal
// gameRafLoop publishes while the blueprint ghost is up (set during placement,
// deleted on commit/cancel). These wait on it instead.
const waitPlacementActive = (page: Page): Promise<unknown> =>
  page.waitForFunction(
    () => {
      const v = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-placement-screen-x');
      return v !== null && v !== '' && Number.isFinite(parseFloat(v));
    },
    undefined,
    { timeout: 5_000 },
  );
const waitPlacementCleared = (page: Page): Promise<unknown> =>
  page.waitForFunction(
    () => {
      const v = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-placement-screen-x');
      return v === null || v === '';
    },
    undefined,
    { timeout: 5_000 },
  );

test('(A) picking a kind draws + projects the world ghost (data-placement-screen present)', async ({ browser }) => {
  const { ctx, page } = await joinAndOpenBuild(browser, { mobile: false });
  try {
    await expect(page.locator('[data-testid="build-capital"]')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="build-capital"]').click();

    // The ghost is drawn in the world and its pose projected to screen — the
    // REAL artifact (read what's drawn/projected, not a recompute).
    await page.waitForFunction(
      () => {
        const v = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-placement-screen-x');
        return v !== null && v !== undefined && v !== '' && Number.isFinite(parseFloat(v));
      },
      undefined,
      { timeout: 5_000 },
    );
    const sx = await surfaceAttr(page, 'data-placement-screen-x');
    const sy = await surfaceAttr(page, 'data-placement-screen-y');
    expect(Number.isFinite(parseFloat(sx ?? 'NaN'))).toBe(true);
    expect(Number.isFinite(parseFloat(sy ?? 'NaN'))).toBe(true);

    await expect(page.locator('[data-testid="game-surface"]')).toHaveScreenshot('placement-ghost-capital.png', {
      maxDiffPixelRatio: 0.05,
    });
  } finally {
    await ctx.close();
  }
});

test('(B) TOUCH: tap-to-position parks the ghost, then confirm is clickable at a MOBILE viewport', async ({ browser }) => {
  const { ctx, page } = await joinAndOpenBuild(browser, { mobile: true });
  try {
    const before = await swarmCount(page);

    await expect(page.locator('[data-testid="build-capital"]')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="build-capital"]').click();

    // Tap-to-position (touch keeps the two-step flow): a touch tap on the world
    // canvas positions + PARKS the blueprint (it does NOT one-click place — only
    // a mouse pointerup commits). The Confirm banner is HIDDEN until parked.
    await page.touchscreen.tap(195, 220); // clear of the centred ship
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-placement-stuck') === '1',
      undefined,
      { timeout: 5_000 },
    );

    const confirm = page.locator('[data-testid="placement-confirm"]');
    await expect(confirm).toBeVisible({ timeout: 5_000 });
    await confirm.click();

    await page.waitForFunction(
      (b) => {
        const t = document.querySelector('[data-testid="swarm-count"]')?.textContent ?? '0';
        return parseInt(t.replace(/\D/g, '') || '0', 10) > b;
      },
      before,
      { timeout: 10_000 },
    );
    expect(await swarmCount(page)).toBeGreaterThan(before);
  } finally {
    await ctx.close();
  }
});

test('(C) DESKTOP: the blueprint ghost FOLLOWS the pointer on hover (no button)', async ({ browser }) => {
  // One-click model: a bare hover (no button held) must make the ghost track the
  // cursor. Move left vs right and assert the projected ghost screen-x follows —
  // with NO click (a click would place + end placement).
  const { ctx, page } = await joinAndOpenBuild(browser, { mobile: false });
  try {
    await expect(page.locator('[data-testid="build-capital"]')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="build-capital"]').click();

    const screenXAfterHoverAt = async (x: number): Promise<number> => {
      await page.mouse.move(x, 400);
      // Let a couple of frames publish the projected ghost position.
      await page.waitForTimeout(120);
      return parseFloat((await surfaceAttr(page, 'data-placement-screen-x')) ?? 'NaN');
    };

    const left = await screenXAfterHoverAt(350);
    const right = await screenXAfterHoverAt(900);
    expect(Number.isFinite(left)).toBe(true);
    expect(Number.isFinite(right)).toBe(true);
    // Hovering further right tracks the ghost further right (it FOLLOWS, no click).
    expect(right).toBeGreaterThan(left + 200);
    // Nothing was placed — placement is still active. On DESKTOP the banner is
    // gone (P3.6), so read the render-path-independent placement-active signal;
    // and assert the touch-only banner is NOT present here.
    await waitPlacementActive(page);
    await expect(page.locator('[data-testid="placement-banner"]')).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

/**
 * (D)/(E) Desktop one-click place: a LEFT-CLICK on the canvas places the
 * structure AT the cursor (no separate Confirm). We hover to the point first to
 * read the chosen world coord (the renderer's own screenToWorld of the cursor),
 * then click the SAME point and assert the landed kind-2 structure is there.
 * Runs on BOTH renderer paths — the worker path forwards the click + crosses the
 * confirm-seq FEEDBACK boundary.
 */
async function clickPlaceAssertAtClick(browser: Browser, useWorker: boolean): Promise<void> {
  const { ctx, page } = await joinAndOpenBuild(browser, { mobile: false, worker: useWorker });
  try {
    await expect(page.locator('[data-testid="build-capital"]')).toBeVisible({ timeout: 6_000 });
    await page.locator('[data-testid="build-capital"]').click();

    // Hover well off-centre so the chosen point is clearly NOT the ahead-of-ship
    // default, then read the renderer's chosen world point BEFORE the click
    // commits (the click clears placement + the dataset).
    await page.mouse.move(950, 250);
    await page.waitForFunction(
      () => {
        const v = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-placement-world-x');
        return v !== null && v !== '' && Number.isFinite(parseFloat(v));
      },
      undefined,
      { timeout: 6_000 },
    );
    const chosenX = parseFloat((await surfaceAttr(page, 'data-placement-world-x')) ?? 'NaN');
    const chosenY = parseFloat((await surfaceAttr(page, 'data-placement-world-y')) ?? 'NaN');
    expect(Number.isFinite(chosenX), 'chosen world X published').toBe(true);
    expect(Number.isFinite(chosenY), 'chosen world Y published').toBe(true);

    // One left-click places — no Confirm button.
    await page.mouse.click(950, 250);

    const placed = await page.waitForFunction(
      () => {
        const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-swarm-detail');
        if (!raw) return null;
        const detail = JSON.parse(raw) as Record<string, { x: number; y: number; kind: number }>;
        for (const k of Object.keys(detail)) {
          const e = detail[k]!;
          if (e.kind === 2) return { x: e.x, y: e.y };
        }
        return null;
      },
      undefined,
      { timeout: 10_000 },
    );
    const pos = await placed.jsonValue();
    console.log('PLACEMENT-DEBUG', JSON.stringify({ worker: useWorker, chosen: [chosenX, chosenY], placed: pos }));
    const distToChosen = Math.hypot(pos.x - chosenX, pos.y - chosenY);
    expect(distToChosen, `structure should be at the clicked point, not ${JSON.stringify(pos)}`).toBeLessThan(60);
    // Phase 5 — placement mode now STAYS ACTIVE after a desktop place so the
    // player can place MULTIPLE in a row ("don't unselect a building once you've
    // placed one"). The ghost is still projected (data-placement-screen-x
    // present); the deliberate EXIT is Escape (asserted next). (Was: cleared on
    // the one-click place — WS-10.)
    await page.waitForTimeout(400); // let the server echo land + the ghost re-arm
    const stillActive = await surfaceAttr(page, 'data-placement-screen-x');
    expect(stillActive !== null && stillActive !== '', 'placement stays active after a desktop place (place-multiple)').toBe(true);
    // Escape is the deliberate exit.
    await page.keyboard.press('Escape');
    await waitPlacementCleared(page);
  } finally {
    await ctx.close();
  }
}

test('(D) main-thread: left-click places the structure at the clicked point', async ({ browser }) => {
  test.setTimeout(60_000);
  await clickPlaceAssertAtClick(browser, false);
});

test('(E) WORKER path: left-click places the structure at the clicked point', async ({ browser }) => {
  test.setTimeout(60_000);
  await clickPlaceAssertAtClick(browser, true);
});

/**
 * (F) The PRODUCTION channel (smoke 2026-06-07 capture kuytvy): the chosen point
 * must flow on the `placementChosen` module singleton, NOT the
 * `navigator.webdriver`-gated dataset. `?noE2EDataset=1` turns the dataset OFF
 * even under Playwright, reproducing the on-device condition where Confirm read
 * an empty dataset and placed ahead-of-ship. A one-click place must still log
 * `structure_place_confirm` with hasChosen=true + finite coords.
 */
test('(F) PRODUCTION channel: one-click place uses the chosen point with the E2E dataset OFF', async ({ browser }) => {
  test.setTimeout(60_000);
  const { ctx, page } = await joinAndOpenBuild(browser, { mobile: false, worker: false, extraQuery: '&noE2EDataset=1' });
  try {
    await expect(page.locator('[data-testid="build-capital"]')).toBeVisible({ timeout: 6_000 });
    await page.locator('[data-testid="build-capital"]').click();

    // Hover off-centre (NOT the ahead-of-ship default) so placementChosen holds
    // a real pointer point, then one-click to place.
    await page.mouse.move(950, 250);
    await page.waitForTimeout(120);
    await page.mouse.click(950, 250);

    const confirmLog = await page.waitForFunction(
      () => {
        const logs = (window as unknown as { __eqxLogs?: Array<{ tag: string; data: Record<string, unknown> }> }).__eqxLogs ?? [];
        return logs.find((l) => l.tag === 'structure_place_confirm')?.data ?? null;
      },
      undefined,
      { timeout: 8_000 },
    );
    const data = (await confirmLog.jsonValue()) as { hasChosen: boolean; x: number | null; y: number | null };
    expect(data.hasChosen, 'one-click place must use the pointer-chosen point, not ahead-of-ship').toBe(true);
    expect(Number.isFinite(data.x as number)).toBe(true);
    expect(Number.isFinite(data.y as number)).toBe(true);
  } finally {
    await ctx.close();
  }
});

/**
 * (G)/(H) Desktop build-drag robustness (playtest 2026-06-10 Issue 9). A fast
 * drag that leaves the canvas (over a HUD overlay / off-element) must keep
 * tracking the ghost — the pointer is captured on pointerdown during placement.
 * Under the one-click model the release PLACES, so we assert the ghost tracked
 * the full drag by reading `data-placement-world-x` mid-drag (BEFORE release).
 * Run on BOTH paths — the desktop default is the WORKER path.
 */
async function dragLeavesCanvasTracksGhost(browser: Browser, useWorker: boolean): Promise<void> {
  const { ctx, page } = await joinAndOpenBuild(browser, { mobile: false, worker: useWorker });
  try {
    await expect(page.locator('[data-testid="build-capital"]')).toBeVisible({ timeout: 6_000 });
    await page.locator('[data-testid="build-capital"]').click();

    const worldX = async (): Promise<number> =>
      parseFloat((await surfaceAttr(page, 'data-placement-world-x')) ?? 'NaN');

    // Press near the left of the canvas, then drag rightward in steps ENDING over
    // the bottom-right HUD overlay (speed-dial / AUTO sit there). Without pointer
    // capture, the move events stop reaching the canvas once the cursor is over
    // the overlay → the ghost freezes at its last in-canvas point.
    await page.mouse.move(260, 400);
    await page.mouse.down();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-placement-world-x') != null,
      undefined,
      { timeout: 5_000 },
    );
    const startX = await worldX();

    for (const x of [500, 800, 1100, 1240]) {
      await page.mouse.move(x, x < 1100 ? 400 : 770, { steps: 4 });
    }
    // Read mid-drag, BEFORE release (the release one-click places + clears the
    // dataset).
    const endX = await worldX();
    await page.mouse.up();

    expect(Number.isFinite(startX) && Number.isFinite(endX)).toBe(true);
    expect(
      endX - startX,
      `ghost world-x should track the full drag (start ${startX}, end ${endX}); a small delta means the drag stalled leaving the canvas`,
    ).toBeGreaterThan(300);
  } finally {
    await ctx.close();
  }
}

test('(G) main-thread: placement ghost tracks a drag that leaves the canvas', async ({ browser }) => {
  test.setTimeout(60_000);
  await dragLeavesCanvasTracksGhost(browser, false);
});

test('(H) WORKER path: placement ghost tracks a drag that leaves the canvas', async ({ browser }) => {
  test.setTimeout(60_000);
  await dragLeavesCanvasTracksGhost(browser, true);
});

/**
 * (I)/(J) Desktop cancel (WS-10 / R2.5). Right-click and Escape both exit
 * placement WITHOUT placing — main-thread window listeners that work on either
 * render path. The banner detaches (placementKind cleared) and no structure
 * lands.
 */
async function cancelExitsPlacement(browser: Browser, how: 'right-click' | 'escape'): Promise<void> {
  const { ctx, page } = await joinAndOpenBuild(browser, { mobile: false });
  try {
    const before = await swarmCount(page);
    await expect(page.locator('[data-testid="build-capital"]')).toBeVisible({ timeout: 6_000 });
    await page.locator('[data-testid="build-capital"]').click();
    // Placement active (desktop has NO banner — P3.6); read the signal instead.
    await waitPlacementActive(page);

    // Hover so the ghost is positioned, then cancel.
    await page.mouse.move(700, 300);
    await page.waitForTimeout(80);
    if (how === 'right-click') {
      await page.mouse.click(700, 300, { button: 'right' });
    } else {
      await page.keyboard.press('Escape');
    }

    // Placement cleared (placementKind null → ghost gone) and nothing was placed.
    await waitPlacementCleared(page);
    await page.waitForTimeout(300);
    expect(await swarmCount(page)).toBe(before);
  } finally {
    await ctx.close();
  }
}

test('(I) DESKTOP: right-click cancels placement (no structure placed)', async ({ browser }) => {
  test.setTimeout(60_000);
  await cancelExitsPlacement(browser, 'right-click');
});

test('(J) DESKTOP: Escape cancels placement (no structure placed)', async ({ browser }) => {
  test.setTimeout(60_000);
  await cancelExitsPlacement(browser, 'escape');
});

/**
 * (K) P3.6 / WS-C4b — on DESKTOP the mobile Confirm/Cancel banner must NOT
 * appear during placement (the one-click model needs no banner; the leaked
 * mobile banner was the bug: "the desktop placement still shows the
 * Confirm/Cancel from mobile"). Placement is genuinely ACTIVE (the ghost is
 * projected) yet the touch-only banner + its buttons stay unmounted. The
 * mobile counterpart — banner DOES appear on touch — is locked by case (B).
 */
test('(K) DESKTOP: placement shows NO mobile Confirm/Cancel banner (P3.6)', async ({ browser }) => {
  test.setTimeout(60_000);
  const { ctx, page } = await joinAndOpenBuild(browser, { mobile: false });
  try {
    await expect(page.locator('[data-testid="build-capital"]')).toBeVisible({ timeout: 6_000 });
    await page.locator('[data-testid="build-capital"]').click();

    // Placement is active (the ghost is drawn + projected) ...
    await waitPlacementActive(page);
    await page.mouse.move(700, 400);
    await page.waitForTimeout(120);
    await waitPlacementActive(page);

    // ... but NO touch-only Confirm/Cancel banner mounts on a pointer device.
    await expect(page.locator('[data-testid="placement-banner"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="placement-confirm"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="placement-cancel"]')).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

/**
 * (L) P6.1 (Equinox Phase 6 — mobile placement divergence). On TOUCH, picking a
 * build kind must show the blueprint at SCREEN-CENTRE immediately — visible +
 * ready to Confirm — instead of the ahead-of-ship pose that lands hidden under
 * the bottom-right speed-dial (the user's "it appears hidden under the speeddial,
 * then jumps to where you tap" report). The renderer seeds `_placementChosenX/Y`
 * at the camera centre on touch and PARKS it (`following=false`), so
 * `data-placement-stuck` is '1' on select with NO canvas tap, and the projected
 * ghost sits at the viewport centre. Pre-fix the ghost was at ahead-of-ship with
 * `following=true` → stuck stayed '0' until a tap → this fails.
 */
test('(L) TOUCH: picking a kind centres the ghost on select, ready to confirm (P6.1)', async ({ browser }) => {
  test.setTimeout(60_000);
  const { ctx, page } = await joinAndOpenBuild(browser, { mobile: true });
  try {
    await expect(page.locator('[data-testid="build-capital"]')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="build-capital"]').click();

    // Parked at centre on select — NO tap. (Pre-fix: stuck stays '0' until a tap.)
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-placement-stuck') === '1',
      undefined,
      { timeout: 5_000 },
    );

    // The projected ghost is anchored at (near) the viewport centre — NOT off
    // under the dial. Viewport is 390×844 (see joinAndOpenBuild mobile context).
    const sx = parseFloat((await surfaceAttr(page, 'data-placement-screen-x')) ?? 'NaN');
    const sy = parseFloat((await surfaceAttr(page, 'data-placement-screen-y')) ?? 'NaN');
    expect(Number.isFinite(sx) && Number.isFinite(sy), 'ghost projected to screen').toBe(true);
    expect(Math.abs(sx - 195), `ghost screen-x ${sx} should be near centre 195`).toBeLessThan(80);
    expect(Math.abs(sy - 422), `ghost screen-y ${sy} should be near centre 422`).toBeLessThan(140);

    // Confirm is immediately available at centre (no tap-to-position required).
    await expect(page.locator('[data-testid="placement-confirm"]')).toBeVisible({ timeout: 5_000 });
  } finally {
    await ctx.close();
  }
});

/**
 * (M) P6.2 (Equinox Phase 6 — "click and hold vibrates then fails to place"). A
 * touch LONG-PRESS fires a `contextmenu` event on Android; the desktop
 * right-click-cancel handler was cancelling placement on it (+ the OS haptic).
 * After a TOUCH pointerdown, a `contextmenu` must NOT cancel placement (only a
 * MOUSE right-click does — locked by (I)). We simulate the long-press's
 * pointerdown(touch) → contextmenu and assert placement stays active. Pre-fix
 * the handler cancelled unconditionally → placement cleared → this fails.
 */
test('(M) TOUCH: a long-press contextmenu does NOT cancel placement (P6.2)', async ({ browser }) => {
  test.setTimeout(60_000);
  const { ctx, page } = await joinAndOpenBuild(browser, { mobile: true });
  try {
    await expect(page.locator('[data-testid="build-capital"]')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="build-capital"]').click();
    await waitPlacementActive(page);

    // Simulate the Android long-press: a touch pointerdown (sets the handler's
    // last-pointer-type) followed by the contextmenu the OS fires on the hold.
    await page.evaluate(() => {
      window.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
      window.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });

    // Placement must SURVIVE the long-press (pre-fix it was cancelled). Give the
    // RAF loop a beat, then assert the ghost is still projected (placement active).
    await page.waitForTimeout(200);
    const sx = await surfaceAttr(page, 'data-placement-screen-x');
    expect(Number.isFinite(parseFloat(sx ?? 'NaN')), 'placement still active after a touch long-press').toBe(true);
    await expect(page.locator('[data-testid="placement-confirm"]')).toBeVisible({ timeout: 5_000 });
  } finally {
    await ctx.close();
  }
});
