/**
 * C2 + C3 (plan soft-leaping-truffle v3) — break-ins through the real UI.
 *
 * `break-in-test` room: a Capital at (0,0) owned by `scenario` (neutral to the
 * pilot, so its cargo is locked) holding 7 alloy; a peaceful NPC fighter at
 * (260,−650) beside the spawn (0,−650); `breakInMs: 800`.
 *
 *  1. Structure: select the Capital → Open cargo → locked with a Break-in
 *     action → break in → progress → the cargo opens → take the alloy aboard.
 *  2. NPC ship (C3): select the fighter → Open cargo → locked with a Break-in
 *     action (its loot hold is behind a break-in, never open to a stranger).
 *
 * Uses the default `page` fixture: it carries the e2e login, so the ship has a
 * roster row (cargo needs one). Main-thread renderer for `__eqxSelectAtWorld`.
 */
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

type Mirror = {
  localPlayerId?: string | null;
  structures?: Map<number, { owner?: string; built?: boolean }>;
  swarm?: Map<number, { x: number; y: number; kind: number }>;
};
type EqxWindow = {
  __eqxClient?: { mirror?: Mirror };
  __eqxSelectAtWorld?: (x: number, y: number) => string | null;
};

async function join(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}?room=break-in-test&testId=${randomUUID()}&newShip=1&worker=0`);
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-local-player-id') ?? '') !== '',
    { timeout: 90_000 },
  );
}

/** Pose of the first swarm entity matching `kind` (1 drone, 2 structure). */
async function poseOf(page: Page, kind: 1 | 2): Promise<{ x: number; y: number } | null> {
  return page.evaluate((k) => {
    const m = (window as unknown as EqxWindow).__eqxClient?.mirror;
    for (const [, s] of m?.swarm ?? []) if (s.kind === k) return { x: s.x, y: s.y };
    return null;
  }, kind);
}

async function selectAndOpenCargo(page: Page, at: { x: number; y: number }): Promise<void> {
  await page.evaluate(([x, y]) => { (window as unknown as EqxWindow).__eqxSelectAtWorld!(x!, y!); }, [at.x, at.y]);
  await expect(page.getByTestId('entity-stats-panel')).toBeVisible({ timeout: 5_000 });
  await page.getByTestId('cargo-open-toggle').click();
}

test("break into another owner's storage: locked, break in, the cargo opens", async ({ page }) => {
  test.setTimeout(120_000);
  await join(page);
  await expect.poll(() => poseOf(page, 2), { timeout: 10_000 }).not.toBeNull();
  await selectAndOpenCargo(page, (await poseOf(page, 2))!);

  const panel = page.getByTestId('cargo-panel');
  await expect(panel).toHaveAttribute('data-open', '0', { timeout: 5_000 });
  await expect(page.getByTestId('cargo-locked')).toBeVisible();
  await page.getByTestId('cargo-break-in').click();

  // 800 ms later it opens, with the owner's alloy inside.
  await expect(panel).toHaveAttribute('data-open', '1', { timeout: 8_000 });
  const hereAlloy = panel.locator('[data-testid="cargo-here-row"][data-key="g:alloy"]');
  await expect(hereAlloy).toHaveAttribute('data-count', '7', { timeout: 5_000 });
  await hereAlloy.getByTestId('cargo-take-all').click();
  const aboardAlloy = panel.locator('[data-testid="cargo-aboard-row"][data-key="g:alloy"]');
  await expect(aboardAlloy).toHaveAttribute('data-count', '7', { timeout: 5_000 });
});

test("an NPC ship's hold is locked behind a break-in (C3)", async ({ page }) => {
  test.setTimeout(120_000);
  await join(page);
  await expect.poll(() => poseOf(page, 1), { timeout: 10_000 }).not.toBeNull();
  await selectAndOpenCargo(page, (await poseOf(page, 1))!);

  const panel = page.getByTestId('cargo-panel');
  await expect(panel).toHaveAttribute('data-open', '0', { timeout: 5_000 });
  await expect(page.getByTestId('cargo-locked')).toBeVisible();
  await expect(page.getByTestId('cargo-break-in')).toBeVisible();
});
