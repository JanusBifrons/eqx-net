/**
 * RTS fleet warp — "Warp here" in Command view warps the SELECTED ships and the
 * commander's view follows them (plan `rts-fleet-warp`, owner decision
 * 2026-11-14). The browser end of S1–S8 and the drawer gate.
 *
 * As a player: join a galaxy sector in Command view with two own parked hulls
 * (the second is a `newShip=1` rejoin, which leaves the first parked), box-select
 * both, open the map (M), pick a neighbour, Warp here:
 *   - the spool bar shows (`hyperspace-overlay` SPOOLING);
 *   - after the spool the commander lands in the destination sector, still in
 *     Command view, with both ships there and still selected.
 * Abort mid-spool: the overlay goes, the ships stay where they are.
 * Nothing selected: the drawer's Warp here is disabled and says
 * "Select ships to warp".
 *
 * Rooms: real galaxy sectors (a warp needs a graph neighbour and the far room
 * from `TeleportBroker`, which `galaxy-test` has neither of). Each test uses
 * a sector pair no other spec joins and a fresh playerId, so leftover parked
 * hulls never reach another spec's room. The arrival test joins its source
 * sector at `timeScale=4` (the spool runs on the sector's game clock), so the
 * 30 s spool takes 7.5 s; the abort test keeps the full spool to cancel in.
 *
 * Every wait is a state predicate (dataset / store / mirror), never a pacing
 * sleep. `?worker=0` keeps the renderer on the main thread so
 * `__eqxWorldToScreen` projects a hull to the pixel it is drawn at.
 */
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { waitForInPlay } from './helpers/gameScenario';
import { DEFAULT_BASE_URL } from './helpers/ports';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;
const SURFACE = '[data-testid="game-surface"]';

interface Hull { id: string; x: number; y: number; sx: number; sy: number }

/** `timeScale` (a join option, honoured on galaxy rooms under the E2E server's
 *  `EQX_ALLOW_DEV_OVERRIDES=1`) speeds the source sector's game clock, and the
 *  spool runs on that clock: 4× turns the 30 s spool into 7.5 s. */
function galaxyUrl(sector: string, spawnX: number, spawnY: number, newShip: boolean, timeScale?: number): string {
  const params = new URLSearchParams({
    galaxy: sector, worker: '0', shipKind: 'fighter', spawnX: String(spawnX), spawnY: String(spawnY), startMode: 'command',
  });
  if (newShip) params.set('newShip', '1');
  if (timeScale !== undefined) params.set('timeScale', String(timeScale));
  return `${BASE_URL}?${params}`;
}

/** A fresh player (seeded playerId) joined to `sector` in Command view. */
async function joinCommander(
  browser: Browser, sector: string, spawnX: number, spawnY: number, timeScale?: number,
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  await ctx.addInitScript((pid) => {
    try { localStorage.setItem('eqxPlayerId', pid as string); } catch { /* ignore */ }
  }, randomUUID());
  const page = await ctx.newPage();
  await page.goto(galaxyUrl(sector, spawnX, spawnY, false, timeScale));
  await waitForInPlay(page);
  await waitCommandView(page);
  return { ctx, page };
}

/** Rejoin with a fresh ship (the first stays parked): two own parked hulls. */
async function addSecondHull(page: Page, sector: string, spawnX: number, spawnY: number, timeScale?: number): Promise<void> {
  await waitOwnHullCount(page, 1);
  await page.goto(galaxyUrl(sector, spawnX, spawnY, true, timeScale));
  await waitForInPlay(page);
  await waitCommandView(page);
  await waitOwnHullCount(page, 2);
}

