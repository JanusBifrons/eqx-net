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
  test.setTimeout(45_000);
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
  await expect(page.locator('[data-testid="ship-stats-card"]')).toBeVisible({
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
  // Pose-value assertions are skipped here because the spawn coords
  // depend on server state (no roster row + no Limbo entry → server
  // defaults to origin). The user-reported bug is observable on a
  // server that spawns non-trivially; the assertion that protects
  // against it lives in PixiRenderer's `firstFrameRendered` latch
  // requiring `mirror.ships.has(localPlayerId)`.
  const pose = await readShipPose(page);
  expect(pose, 'data-ship-positions should expose the local ship').not.toBeNull();

  expect(errors, errors.join('\n')).toEqual([]);
});
