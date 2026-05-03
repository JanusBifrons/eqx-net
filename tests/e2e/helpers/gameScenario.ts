import type { Browser, Page } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

export interface TestClientOpts {
  spawnX: number;
  spawnY: number;
}

export async function launchTestClient(browser: Browser, opts: TestClientOpts) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const params = new URLSearchParams({
    room: 'test-sector',
    spawnX: String(opts.spawnX),
    spawnY: String(opts.spawnY),
  });
  await page.goto(`${BASE_URL}?${params}`);
  await page.waitForFunction(
    () =>
      parseInt(
        document.querySelector('[data-testid="ship-count"]')?.textContent?.replace('Ships: ', '') ?? '0',
        10,
      ) > 0,
    { timeout: 12_000 },
  );
  return { ctx, page };
}

export const surface = (page: Page) => page.locator('[data-testid="game-surface"]');

export async function getHullPct(page: Page): Promise<number> {
  return parseInt((await surface(page).getAttribute('data-hull-pct')) ?? '100', 10);
}

export async function getSectorAlert(page: Page): Promise<string> {
  return (await surface(page).getAttribute('data-sector-alert')) ?? '';
}

export async function getShipX(page: Page): Promise<number> {
  return parseFloat((await surface(page).getAttribute('data-ship-x')) ?? '0');
}

export async function getShipY(page: Page): Promise<number> {
  return parseFloat((await surface(page).getAttribute('data-ship-y')) ?? '0');
}

export async function getObstaclePositions(page: Page): Promise<Record<string, { x: number; y: number }>> {
  return JSON.parse((await surface(page).getAttribute('data-obstacle-positions')) ?? '{}');
}

export async function getShipPositions(page: Page): Promise<Record<string, { x: number; y: number }>> {
  return JSON.parse((await surface(page).getAttribute('data-ship-positions')) ?? '{}');
}

export async function getBeamActive(page: Page): Promise<boolean> {
  return (await surface(page).getAttribute('data-beam-active')) === '1';
}

export async function waitForDeath(page: Page, timeout = 10_000): Promise<void> {
  await page.waitForFunction(
    () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-hull-pct') === '0',
    { timeout },
  );
}

export async function waitForRespawn(page: Page, timeout = 10_000): Promise<void> {
  await page.waitForFunction(
    () =>
      parseInt(
        document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-hull-pct') ?? '0',
        10,
      ) > 0,
    { timeout },
  );
}
