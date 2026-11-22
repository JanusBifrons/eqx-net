/**
 * Warp route check S3: a warp never passes through a structure (or an
 * asteroid field). With one in the way, the picker offers the NEAR SIDE as
 * the destination ("near side · structure in the way"), and the ship lands
 * exactly there: no server refusal, no correction slide after landing.
 *
 * `?galaxy=sol-prime` is a solar sector (in-sector warp exists only there);
 * `startMode=fly` flies the own ship; `initialPacked=structure:capital` gives
 * a Capital to place (dev overrides are on under Playwright). The Capital is
 * placed on the line from the ship to the nearest other pocket, a few km out,
 * so it is the first obstacle on that line.
 */
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { sectorSites, warpDropPoint } from '../../src/core/galaxy/sectorSites';
import { waitForInPlay } from './helpers/gameScenario';
import { DEFAULT_BASE_URL } from './helpers/ports';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;
const SECTOR = 'sol-prime';
/** How far out along the line the Capital goes (u). */
const PLACE_AT = 5_000;

type Pose = { x: number; y: number };
type EqxClient = {
  mirror?: { localPlayerId?: string | null; ships?: Map<string, Pose>; structures?: Map<number, { owner?: string }> };
  getRoom?: () => { send: (t: string, m: unknown) => void } | null;
  getWarpPhase?: () => 'idle' | 'spool' | 'cruise';
  warpRequest?: Pose | null;
};
type Win = { __eqxClient?: EqxClient; __eqxStore?: { getState: () => { setWarpPickerOpen: (o: boolean) => void } } };

function ownPose(page: Page): Promise<Pose | null> {
  return page.evaluate(() => {
    const m = (window as unknown as Win).__eqxClient?.mirror;
    const id = m?.localPlayerId;
    const s = id ? m?.ships?.get(id) : undefined;
    return s ? { x: s.x, y: s.y } : null;
  });
}

function ownStructureCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const m = (window as unknown as Win).__eqxClient?.mirror;
    let n = 0;
    for (const s of m?.structures?.values() ?? []) if (s.owner && s.owner === m?.localPlayerId) n++;
    return n;
  });
}

test('a structure in the way: warp to the offered near side and land there', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(
    `${BASE_URL}/?galaxy=${SECTOR}&startMode=fly&warpui=list&testId=${randomUUID()}&newShip=1&worker=0&initialPacked=structure:capital`,
    { waitUntil: 'domcontentloaded', timeout: 60_000 },
  );
  await waitForInPlay(page, 90_000);

  const start = await ownPose(page);
  expect(start, 'own ship in the mirror').not.toBeNull();

  // The nearest other pocket and its rim point (what a clear warp targets).
  const sites = sectorSites(SECTOR);
  let best: { id: string; x: number; y: number } | null = null;
  let bestD = Infinity;
  for (const s of sites) {
    if (s.kind === 'home') continue;
    const r = warpDropPoint(s, start!.x, start!.y);
    const d = Math.hypot(r.x - start!.x, r.y - start!.y);
    if (d < bestD) { bestD = d; best = { id: s.id, x: r.x, y: r.y }; }
  }
  expect(best, 'a pocket to warp to').not.toBeNull();
  const ux = (best!.x - start!.x) / bestD, uy = (best!.y - start!.y) / bestD;

  // A Capital on the line, PLACE_AT out (nudged sideways a little if refused).
  for (let attempt = 0; attempt < 4 && (await ownStructureCount(page)) === 0; attempt++) {
    const side = attempt * 150 * (attempt % 2 === 0 ? 1 : -1);
    const x = start!.x + ux * (PLACE_AT + attempt * 400) - uy * side;
    const y = start!.y + uy * (PLACE_AT + attempt * 400) + ux * side;
    await page.evaluate(([px, py]) => {
      (window as unknown as Win).__eqxClient?.getRoom?.()
        ?.send('place_structure', { type: 'place_structure', kind: 'capital', x: px, y: py });
    }, [x, y]);
    await expect.poll(() => ownStructureCount(page), { timeout: 3_000 }).toBeGreaterThan(0).catch(() => undefined);
  }
  expect(await ownStructureCount(page), 'the Capital was placed').toBeGreaterThan(0);

  // Open the picker: the pocket's row now offers the near side, amber label.
  await page.evaluate(() => (window as unknown as Win).__eqxStore?.getState().setWarpPickerOpen(true));
  const row = page.getByTestId(`warp-dest-${best!.id}`);
  await expect(row).toHaveAttribute('data-warp-state', 'near', { timeout: 10_000 });
  await expect(page.getByTestId(`warp-sub-${best!.id}`)).toHaveText('near side · structure in the way');
  const km = Number(await row.getAttribute('data-km'));
  expect(km, 'the distance shown is to the near side, short of the Capital').toBeLessThan(PLACE_AT / 1000 + 2);

  // A fresh press (the picker arms after MENU_ARM_MS, #1205).
  await page.waitForTimeout(400);
  await row.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as Win).__eqxClient?.warpRequest ?? null), { timeout: 3_000 })
    .not.toBeNull();
  const target = await page.evaluate(() => {
    const r = (window as unknown as Win).__eqxClient?.warpRequest;
    return r ? { x: r.x, y: r.y } : null;
  });
  expect(target).not.toBeNull();
  // The offered point is short of the Capital, on the line.
  const along = (target!.x - start!.x) * ux + (target!.y - start!.y) * uy;
  expect(along).toBeGreaterThan(1_000);
  expect(along).toBeLessThan(PLACE_AT + 1_200);

  // The warp runs (spool, cruise) and ends (the server accepted the point).
  await expect.poll(() => page.evaluate(() => (window as unknown as Win).__eqxClient?.getWarpPhase?.() ?? 'idle'), { timeout: 8_000 })
    .not.toBe('idle');
  await expect.poll(() => page.evaluate(() => (window as unknown as Win).__eqxClient?.getWarpPhase?.() ?? 'idle'), { timeout: 15_000 })
    .toBe('idle');

  // Landed at the offered point...
  const landed = await ownPose(page);
  expect(Math.hypot(landed!.x - target!.x, landed!.y - target!.y), 'lands at the offered near side').toBeLessThan(300);
  // ...and stays there: no correction slide once the server's pose arrives.
  await page.waitForTimeout(1_000);
  const after = await ownPose(page);
  expect(Math.hypot(after!.x - landed!.x, after!.y - landed!.y), 'no correction slide after landing').toBeLessThan(150);
  expect(Math.hypot(after!.x - target!.x, after!.y - target!.y)).toBeLessThan(300);
});
