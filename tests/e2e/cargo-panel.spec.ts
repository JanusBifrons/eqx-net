/**
 * C1 (plan soft-leaping-truffle v3) — open your own storage's cargo from the
 * inspector and move items by hand, through the real UI and wire.
 *
 * `trade-test` stocks any storage the player places (`seedStorageHold`: 20
 * alloy). Place a Capital beside the ship, select it (`__eqxSelectAtWorld`,
 * main-thread renderer), open its cargo, take 1 alloy aboard, put it back.
 * Uses the default `page` fixture: it carries the e2e login, so the ship has a
 * roster row (cargo needs one).
 */
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

type Mirror = {
  localPlayerId?: string | null;
  structures?: Map<number, { owner?: string; built?: boolean }>;
  swarm?: Map<number, { x: number; y: number }>;
};
type EqxClient = { mirror?: Mirror; getRoom?: () => { send: (t: string, m: unknown) => void } | null };

async function ownCapital(page: Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate(() => {
    const m = (window as unknown as { __eqxClient?: EqxClient }).__eqxClient?.mirror;
    for (const [eid, s] of m?.structures ?? []) {
      if (s.owner && s.owner === m?.localPlayerId && s.built === true) {
        const p = m?.swarm?.get(eid);
        if (p) return { x: p.x, y: p.y };
      }
    }
    return null;
  });
}

test('open your own storage and move cargo by hand', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${BASE_URL}?room=trade-test&testId=${randomUUID()}&newShip=1&worker=0`);
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-local-player-id') ?? '') !== '',
    { timeout: 90_000 },
  );

  // A Capital just south of the ship (the spawn scatter is ±200 u).
  for (let attempt = 0; attempt < 4 && (await ownCapital(page)) === null; attempt++) {
    await page.evaluate((y) => {
      (window as unknown as { __eqxClient?: EqxClient }).__eqxClient?.getRoom?.()
        ?.send('place_structure', { type: 'place_structure', kind: 'capital', x: 0, y });
    }, -450 - attempt * 50);
    await expect.poll(() => ownCapital(page), { timeout: 3_000 }).not.toBeNull().catch(() => undefined);
  }
  const cap = await ownCapital(page);
  expect(cap, 'a Capital was placed').not.toBeNull();

  await page.evaluate(([x, y]) => {
    (window as unknown as { __eqxSelectAtWorld?: (x: number, y: number) => string | null }).__eqxSelectAtWorld!(x!, y!);
  }, [cap!.x, cap!.y]);
  await expect(page.getByTestId('entity-stats-panel')).toBeVisible({ timeout: 5_000 });

  await page.getByTestId('cargo-open-toggle').click();
  const panel = page.getByTestId('cargo-panel');
  await expect(panel).toHaveAttribute('data-open', '1', { timeout: 5_000 });
  const hereAlloy = panel.locator('[data-testid="cargo-here-row"][data-key="g:alloy"]');
  await expect(hereAlloy).toHaveAttribute('data-count', '20', { timeout: 5_000 });

  // Take one alloy aboard.
  await hereAlloy.getByTestId('cargo-take-one').click();
  const aboardAlloy = panel.locator('[data-testid="cargo-aboard-row"][data-key="g:alloy"]');
  await expect(aboardAlloy).toHaveAttribute('data-count', '1', { timeout: 5_000 });
  await expect(hereAlloy).toHaveAttribute('data-count', '19');

  // Put it back.
  await aboardAlloy.getByTestId('cargo-put-all').click();
  await expect(hereAlloy).toHaveAttribute('data-count', '20', { timeout: 5_000 });
  await expect(aboardAlloy).toHaveCount(0);
});
