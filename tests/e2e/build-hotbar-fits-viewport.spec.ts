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

/**
 * 2026-11-20: new build kinds grew the palette past what fits at 390×844, so
 * the panel's bounded box (`maxHeight: 40vh`, `overflowY: auto`) now scrolls.
 * A cell clipped by that box is still REACHABLE: the honest test is "scroll it
 * into view inside the panel, then it is fully on screen, inside the panel's
 * visible box, the page itself did not scroll, it is tappable size, and a click
 * at its centre hits it (no other HUD covers it)". 863×360 is a sideways
 * Pixel 7 (the phone target; phones play sideways). The palette is the
 * mouse-pointer build bar (`!isTouchDevice()`; touch builds via the speed dial),
 * so these are pointer windows of those sizes, not touch emulation.
 */
const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 390, height: 844 },
  { width: 863, height: 360 },
] as const;

for (const vp of VIEWPORTS) {
  test(`spectator build hotbar fits inside a ${vp.width}×${vp.height} viewport`, async ({ page }) => {
    test.setTimeout(45_000);
    await page.setViewportSize(vp);
    await enterSpectator(page);
    const result = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('[data-testid="bottom-control-panel"]')!;
      const pr = panel.getBoundingClientRect();
      const cells = Array.from(panel.querySelectorAll<HTMLElement>('[data-testid^="bcp-cell-"]'));
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const bad: unknown[] = [];
      for (const c of cells) {
        // Scroll the cell into view the way a wheel / drag would: only the
        // panel's own scroll offset moves (checked below via window.scroll*).
        panel.scrollTop = 0;
        panel.scrollLeft = 0;
        const pre = c.getBoundingClientRect();
        if (pre.bottom > pr.bottom) panel.scrollTop += pre.bottom - pr.bottom + 2;
        if (pre.top < pr.top) panel.scrollTop -= pr.top - pre.top + 2;
        if (pre.right > pr.right) panel.scrollLeft += pre.right - pr.right + 2;
        if (pre.left < pr.left) panel.scrollLeft -= pr.left - pre.left + 2;
        const b = c.getBoundingClientRect();
        const hit = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
        const problems = [
          b.left < 0 || b.right > vw || b.top < 0 || b.bottom > vh ? 'off-screen' : '',
          b.left < pr.left - 0.5 || b.right > pr.right + 0.5 || b.top < pr.top - 0.5 || b.bottom > pr.bottom + 0.5 ? 'clipped-by-panel' : '',
          b.width < 40 || b.height < 40 ? 'too-small' : '',
          hit === null || !c.contains(hit) ? 'covered' : '',
          window.scrollX !== 0 || window.scrollY !== 0 ? 'page-scrolled' : '',
        ].filter(Boolean);
        if (problems.length > 0) {
          bad.push({ id: c.getAttribute('data-testid'), problems, top: b.top, bottom: b.bottom, left: b.left, right: b.right });
        }
      }
      panel.scrollTop = 0;
      panel.scrollLeft = 0;
      return { count: cells.length, bad, panel: { left: pr.left, right: pr.right, top: pr.top, bottom: pr.bottom } };
    });
    expect(result.count).toBeGreaterThan(9);
    expect(result.bad, `unreachable cells: ${JSON.stringify(result.bad.slice(0, 3))}`).toEqual([]);
    // The scroll box itself sits wholly on screen.
    expect(result.panel.left).toBeGreaterThanOrEqual(0);
    expect(result.panel.right).toBeLessThanOrEqual(vp.width);
    expect(result.panel.top).toBeGreaterThanOrEqual(0);
    expect(result.panel.bottom).toBeLessThanOrEqual(vp.height);
  });
}
