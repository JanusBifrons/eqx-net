/**
 * RTS: box-select works the moment Command view is back after flying a ship.
 *
 * Reported while filming rts-command (2 of 3 takes): take controls of a hull,
 * fly it, press Command, then box-drag over the fleet at once → 0 selected.
 * The logical behaviour: as soon as the UI shows Command view, a left-drag
 * around your ships selects all of them. Repeats Fly → Command → drag at
 * several delays after the toggle reads "command" (`RTS_RESELECT_REPS` per
 * delay, default 1).
 */
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { launchGalaxyTestClient, waitForInPlay } from './helpers/gameScenario';
import { DEFAULT_BASE_URL } from './helpers/ports';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;
const SURFACE = '[data-testid="game-surface"]';
const REPS = Number(process.env['RTS_RESELECT_REPS'] ?? '1');
const DELAYS = [0, 150, 400, 1000];

interface Hull { id: string; sx: number; sy: number }

async function ownHulls(page: Page): Promise<Hull[]> {
  const raw = await page.evaluate(() => {
    const m = (globalThis as { __eqxClient?: { mirror: { localPlayerId: string | null; ships: Map<string, { isActive?: boolean; ownerPlayerId?: string; x: number; y: number }> } } }).__eqxClient?.mirror;
    const toScreen = (globalThis as { __eqxWorldToScreen?: (x: number, y: number) => { x: number; y: number } }).__eqxWorldToScreen;
    const out: { id: string; sx: number; sy: number }[] = [];
    for (const [id, e] of [...(m?.ships ?? [])].filter(([, e]) => e.isActive === false)) {
      if (e.ownerPlayerId !== m?.localPlayerId || !toScreen) continue;
      const s = toScreen(e.x, e.y);
      out.push({ id, sx: s.x, sy: s.y });
    }
    return out;
  });
  const box = (await page.locator(SURFACE).boundingBox())!;
  return raw.map((h) => ({ ...h, sx: h.sx + box.x, sy: h.sy + box.y }));
}

const pilotMode = (page: Page): Promise<string | null> => page.locator(SURFACE).getAttribute('data-pilot-mode');
const controlMode = (page: Page): Promise<string | null> =>
  page.locator('[data-testid="pilot-spectator-toggle"]').getAttribute('data-control-mode');
const selCount = (page: Page): Promise<number> =>
  page.locator(SURFACE).getAttribute('data-fleet-sel-count').then((v) => Number(v ?? '0'));

async function waitOwnHulls(page: Page, n: number): Promise<void> {
  await expect.poll(async () => (await ownHulls(page)).length, { timeout: 15_000, message: `${n} own parked hulls` }).toBe(n);
}

async function dragAround(page: Page, hs: Hull[]): Promise<void> {
  const pad = 60;
  const x0 = Math.min(...hs.map((h) => h.sx)) - pad, y0 = Math.min(...hs.map((h) => h.sy)) - pad;
  const x1 = Math.max(...hs.map((h) => h.sx)) + pad, y1 = Math.max(...hs.map((h) => h.sy)) + pad;
  // Paced like the shot's pointer: glide to the corner, then drag across.
  await page.mouse.move(x0, y0, { steps: 20 });
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 40 });
  await page.mouse.up();
}

test.describe('RTS reselect after Command @feature', () => {
  test('box-select picks every own ship right after Fly → Command', async ({ browser }) => {
    test.setTimeout(60_000 + REPS * DELAYS.length * 25_000);
    const testId = randomUUID();
    const a = await launchGalaxyTestClient(browser, { testId, shipKind: 'fighter', spawnX: 0, spawnY: 0, startMode: 'command' });
    const { page } = a;
    await expect.poll(() => pilotMode(page), { timeout: 15_000 }).toBe('spectator');
    await waitOwnHulls(page, 1);
    const params = new URLSearchParams({
      room: 'galaxy-test', worker: '0', testId, shipKind: 'fighter', spawnX: '160', spawnY: '0', newShip: '1', startMode: 'command',
    });
    await page.goto(`${BASE_URL}?${params}`);
    await waitForInPlay(page);
    await expect.poll(() => pilotMode(page), { timeout: 15_000 }).toBe('spectator');
    await waitOwnHulls(page, 2);

    const failures: string[] = [];
    for (let rep = 0; rep < REPS; rep++) {
      for (const delay of DELAYS) {
        // Take one hull's controls with a double-click, as the take does.
        await expect.poll(async () => {
          const pm = await pilotMode(page);
          if (pm === 'pilot') return pm;
          const h = (await ownHulls(page))[rep % 2];
          if (h) await page.mouse.dblclick(h.sx, h.sy);
          return pm;
        }, { timeout: 10_000, intervals: [1_500], message: 'double-click takes the hull' }).toBe('pilot');
        await page.mouse.move(700, 150, { steps: 15 });
        // Fly it a little, as the take does.
        await page.keyboard.down('ArrowUp');
        await page.waitForTimeout(800);
        await page.keyboard.up('ArrowUp');
        // Command: hand it back.
        await page.locator('[data-testid="spectator-toggle"]').click();
        await expect.poll(() => controlMode(page), { timeout: 6_000, intervals: [16] }).toBe('command');
        if (delay > 0) await page.waitForTimeout(delay);
        const hs = await ownHulls(page);
        await dragAround(page, hs);
        let got = 0;
        try {
          await expect.poll(() => selCount(page), { timeout: 2_000 }).toBe(2);
          got = 2;
        } catch {
          got = await selCount(page);
        }
        const pm = await pilotMode(page);
        console.log(`[reselect] rep ${rep} delay ${delay}ms -> ${got} (hulls ${hs.length}, pilotMode ${pm})`);
        if (got !== 2) failures.push(`rep ${rep} delay ${delay}: selected ${got}, hulls listed ${hs.length}, pilotMode ${pm}`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
    await a.ctx.close();
  });
});
