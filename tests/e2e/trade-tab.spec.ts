/**
 * Living World P2 (plan peppy-jumping-pinwheel) — the Trade tab end to end:
 * UI → `accept_offer` → TradeDirector → a real hauler enters the sector.
 *
 * Uses the testMode `trade-test` room (joins the TradeDirector; any storage the
 * player places starts stocked — the `seedStorageHold` bespoke trigger, so the
 * test never flies cargo home). The settlement / raid / refund paths are locked
 * deterministically by tests/integration/sectorRoom/tradeDeal.test.ts; this
 * spec locks the client half: tab, base picker, offers, the deal dialog, the
 * accepted toast, the Deals list, and the hauler's arrival.
 *
 * The default `page` fixture carries the e2e login (trade needs an account).
 */
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

type Mirror = {
  localPlayerId?: string | null;
  structures?: Map<number, { owner?: string }>;
  swarm?: Map<number, { kind: number; shipKind?: string }>;
};
type EqxClient = { mirror?: Mirror; getRoom?: () => { send: (t: string, m: unknown) => void } | null };

async function ownStructureCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const m = (window as unknown as { __eqxClient?: EqxClient }).__eqxClient?.mirror;
    let n = 0;
    for (const s of m?.structures?.values() ?? []) if (s.owner && s.owner === m?.localPlayerId) n++;
    return n;
  });
}

test('Trade tab: post a deal and a trade hauler arrives', async ({ page }) => {
  // Infrastructural budget only: a fresh server boots 21 galaxy rooms before
  // /healthz reports ready (the client waits on it), plus a cold Vite compile
  // — the same 90 s join budget layout-slots uses. The trade itself is seconds.
  test.setTimeout(150_000);
  await page.goto(`${BASE_URL}?room=trade-test&testId=${randomUUID()}&newShip=1`);
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-local-player-id') ?? '') !== '',
    { timeout: 90_000 },
  );

  // A Capital (pre-built, owner = me) — the room stocks it on placement.
  // Retry at a fresh spot if a placement is refused (e.g. the room was still
  // settling), so the lock is about trade, not about one coordinate.
  for (let attempt = 0; attempt < 4 && (await ownStructureCount(page)) === 0; attempt++) {
    await page.evaluate((y) => {
      const c = (window as unknown as { __eqxClient?: EqxClient }).__eqxClient;
      c?.getRoom?.()?.send('place_structure', { type: 'place_structure', kind: 'capital', x: 0, y });
    }, -450 - attempt * 350);
    await expect.poll(() => ownStructureCount(page), { timeout: 3_000 }).toBeGreaterThan(0).catch(() => undefined);
  }
  expect(await ownStructureCount(page)).toBeGreaterThan(0);

  // Open the drawer on the Trade tab.
  await page.getByTestId('drawer-toggle').click();
  await page.getByTestId('drawer-tab-trade').click();
  await expect(page.getByTestId('trade-tab')).toBeVisible();
  await expect(page.getByTestId('trade-rep-traders')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('trade-base-picker')).toBeVisible({ timeout: 10_000 });

  // Sell salvage: pick the offer → the deal dialog → agree.
  const offer = page.locator('[data-testid="trade-offer"][data-offer-kind="sell"][data-offer-good="salvage"]');
  await expect(offer).toBeVisible({ timeout: 10_000 });
  await offer.getByTestId('trade-offer-deal').click();
  await expect(page.getByTestId('trade-deal-dialog')).toBeVisible();
  await page.getByTestId('trade-deal-qty').fill('10');
  await page.getByTestId('trade-deal-confirm').click();

  // Accepted → a green toast (a red one carries the server's refusal reason).
  const toast = page.getByTestId('trade-toast').first();
  await expect(toast).toBeVisible({ timeout: 10_000 });
  expect(await toast.getAttribute('data-tone'), `server replied: ${await toast.textContent()}`).toBe('good');
  await page.getByTestId('trade-section-deals').click();
  await expect(page.getByTestId('trade-deal').first()).toBeVisible({ timeout: 10_000 });

  // The TradeDirector sends a real hauler into the sector.
  await page.waitForFunction(() => {
    const m = (window as unknown as { __eqxClient?: EqxClient }).__eqxClient?.mirror;
    for (const e of m?.swarm?.values() ?? []) if (e.kind === 1 && e.shipKind === 'trader-hauler') return true;
    return false;
  }, undefined, { timeout: 10_000 });
  await expect(page.locator('[data-testid="trade-deal"][data-deal-state="inbound"]')).toBeVisible({ timeout: 10_000 });
});
