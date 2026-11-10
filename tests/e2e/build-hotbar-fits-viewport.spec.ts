import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { waitForInPlay } from './helpers/gameScenario';
import { DEFAULT_BASE_URL } from './helpers/ports';

/**
 * Frame review 2026-11-10 (showcase pack-battle, 1fps f005 and later): in
 * spectator mode the desktop build hotbar (`BottomControlPanel`, bottom-centre
 * slot) ran off BOTH screen edges ("BA…" cut off on the left, "QUA…" on the
 * right at 1920×1080). The bottom-centre anchor centres its content with
 * translateX(-50%), so a row wider than the viewport spills out evenly.
 *
 * Real layout lives in a real browser (jsdom has none), so this spec enters
 * spectator via the DEV `__eqxKillLocalShip` hook and asserts every hotbar
 * cell sits inside the viewport at desktop and phone widths.
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;

async function enterSpectator(page: Page): Promise<void> {
  const params = new URLSearchParams({
    room: 'test-sector-fast',
    shipKind: 'scout',
    spawnX: '0',
    spawnY: '0',
    testId: `hotbar-fit-${randomUUID()}`,
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
  await page.locator('[data-testid="bottom-control-panel"]').waitFor({ timeout: 10_000 });
}

for (const vp of [{ width: 1920, height: 1080 }, { width: 390, height: 844 }]) {
  test(`spectator build hotbar fits inside a ${vp.width}×${vp.height} viewport`, async ({ page }) => {
    test.setTimeout(45_000);
    await page.setViewportSize(vp);
    await enterSpectator(page);
    const boxes = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="bottom-control-panel"]')!;
      const cells = Array.from(panel.querySelectorAll('[data-testid^="bcp-cell-"]'));
      const r = panel.getBoundingClientRect();
      return {
        panel: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
        cells: cells.map((c) => {
          const b = c.getBoundingClientRect();
          return { id: c.getAttribute('data-testid'), left: b.left, right: b.right, top: b.top, bottom: b.bottom };
        }),
      };
    });
    expect(boxes.cells.length).toBeGreaterThan(9);
    const outside = boxes.cells.filter((c) => c.left < 0 || c.right > vp.width || c.top < 0 || c.bottom > vp.height);
    expect(outside, `cells outside the viewport: ${JSON.stringify(outside.slice(0, 3))}`).toEqual([]);
    expect(boxes.panel.left).toBeGreaterThanOrEqual(0);
    expect(boxes.panel.right).toBeLessThanOrEqual(vp.width);
  });
}
