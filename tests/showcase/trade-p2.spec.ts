/**
 * Living World showcase — P2 trade deals (plan peppy-jumping-pinwheel). NOT a
 * gate: a scripted run of the real game that RECORDS the trade loop:
 *
 *   the Trade tab (standing + offers) → agree a deal → a trade hauler flies in
 *   from the sector edge → robot raiders jump it (the red "under fire" escort
 *   prompt) → the pilot flies out to escort it → the hauler docks and leaves →
 *   "Sold …" (or "raided") → the History list.
 *
 * `trade-showcase` is a testMode room: it joins the TradeDirector, stocks any
 * storage the pilot places, and sends two robot cubes to meet each hauler.
 *
 * Run (headed — headless software WebGL can't render the game):
 *   pnpm exec playwright test --config playwright.showcase.config.ts trade-p2 --headed
 * Output: diag/showcase/p2/trade-p2.webm (+ key-frame PNGs).
 */
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { flyTo, type ClientShape } from './helpers';

const BASE_URL = process.env['BASE_URL'] ?? 'http://localhost:5173/';
const OUT_DIR = join('diag', 'showcase', 'p2');

type Mirror = NonNullable<ClientShape['mirror']> & {
  structures?: Map<number, { owner?: string }>;
};

async function haulerPose(page: Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate(() => {
    const m = (window as unknown as { __eqxClient?: { mirror?: { swarm?: Map<number, { kind: number; shipKind?: string; x: number; y: number }> } } }).__eqxClient?.mirror;
    for (const e of m?.swarm?.values() ?? []) if (e.kind === 1 && e.shipKind === 'trader-hauler') return { x: e.x, y: e.y };
    return null;
  });
}

test('Living World P2: a trade deal, a raid, an escort', async ({ page }, testInfo) => {
  mkdirSync(OUT_DIR, { recursive: true });
  await page.addInitScript((id) => {
    try { localStorage.setItem('eqxPlayerId', id as string); } catch { /* ignore */ }
  }, randomUUID());
  const params = new URLSearchParams({
    room: 'trade-showcase', testId: randomUUID(), worker: '0', newShip: '1',
    spawnX: '0', spawnY: '-200', initialHull: '99999', zoom: '0.45',
  });
  await page.goto(`${BASE_URL}?${params}`);
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-local-player-id') ?? '') !== '',
    { timeout: 120_000 },
  );
  await page.waitForTimeout(5_000); // warp-in curtain lifts

  // Home base: a Capital (stocked by the room on placement).
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.evaluate((y) => {
      const c = (window as unknown as { __eqxClient?: ClientShape }).__eqxClient;
      c?.getRoom?.()?.send('place_structure', { type: 'place_structure', kind: 'capital', x: 0, y });
    }, -520 - attempt * 300);
    const placed = await page.waitForFunction(() => {
      const m = (window as unknown as { __eqxClient?: { mirror?: Mirror } }).__eqxClient?.mirror;
      for (const s of m?.structures?.values() ?? []) if (s.owner && s.owner === m?.localPlayerId) return true;
      return false;
    }, undefined, { timeout: 3_000 }).then(() => true, () => false);
    if (placed) break;
  }

  // 1) The Trade tab: standing with each side + the offers board.
  await page.getByTestId('drawer-toggle').click();
  await page.getByTestId('drawer-tab-trade').click();
  await expect(page.getByTestId('trade-base-picker')).toBeVisible({ timeout: 15_000 });
  const offer = page.locator('[data-testid="trade-offer"][data-offer-kind="sell"][data-offer-good="salvage"]');
  await expect(offer).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: join(OUT_DIR, '1-trade-tab.png') });

  // 2) Agree a deal: sell 40 salvage, one-off.
  await offer.getByTestId('trade-offer-deal').click();
  await page.getByTestId('trade-deal-qty').fill('40');
  await page.waitForTimeout(1_200);
  await page.getByTestId('trade-deal-confirm').click();
  await page.waitForTimeout(1_500);
  await page.getByTestId('drawer-close').click();

  // 3) The hauler flies in; raiders jump it → the red escort prompt.
  await page.waitForFunction(() => {
    const m = (window as unknown as { __eqxClient?: { mirror?: { swarm?: Map<number, { kind: number; shipKind?: string }> } } }).__eqxClient?.mirror;
    for (const e of m?.swarm?.values() ?? []) if (e.kind === 1 && e.shipKind === 'trader-hauler') return true;
    return false;
  }, undefined, { timeout: 20_000 });
  const danger = page.locator('[data-testid="trade-toast"][data-tone="danger"]').first();
  await expect(danger).toBeVisible({ timeout: 90_000 });
  await page.screenshot({ path: join(OUT_DIR, '2-escort-prompt.png') });

  // 4) Escort: fly to the hauler (auto-fire engages the robots on the way).
  for (let i = 0; i < 4; i++) {
    const h = await haulerPose(page);
    if (!h) break;
    await flyTo(page, h.x, h.y, 260, 7_000);
  }
  await page.screenshot({ path: join(OUT_DIR, '3-escort.png') });

  // 5) The outcome: docked → departed → "Sold …", or "raided".
  const outcome = page.locator('[data-testid="trade-toast"]', { hasText: /Sold|destroyed|raided/ }).first();
  await expect(outcome).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(1_000);
  await page.screenshot({ path: join(OUT_DIR, '4-outcome.png') });

  // 6) History.
  await page.getByTestId('drawer-toggle').click();
  await page.getByTestId('drawer-tab-trade').click();
  await page.getByTestId('trade-section-history').click();
  await expect(page.getByTestId('trade-history-row').first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(2_000);
  await page.screenshot({ path: join(OUT_DIR, '5-history.png') });

  const video = page.video();
  await page.close();
  if (video) {
    const src = await video.path();
    copyFileSync(src, join(OUT_DIR, 'trade-p2.webm'));
    testInfo.attachments.push({ name: 'video', path: src, contentType: 'video/webm' });
  }
});
