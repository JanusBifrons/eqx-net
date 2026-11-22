import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { waitForInPlay } from './helpers/gameScenario';
import { DEFAULT_BASE_URL } from './helpers/ports';

/**
 * Every Build sidebar tile is reachable on screen. Frame review 2026-11-10 found
 * the old desktop build hotbar (bottom-centre) running off both screen edges in
 * spectator mode; the build-menu redesign folded that hotbar into the Build
 * sidebar (BuildSidebar.tsx), the one build surface, so this spec now checks
 * the sidebar's kind tiles instead.
 *
 * Real layout lives in a real browser (jsdom has none), so this spec enters
 * spectator via the DEV `__eqxKillLocalShip` hook (the old hotbar's case),
 * opens Build from the speed dial and, for every category on the rail, asserts
 * each tile can be scrolled into view inside the grid and is then fully on
 * screen, inside the grid's visible box, tappable size and not covered.
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;

async function openBuildWhileSpectating(page: Page): Promise<void> {
  const params = new URLSearchParams({
    room: 'test-sector-fast',
    shipKind: 'scout',
    spawnX: '0',
    spawnY: '0',
    testId: `sidebar-fit-${randomUUID()}`,
  });
  await page.goto(`${BASE_URL}?${params}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="game-surface"]');
      return el !== null && el.getAttribute('data-local-player-id') !== '';
    }, undefined,
    { timeout: 15_000 },
  );
  await waitForInPlay(page);
  await page.evaluate(() => {
    (window as unknown as { __eqxKillLocalShip?: () => void }).__eqxKillLocalShip?.();
  });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pilot-mode') === 'spectator', undefined,
    { timeout: 5_000 },
  );
  await page.locator('[data-testid="speed-dial-fab"]').click();
  await page.locator('[data-testid="speed-dial-build"]').click();
  await page.locator('[data-testid="build-rail"]').waitFor({ timeout: 10_000 });
}

/** 863×360 is a sideways Pixel 7 (the phone target); these are pointer windows of those sizes. */
const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 390, height: 844 },
  { width: 863, height: 360 },
] as const;

for (const vp of VIEWPORTS) {
  test(`spectator Build sidebar tiles fit inside a ${vp.width}×${vp.height} viewport`, async ({ page }) => {
    test.setTimeout(45_000);
    await page.setViewportSize(vp);
    await openBuildWhileSpectating(page);
    const cats = await page.locator('[data-testid="build-rail"] [role="tab"]').evaluateAll(
      (els) => els.map((e) => e.getAttribute('data-testid')!),
    );
    expect(cats.length).toBeGreaterThan(1);
    let total = 0;
    for (const cat of cats) {
      await page.locator(`[data-testid="${cat}"]`).click();
      await expect(page.locator(`[data-testid="${cat}"]`)).toHaveAttribute('aria-selected', 'true');
      const result = await page.evaluate(() => {
        const grid = document.querySelector<HTMLElement>('[data-testid="build-kinds"]')!;
        const gr = grid.getBoundingClientRect();
        const tiles = Array.from(grid.querySelectorAll<HTMLElement>('[data-testid^="build-"][data-locked]'));
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const bad: unknown[] = [];
        for (const t of tiles) {
          // Scroll the tile into view the way a wheel / drag would: only the
          // grid's own scroll offset moves (checked below via window.scroll*).
          grid.scrollTop = 0;
          const pre = t.getBoundingClientRect();
          if (pre.bottom > gr.bottom) grid.scrollTop += pre.bottom - gr.bottom + 2;
          if (pre.top < gr.top) grid.scrollTop -= gr.top - pre.top + 2;
          const b = t.getBoundingClientRect();
          const hit = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
          const problems = [
            b.left < 0 || b.right > vw || b.top < 0 || b.bottom > vh ? 'off-screen' : '',
            b.left < gr.left - 0.5 || b.right > gr.right + 0.5 || b.top < gr.top - 0.5 || b.bottom > gr.bottom + 0.5 ? 'clipped-by-grid' : '',
            b.width < 40 || b.height < 40 ? 'too-small' : '',
            hit === null || !t.contains(hit) ? 'covered' : '',
            window.scrollX !== 0 || window.scrollY !== 0 ? 'page-scrolled' : '',
          ].filter(Boolean);
          if (problems.length > 0) {
            bad.push({ id: t.getAttribute('data-testid'), problems, top: b.top, bottom: b.bottom, left: b.left, right: b.right });
          }
        }
        grid.scrollTop = 0;
        return { count: tiles.length, bad };
      });
      expect(result.count, `${cat} has tiles`).toBeGreaterThan(0);
      expect(result.bad, `${cat} unreachable tiles: ${JSON.stringify(result.bad.slice(0, 3))}`).toEqual([]);
      total += result.count;
    }
    expect(total).toBeGreaterThan(9);
  });
}
