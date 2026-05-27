import { randomUUID } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

export interface TestClientOpts {
  spawnX: number;
  spawnY: number;
  /** Optional spawn HP override (test-sector only; gated server-side).
   *  Use 1 for "kill in one tick" scenarios so the spec runs in seconds
   *  instead of fighting 500 HP + shield through full TTK. */
  initialHull?: number;
  initialShield?: number;
  /** Which test room to join (default 'test-sector'). Pass
   *  'test-sector-fast' for 10x physics-tick acceleration. */
  room?: 'test-sector' | 'test-sector-fast';
  /** Mobile-perf gate test-only — bytes per RAF tick to retain on a
   *  global array. Wires `?injectLeak=N` so the gate's
   *  `jsHeapGrowthMb` metric can be exercised end-to-end. DEV-build
   *  only; the hook tree-shakes from prod via `import.meta.env.DEV`. */
  injectLeak?: number;
  /** Per-test room isolation. Pass a unique value (e.g. randomUUID) for
   *  the first client; pass the SAME value for additional clients that
   *  must share a room with the first. Omit ⇒ a fresh UUID is minted
   *  per call (NOT shared — every launchTestClient call is its own
   *  room). For multi-client specs, mint the testId at the test level
   *  and pass it explicitly to each launchTestClient call. */
  testId?: string;
}

export async function launchTestClient(browser: Browser, opts: TestClientOpts) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const params = new URLSearchParams({
    room: opts.room ?? 'test-sector',
    spawnX: String(opts.spawnX),
    spawnY: String(opts.spawnY),
    testId: opts.testId ?? randomUUID(),
  });
  if (opts.initialHull !== undefined) params.set('initialHull', String(opts.initialHull));
  if (opts.initialShield !== undefined) params.set('initialShield', String(opts.initialShield));
  if (opts.injectLeak !== undefined) params.set('injectLeak', String(opts.injectLeak));
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