/** Own parked hulls with their game pose and on-page pixel position. */
async function ownHulls(page: Page): Promise<Hull[]> {
  const raw = await page.evaluate(() => {
    const m = (globalThis as { __eqxClient?: { mirror: { localPlayerId: string | null; ships: Map<string, { isActive?: boolean; ownerPlayerId?: string; x: number; y: number }> } } }).__eqxClient?.mirror;
    const toScreen = (globalThis as { __eqxWorldToScreen?: (x: number, y: number) => { x: number; y: number } }).__eqxWorldToScreen;
    const out: { id: string; x: number; y: number; sx: number; sy: number }[] = [];
    for (const [id, e] of [...(m?.ships ?? [])].filter(([, e]) => e.isActive === false)) {
      if (e.ownerPlayerId !== m?.localPlayerId) continue;
      const s = toScreen ? toScreen(e.x, e.y) : { x: NaN, y: NaN };
      out.push({ id, x: e.x, y: e.y, sx: s.x, sy: s.y });
    }
    return out;
  });
  const box = (await page.locator(SURFACE).boundingBox())!;
  return raw.map((h) => ({ ...h, sx: h.sx + box.x, sy: h.sy + box.y }));
}

async function ownHullIds(page: Page): Promise<string[]> {
  return (await ownHulls(page)).map((h) => h.id).sort();
}

async function waitOwnHullCount(page: Page, n: number, timeout = 15_000): Promise<void> {
  await expect.poll(async () => (await ownHulls(page)).length, { timeout, message: `${n} own parked hulls` }).toBe(n);
}

async function waitCommandView(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pilot-mode') === 'spectator', undefined,
    { timeout: 15_000 },
  );
}

const selCount = (page: Page): Promise<number> =>
  page.locator(SURFACE).getAttribute('data-fleet-sel-count').then((v) => Number(v ?? '0'));

/** The one selection's ids (Zustand mirror of the renderer's selection). */
async function selectedIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const s = (globalThis as { __eqxStore?: { getState(): { selection: { ids: readonly string[] } } } }).__eqxStore;
    return [...(s?.getState().selection.ids ?? [])].sort();
  });
}

async function currentSector(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const s = (globalThis as { __eqxStore?: { getState(): { currentSectorKey: string | null } } }).__eqxStore;
    return s?.getState().currentSectorKey ?? null;
  });
}

/** Box-select every own parked hull (left-drag around where they are drawn).
 *  The hulls are AI-flown and may drift, so each try re-reads their pixels.
 *  The deadline is generous: on a cold page the main thread is busy baking
 *  art and one drag can take several seconds to be delivered. */
async function boxSelectOwnHulls(page: Page): Promise<string[]> {
  const hulls = await ownHulls(page);
  await expect.poll(async () => {
    const n = await selCount(page);
    if (n === hulls.length) return n;
    const now = await ownHulls(page);
    if (now.some((h) => !Number.isFinite(h.sx))) return n;
    const pad = 70;
    await page.mouse.move(Math.min(...now.map((h) => h.sx)) - pad, Math.min(...now.map((h) => h.sy)) - pad);
    await page.mouse.down();
    await page.mouse.move(Math.max(...now.map((h) => h.sx)) + pad, Math.max(...now.map((h) => h.sy)) + pad, { steps: 10 });
    await page.mouse.up();
    return selCount(page);
  }, { timeout: 30_000, intervals: [500], message: 'box selects both own hulls' }).toBe(hulls.length);
  return hulls.map((h) => h.id).sort();
}

/** Open the in-game map (M) and pick `sector` (opens its drawer). */
async function openMapAndPick(page: Page, sector: string): Promise<void> {
  await page.keyboard.press('m');
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 8_000 });
  await page.waitForFunction(
    () => typeof (window as unknown as { __eqxGalaxyPick?: unknown }).__eqxGalaxyPick === 'function', null, { timeout: 10_000 },
  );
  await page.evaluate((k) => (window as unknown as { __eqxGalaxyPick?: (k: string) => void }).__eqxGalaxyPick?.(k), sector);
  await expect(page.getByTestId('sector-drawer-warp')).toBeVisible({ timeout: 8_000 });
}

