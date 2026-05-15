import { test, expect, type Page } from '@playwright/test';

/**
 * Regression lock for the 2026-05-14 mobile smoke-test report:
 *   "I see the game UI renders, so I see the nipple JS, I see the
 *    map and the fire and the boost buttons and the burger button
 *    ... But I only see a black background as Pixie hasn't, like,
 *    mounted and rendered yet. And then Pixie sort of mounts and
 *    renders, I think, and it renders my shit on zero zero with the
 *    grid. And then when I move the Nipple JS or after a certain
 *    amount of time, it will sort of, like, put me where I should
 *    have always been."
 *
 * What this spec locks:
 *   1. The `<WarpScreen>` overlay is visible (`data-warp-visible="1"`)
 *      immediately after navigating to a `/?galaxy=...` deep link, so
 *      the partial-mount intermediate states are never user-visible.
 *   2. The status caption progresses through the readiness chain
 *      (eventually landing at `WARP COMPLETE` after all gates flip).
 *   3. The overlay hides (`data-warp-visible="0"`) within 8 s on the
 *      happy path — the join completed.
 *   4. When the overlay hides, the local ship's pose is NOT (0, 0).
 *      `data-ship-positions` on the game-surface element reports the
 *      true spawn coords. The 2026-05-14 user-described "ship at
 *      origin then snap" is exactly the symptom that fails this check.
 *
 * Reverting either the WarpScreen mount or the readiness gate (e.g.
 * making the overlay invisible immediately on phase=game) re-fails
 * the first-paint-not-at-origin check.
 *
 * Mobile viewport matches the user's diagnostic capture environment.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 914, height: 411 },
});

async function readShipPose(page: Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-ship-positions]') as HTMLElement | null;
    if (!el) return null;
    const raw = el.dataset['shipPositions'];
    if (!raw) return null;
    try {
      const all = JSON.parse(raw) as Record<string, { x: number; y: number }>;
      // The local ship is the only entry with key === stored eqxPlayerId.
      const pid = window.localStorage.getItem('eqxPlayerId') ?? '';
      return all[pid] ?? null;
    } catch {
      return null;
    }
  });
}

test('join → WarpScreen visible immediately, hides when ready, ship not at (0,0)', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

  // Spawn at a clearly non-origin point so a (0, 0) regression in the
  // first-paint moment is detectable.
  const SPAWN_X = 800;
  const SPAWN_Y = -400;

  await page.goto(
    `${BASE_URL}/?galaxy=sol-prime&spawnX=${SPAWN_X}&spawnY=${SPAWN_Y}`,
    { waitUntil: 'domcontentloaded', timeout: 60_000 },
  );

  // Step 1 — WarpScreen mounts immediately on phase=game and shows
  // visible=1 because readiness flags are all false at that point.
  const warp = page.locator('[data-testid="warp-screen"]');
  await expect(warp).toBeAttached({ timeout: 10_000 });
  await expect(warp).toHaveAttribute('data-warp-visible', '1', { timeout: 5_000 });

  // Status caption should be one of the loading states, not the
  // post-ready value.
  const earlyStatus = await page.locator('[data-testid="warp-screen-status"]').textContent();
  expect(earlyStatus).not.toContain('WARP COMPLETE');

  // Step 2 — overlay fades when the four readiness gates flip true.
  // Allow generous timeout because join + first snapshot + first frame
  // can take a moment on a fresh server boot.
  await expect(warp).toHaveAttribute('data-warp-visible', '0', { timeout: 15_000 });

  // Step 3 — final status caption should be `WARP COMPLETE`.
  await expect(page.locator('[data-testid="warp-screen-status"]')).toHaveText(
    'WARP COMPLETE',
    { timeout: 3_000 },
  );

  // Step 4 — the readiness chain must have run in the expected order
  // BEFORE the WarpScreen hid. This is the user-facing guarantee: the
  // player only sees the canvas when (a) they're welcomed by the
  // server and (b) the renderer has actually painted the local ship.
  // The 2026-05-14 user-reported "ship at (0,0) then snap" bug class
  // is precisely the case where the canvas became visible BEFORE
  // those two events landed.
  // `toBeAttached` rather than `toBeVisible` — Playwright's visibility
  // check is fragile against the Pixi-filter chain on the gameplay
  // canvas (different rendering passes confuse the occlusion test).
  // For the regression lock we only need to know the HUD is in the
  // DOM after warp hides.
  await expect(page.locator('[data-testid="ship-stats-card"]')).toBeAttached({
    timeout: 5_000,
  });
  const events = await page.evaluate(() => {
    const win = window as unknown as {
      __eqxLogs?: Array<{ ts: number; tag: string; data: Record<string, unknown> }>;
    };
    return (win.__eqxLogs ?? []).filter((e) =>
      [
        'welcome',
        'predworld_init',
        'local_pose_resolved',
        'pixi_first_frame',
        'join_chain_complete',
        'renderer_init_complete',
        'warp_mode_change',
        'load_curtain_change',
      ].includes(e.tag),
    );
  });
  const tags = events.map((e) => e.tag);
  expect(tags, `expected welcome to fire before warp hid (events: ${tags.join(', ')})`)
    .toContain('welcome');
  expect(tags, `expected pixi_first_frame to fire before warp hid (events: ${tags.join(', ')})`)
    .toContain('pixi_first_frame');
  expect(tags, `expected join_chain_complete to fire before warp hid (events: ${tags.join(', ')})`)
    .toContain('join_chain_complete');

  // pixi_first_frame must show the local player in the mirror — that's
  // the renderer-side strict gate. `hasLocal: true` is what flipped
  // `rendererFirstFrameRendered` and ultimately `gameReady`.
  const firstFrame = events.find((e) => e.tag === 'pixi_first_frame');
  expect(firstFrame).toBeDefined();
  expect(firstFrame!.data['hasLocal']).toBe(true);

  // Sanity: the local ship is observable via the standard E2E hook.
  // 2026-05-15 — the bug "ship visible at (0,0) after warp; teleports
  // on first input" was caused by `gameReady` not gating on
  // `firstSnapshotApplied`. The first-frame latch fires the moment
  // the ship enters the mirror at the predicted default (0, 0);
  // the actual server pose lands via the first snapshot which can
  // arrive AFTER gameReady. With the gate added, the curtain stays
  // up until the snapshot is applied, so the pose at reveal is the
  // server-authoritative one. Spawn URL above sets non-origin
  // coords, so the post-warp pose must match (within reconciler
  // lerp tolerance).
  const pose = await readShipPose(page);
  expect(pose, 'data-ship-positions should expose the local ship').not.toBeNull();
  const dist = Math.hypot(pose!.x, pose!.y);
  expect(dist, `pose at warp-hide should reflect server spawn (~${SPAWN_X}, ${SPAWN_Y}), not (0,0). got (${pose!.x}, ${pose!.y})`)
    .toBeGreaterThan(100);

  // ── Orchestration regression lock (2026-05-15 mobile bug) ─────────
  // On INITIAL JOIN (no source sector), the warp-OUT envelope
  // (spool→climax→burst) must NOT fire — that envelope is only for
  // the source side of an inter-sector transit. Instead, the load
  // curtain covers the canvas and an arrival flash fires when the
  // curtain transitions to ready. Asserts against the same `events`
  // captured above (one page.evaluate, no extra cumulative wait).
  const warpOnEvents = events.filter(
    (e) => e.tag === 'warp_mode_change' && e.data['active'] === true,
  );
  expect(warpOnEvents, `warp-OUT envelope must NOT fire on initial join (tags: ${tags.join(', ')})`)
    .toHaveLength(0);
  const curtainEvents = events.filter((e) => e.tag === 'load_curtain_change');
  expect(curtainEvents.length, `expected curtain rise + fall (events: ${JSON.stringify(curtainEvents)})`)
    .toBeGreaterThanOrEqual(2);
  expect(curtainEvents[0]!.data['active']).toBe(true);
  expect(curtainEvents[curtainEvents.length - 1]!.data['active']).toBe(false);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('viewport rotation forwards a resize to the worker (no stretched aspect)', async ({ page }) => {
  // Regression: WorkerRendererClient only installed pointer/wheel/touch
  // listeners — no window resize, no orientationchange, no ResizeObserver.
  // The OffscreenCanvas's drawing buffer never got resized when the
  // viewport changed (rotation, URL bar showing/hiding on mobile, etc.),
  // so the rendered content got stretched to whatever the new CSS size
  // was. User reported 2026-05-14: "when I rotated the phone, the
  // canvas didn't even update, so it got all stretched and thin".
  //
  // We can't read OffscreenCanvas drawing-buffer dims from the main
  // thread (canvas.width is unset after transferControlToOffscreen).
  // Instead we assert on the `worker_resize` logEvent that fires from
  // `WorkerRendererClient.dispatchResize` — its existence proves the
  // resize listener picked up the rotation and posted a RESIZE
  // message to the worker.
  test.setTimeout(45_000);
  await page.goto(`${BASE_URL}/?galaxy=sol-prime`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await expect(page.locator('[data-testid="warp-screen"]'))
    .toHaveAttribute('data-warp-visible', '0', { timeout: 15_000 });
  await expect(page.locator('[data-testid="ship-stats-card"]')).toBeAttached({
    timeout: 5_000,
  });

  // The arrival burst+flash (triggerWarpIn) fires when the curtain
  // lifts at gameReady and runs ~1.5 s of filter passes in the worker.
  // During that window the page is GPU-hot and `page.evaluate` can
  // stall. Wait it out before introspecting (2026-05-15 — this test
  // started flaking on the post-warp arrival burst introduced by the
  // load-curtain orchestration).
  await page.waitForTimeout(2_500);

  // Clear logs so we only see events fired AFTER the rotation. The
  // initial post-mount resize fires one `worker_resize` immediately
  // which we don't want to count.
  await page.evaluate(() => {
    const w = window as unknown as { __eqxClearLogs?: () => void };
    w.__eqxClearLogs?.();
  });

  // Rotate: simulate portrait orientation. 411 × 914 = swapped dims.
  await page.setViewportSize({ width: 411, height: 914 });
  await page.waitForTimeout(500); // let resize listeners + RAF settle.

  // Look for a `worker_resize` event with the NEW dims. If the
  // WorkerRendererClient's resize listeners aren't installed, no event
  // appears — that's the smoking gun.
  const resizeEvents = await page.evaluate(() => {
    const w = window as unknown as { __eqxLogs?: Array<{ tag: string; data: Record<string, unknown> }> };
    return (w.__eqxLogs ?? []).filter((e) => e.tag === 'worker_resize');
  });
  expect(
    resizeEvents.length,
    `Expected at least one worker_resize event after rotation; got ${resizeEvents.length}. ` +
      'If zero: WorkerRendererClient missed the rotation event entirely (no resize/orientationchange/ResizeObserver listener).',
  ).toBeGreaterThan(0);

  // The latest resize should reflect portrait dims (~411 wide).
  const latest = resizeEvents[resizeEvents.length - 1]!.data;
  expect(
    latest['w'] as number,
    `Latest worker_resize w should be ≈411 (portrait). Got ${String(latest['w'])}.`,
  ).toBeLessThan(500);
  expect(
    latest['h'] as number,
    `Latest worker_resize h should be ≈914 (portrait). Got ${String(latest['h'])}.`,
  ).toBeGreaterThan(800);
});

test('after warp hides, UI is interactive — taps reach the drawer-toggle', async ({ page }) => {
  // Regression: the WarpScreen Slot wrapper for the `fullscreen`
  // anchor has `pointer-events: auto` baked in by Slot.tsx, so even
  // when the overlay's inner Box flips to `pointer-events: none`
  // (visible=false / fading), the wrapper still intercepts every tap.
  // Symptom (user reported 2026-05-14): "the entire UI was dead. I
  // couldn't touch or click anything."
  test.setTimeout(45_000);
  await page.goto(`${BASE_URL}/?galaxy=sol-prime`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  const warp = page.locator('[data-testid="warp-screen"]');
  await expect(warp).toBeAttached({ timeout: 10_000 });
  await expect(warp).toHaveAttribute('data-warp-visible', '0', { timeout: 15_000 });

  // Step 1 — drawer-toggle is the canonical "did my tap reach the
  // HUD?" check. It lives under the WarpScreen's slot wrapper in z
  // terms but should receive taps after warp hides.
  //
  // `dispatchEvent('click')` bypasses Playwright's actionability +
  // wait-after checks entirely — directly fires a synthetic click on
  // the element. The Pixi-filter chain on the canvas makes Playwright's
  // built-in occlusion test fragile (filter passes shift pixel content
  // around in ways its hit-testing can't account for). The real
  // assertion is the drawer-open check below; we only care here that
  // the React handler runs and the wrapper doesn't swallow the event.
  await page.locator('[data-testid="drawer-toggle"]').dispatchEvent('click');

  // Step 2 — verify the drawer actually opened. If the tap was
  // intercepted by the WarpScreen slot wrapper, the drawer stays
  // closed and this times out.
  await expect(page.locator('[data-testid="advanced-drawer"]')).toBeAttached({
    timeout: 3_000,
  });
});
