/**
 * Turret-vs-fence placement hint. A fence blocks every shot, its owner's
 * turret fire included (user ruling 2026-11-02), so placing a turret with a
 * shield wall in its range shows a warning under the ghost; away from walls it
 * stays hidden.
 *
 * `gate-test` room: two powered Shield Gates on y = −900 (their spans are
 * walls). The pilot spawns at (−400, −1300), 400 u south of the west gate, so a
 * turret ghost near the ship has the gate span well inside its 600 u range.
 * Desktop, main-thread renderer, `?zoom=1` for a known screen→world scale.
 */
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { DEFAULT_BASE_URL } from './helpers/ports';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;
const GATE_Y = -900;

// Infra budget: cold Vite compile + join.
test.setTimeout(60_000);

const worldY = async (page: Page): Promise<number> =>
  parseFloat((await page.locator('[data-testid="game-surface"]').getAttribute('data-placement-world-y')) ?? 'NaN');

async function hoverUntilWorldY(page: Page, x: number, y: number): Promise<number> {
  await page.mouse.move(x, y, { steps: 3 });
  await page.waitForFunction(
    () => {
      const v = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-placement-world-y');
      return v !== null && v !== '' && Number.isFinite(parseFloat(v));
    },
    undefined,
    { timeout: 6_000 },
  );
  await page.waitForTimeout(150); // a couple of frames for the chosen point to settle
  return worldY(page);
}

test('placing a turret near a shield wall warns that the wall will stop its fire', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE_URL}?room=gate-test&testId=${randomUUID()}&spawnX=-400&spawnY=-1300&worker=0&zoom=1`);
    await page.waitForFunction(
      () => (document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-local-player-id') ?? '') !== '',
      undefined,
      { timeout: 30_000 },
    );
    // The walls must have reached the client (room state) before we look.
    await page.waitForFunction(
      () => {
        const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pred-stats');
        if (!raw) return false;
        try { return ((JSON.parse(raw) as { snapshotCount?: number }).snapshotCount ?? 0) >= 20; } catch { return false; }
      },
      undefined,
      { timeout: 20_000 },
    );
    await page.locator('[data-testid="speed-dial-fab"]').click();
    await page.locator('[data-testid="speed-dial-build"]').click();
    await page.locator('[data-testid="build-cat-defence"]').click();
    await page.locator('[data-testid="build-turret"]').click();

    const hint = page.locator('[data-testid="placement-fence-hint"]');
    await expect(hint).toHaveCount(1);

    // Near the ship (the screen centre): the gate span is in range ⇒ warned.
    const nearY = await hoverUntilWorldY(page, 640, 400);
    expect(Math.abs(nearY - GATE_Y), 'the ghost is within turret range of the gate').toBeLessThan(550);
    await expect(hint).toBeVisible({ timeout: 3_000 });

    // Far south (the bottom of the screen): no wall in range ⇒ hidden.
    const farY = await hoverUntilWorldY(page, 640, 790);
    expect(GATE_Y - farY, 'the ghost is out of range of every wall').toBeGreaterThan(650);
    await expect(hint).toBeHidden({ timeout: 3_000 });
  } finally {
    await ctx.close();
  }
});