test.describe('RTS fleet warp @feature', () => {
  test('Warp here warps the selected ships; the commander lands with them, still selected', async ({ browser }) => {
    // Budget: three galaxy joins (infrastructural); the spool is sped up 4×.
    test.setTimeout(120_000);
    const FROM = 'ashfront';
    const TO = 'scoria-drift';
    const { ctx, page } = await joinCommander(browser, FROM, -2200, 1800, 4);
    await addSecondHull(page, FROM, -2040, 1800, 4);
    expect(await currentSector(page)).toBe(FROM);

    const ids = await boxSelectOwnHulls(page);
    expect(await selectedIds(page)).toEqual(ids);

    await openMapAndPick(page, TO);
    await expect(page.getByTestId('sector-drawer-warp')).toBeEnabled();
    await expect(page.getByTestId('sector-drawer-warp-hint')).toHaveCount(0);
    await page.getByTestId('sector-drawer-warp').click();

    // The spool bar shows.
    const overlay = page.locator('[data-testid="hyperspace-overlay"]');
    await expect(overlay).toBeVisible({ timeout: 8_000 });
    await expect(overlay).toHaveAttribute('data-transit-state', 'SPOOLING');

    // After the spool: in the destination, still in Command view.
    await expect.poll(() => currentSector(page), { timeout: 30_000, intervals: [500], message: 'the commander lands in the destination' }).toBe(TO);
    await waitForInPlay(page);
    await waitCommandView(page);
    await expect(page.locator('[data-testid="pilot-spectator-toggle"]')).toHaveAttribute('data-control-mode', 'command');

    // Both ships are there (same hulls) and still selected.
    await expect.poll(() => ownHullIds(page), { timeout: 15_000, message: 'both warped ships in the destination' }).toEqual(ids);
    await expect.poll(() => selectedIds(page), { timeout: 10_000, message: 'the warped ships are selected again' }).toEqual(ids);
    expect(await selCount(page)).toBe(2);
    await ctx.close();
  });

  test('aborting a fleet warp keeps the ships where they are', async ({ browser }) => {
    test.setTimeout(120_000);
    const FROM = 'cinderpath';
    const TO = 'emberwake';
    const { ctx, page } = await joinCommander(browser, FROM, -2200, 1800);
    await addSecondHull(page, FROM, -2040, 1800);
    const ids = await boxSelectOwnHulls(page);

    await openMapAndPick(page, TO);
    await page.getByTestId('sector-drawer-warp').click();
    const overlay = page.locator('[data-testid="hyperspace-overlay"]');
    await expect(overlay).toBeVisible({ timeout: 8_000 });
    await expect(overlay).toHaveAttribute('data-transit-state', 'SPOOLING');

    await page.getByTestId('hyperspace-cancel').click();
    await expect(overlay).toHaveCount(0, { timeout: 5_000 });

    // Still here, both ships still here and still parked under this commander.
    expect(await currentSector(page)).toBe(FROM);
    await waitCommandView(page);
    expect(await ownHullIds(page)).toEqual(ids);
    // The server confirms: both hulls are still in this room's state.
    const inRoom = await page.evaluate((want) => {
      const c = (globalThis as { __eqxClient?: { getRoom(): { state: { ships: Map<string, unknown> } } | null } }).__eqxClient;
      const ships = c?.getRoom()?.state.ships;
      return want.filter((id) => ships?.has(id) === true).length;
    }, ids);
    expect(inRoom, 'both hulls still in the source room on the server').toBe(2);
    await ctx.close();
  });

  test('with nothing selected Warp here is disabled and says "Select ships to warp"', async ({ browser }) => {
    test.setTimeout(60_000);
    const { ctx, page } = await joinCommander(browser, 'abyssal-gate', 1800, 1800);
    expect(await selCount(page)).toBe(0);
    await openMapAndPick(page, 'deepcurrent');
    await expect(page.getByTestId('sector-drawer-warp')).toBeDisabled();
    await expect(page.getByTestId('sector-drawer-warp-hint')).toHaveText('Select ships to warp');
    await ctx.close();
  });
});
