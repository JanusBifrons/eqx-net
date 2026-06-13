import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

/**
 * Speed-dial UI refactor (Phase 1) — regression lock for the consolidated
 * bottom-right `SpeedDial` that now hosts the game's discrete (tap) HUD
 * actions: Panels (open drawer), Map (toggle the galaxy overlay), and
 * weapon-slot select. These used to be three separate widgets scattered across
 * the top-right toolbar, bottom-center, and the bottom thumb cluster.
 *
 * What this locks:
 *   1. The dial FAB is present in-game; its actions are collapsed until opened.
 *   2. Opening the dial reveals all three actions.
 *   3. The Menu action opens the AdvancedDrawer.
 *   4. The Map action toggles the galaxy overlay (aria-pressed on the action).
 *   5. The weapon-slot action is reachable and carries its slot id.
 *
 * WS-13 / R2.6 additions (the Build category tier):
 *   6. Action labels are always visible while the dial is open (touch affordance).
 *   7. Build drills Build ▸ category ▸ kind, with a back action that pops levels.
 *   8. Picking a kind keeps the dial OPEN so several structures place in a row
 *      (the old close-on-pick was the bug).
 *   9. The FAB toggle still closes the dial and re-opens it at the ROOT level.
 *
 * The held controls (joystick / FIRE / BOOST) deliberately stay OUT of the
 * dial — that contract is covered by `layout-slots.spec.ts`.
 *
 * Boot uses the controlled `test-sector-fast` engineering room (testMode, no
 * drones) so the HUD settles quickly and the dial mounts.
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function joinClient(browser: Browser): Promise<{ ctx: Awaited<ReturnType<Browser['newContext']>>; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}?room=test-sector-fast&shipKind=scout`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="game-surface"]');
      return el !== null && el.getAttribute('data-local-player-id') !== '';
    },
    { timeout: 12_000 },
  );
  // The dial gates on `useShouldRenderHud()` — wait for the FAB to mount.
  await page.locator('[data-testid="speed-dial-fab"]').waitFor({ timeout: 10_000 });
  return { ctx, page };
}

async function openDial(page: Page): Promise<void> {
  await page.locator('[data-testid="speed-dial-fab"]').click();
  await expect(page.locator('[data-testid="galaxy-map-toggle"]')).toBeVisible({ timeout: 5_000 });
}

function swarmCount(page: Page): Promise<number> {
  return page
    .locator('[data-testid="swarm-count"]')
    .textContent()
    .then((t) => parseInt((t ?? '0').replace(/\D/g, '') || '0', 10));
}

test('dial actions are collapsed until the FAB is opened', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    // Actions exist in the DOM but are collapsed (scale 0 → not visible).
    await expect(page.locator('[data-testid="speed-dial-menu"]')).toBeHidden();
    await expect(page.locator('[data-testid="galaxy-map-toggle"]')).toBeHidden();
    await expect(page.locator('[data-testid="slot-selector"]')).toBeHidden();

    await openDial(page);

    await expect(page.locator('[data-testid="speed-dial-menu"]')).toBeVisible();
    await expect(page.locator('[data-testid="galaxy-map-toggle"]')).toBeVisible();
    await expect(page.locator('[data-testid="slot-selector"]')).toBeVisible();
  } finally {
    await ctx.close();
  }
});

test('Menu action opens the AdvancedDrawer', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    await openDial(page);
    await page.locator('[data-testid="speed-dial-menu"]').click();
    await expect(page.locator('[data-testid="advanced-drawer"]')).toBeVisible({ timeout: 5_000 });
  } finally {
    await ctx.close();
  }
});

test('Map action toggles the galaxy overlay', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    const mapBtn = page.locator('[data-testid="galaxy-map-toggle"]');

    await openDial(page);
    await expect(mapBtn).toHaveAttribute('aria-pressed', 'false');
    await mapBtn.click();
    await expect(mapBtn).toHaveAttribute('aria-pressed', 'true');

    // Toggling closes the dial — re-open to flip it back.
    await openDial(page);
    await mapBtn.click();
    await expect(mapBtn).toHaveAttribute('aria-pressed', 'false');
  } finally {
    await ctx.close();
  }
});

test('weapon-slot action is reachable and carries its slot id', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    await openDial(page);
    const slotBtn = page.locator('[data-testid="slot-selector"]');
    await expect(slotBtn).toBeVisible();
    // Every gameplay ship has at least one slot; the action exposes which slot
    // is hot via data-slot-id (forward-compatible with multi-slot cycling).
    await expect(slotBtn).toHaveAttribute('data-slot-id', /.+/);
    // Activating it is a safe no-op for a single-slot ship and collapses the
    // dial (no throw / no broken state).
    await slotBtn.click();
    await expect(slotBtn).toBeHidden();
  } finally {
    await ctx.close();
  }
});

// ── WS-13 / R2.6 — Build category tier ─────────────────────────────────────

test('action labels are visible while the dial is open (touch affordance)', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    await openDial(page);
    // With tooltipOpen, each action renders a persistent static label — no hover
    // needed (the whole point: on touch there is no hover). Drill into Build so
    // the labels under test are the category names the player must read.
    await page.locator('[data-testid="speed-dial-build"]').click();
    for (const label of ['Core', 'Economy', 'Defence']) {
      await expect(page.getByText(label, { exact: true })).toBeVisible({ timeout: 5_000 });
    }
  } finally {
    await ctx.close();
  }
});

test('Build drills category → kind, and Back pops each level', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    await openDial(page);

    // Build ▸ → the three categories appear; the root Panels action is gone.
    await page.locator('[data-testid="speed-dial-build"]').click();
    await expect(page.locator('[data-testid="build-cat-core"]')).toBeVisible();
    await expect(page.locator('[data-testid="build-cat-economy"]')).toBeVisible();
    await expect(page.locator('[data-testid="build-cat-defence"]')).toBeVisible();
    await expect(page.locator('[data-testid="speed-dial-menu"]')).toBeHidden();

    // Defence ▸ → the defence kinds appear (categories gone).
    await page.locator('[data-testid="build-cat-defence"]').click();
    await expect(page.locator('[data-testid="build-turret"]')).toBeVisible();
    await expect(page.locator('[data-testid="build-cat-core"]')).toBeHidden();

    // Back → categories again.
    await page.locator('[data-testid="speed-dial-back"]').click();
    await expect(page.locator('[data-testid="build-cat-core"]')).toBeVisible();
    await expect(page.locator('[data-testid="build-turret"]')).toBeHidden();

    // Back → root.
    await page.locator('[data-testid="speed-dial-back"]').click();
    await expect(page.locator('[data-testid="speed-dial-menu"]')).toBeVisible();
    await expect(page.locator('[data-testid="build-cat-core"]')).toBeHidden();
  } finally {
    await ctx.close();
  }
});

test('the dial stays open across a placement for repeat builds (R2.6 defect)', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    const before = await swarmCount(page);
    await openDial(page);
    await page.locator('[data-testid="speed-dial-build"]').click();
    await page.locator('[data-testid="build-cat-core"]').click();

    // Picking a kind raises the ghost but leaves the dial OPEN at the kinds level.
    await page.locator('[data-testid="build-capital"]').click();
    await expect(page.locator('[data-testid="placement-banner"]')).toBeVisible({ timeout: 5_000 });
    // THE LOCK: the dial is STILL open at the kinds level (pre-fix close() here
    // collapsed it AND reset to root, forcing a Build ▸ Core re-drill every time).
    await expect(page.locator('[data-testid="build-capital"]')).toBeVisible();
    await expect(page.locator('[data-testid="build-cat-core"]')).toBeHidden(); // at kinds, not categories

    // Confirm the placement. Clicking the banner blurs the dial — which must NOT
    // close it (the onClose 'blur'/'mouseLeave' suppression).
    await page.locator('[data-testid="placement-confirm"]').click();
    await page.waitForFunction((b) => {
      const t = document.querySelector('[data-testid="swarm-count"]')?.textContent ?? '0';
      return parseInt(t.replace(/\D/g, '') || '0', 10) > b;
    }, before, { timeout: 8_000 });

    // The dial survived the confirm-blur: a second structure is one tap away, no
    // re-opening and no category re-navigation.
    await expect(page.locator('[data-testid="build-capital"]')).toBeVisible();
    await page.locator('[data-testid="build-capital"]').click();
    await expect(page.locator('[data-testid="placement-banner"]')).toBeVisible({ timeout: 5_000 });
  } finally {
    await ctx.close();
  }
});

test('the FAB toggle closes the dial and re-opens it at the root level', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    await openDial(page);
    // Drill into a category…
    await page.locator('[data-testid="speed-dial-build"]').click();
    await page.locator('[data-testid="build-cat-core"]').click();
    await expect(page.locator('[data-testid="build-capital"]')).toBeVisible();

    // …tap the FAB to close.
    await page.locator('[data-testid="speed-dial-fab"]').click();
    await expect(page.locator('[data-testid="build-capital"]')).toBeHidden();

    // Re-open: we land back at ROOT, not the drilled level (close resets view).
    await page.locator('[data-testid="speed-dial-fab"]').click();
    await expect(page.locator('[data-testid="speed-dial-menu"]')).toBeVisible();
    await expect(page.locator('[data-testid="build-capital"]')).toBeHidden();
  } finally {
    await ctx.close();
  }
});
