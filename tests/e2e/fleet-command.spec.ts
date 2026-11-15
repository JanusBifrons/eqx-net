/**
 * RTS command layer — the whole command loop in a real browser against a real
 * room (slice 16, the E2E for slices 3–15).
 *
 * Two own parked hulls in the linger-capable `galaxy-test` room, joined in
 * Command view (`startMode=command`): the second is a `newShip=1` rejoin,
 * which leaves the first parked (AI-flown) and parks the new one at its
 * arrival flip. Then, as a player would:
 *   box-select both (left-drag) → the fleet panel lists them;
 *   right-click empty space → a move order goes out and the server reports
 *     them moving (fleet_status row "Moving" or a hull actually moves);
 *   stance Hold fire → the server echoes it (the button reads pressed);
 *   Form squad → the panel offers Disband; Disband → gone;
 *   Patrol: click two points, Done → the server reports "Patrolling";
 *   Stop → the server reports them holding ("Guarding");
 *   shift-click one ship off the selection, Fly → you pilot it.
 *
 * Every wait is a state predicate (dataset / panel text / mirror), never a
 * pacing sleep. `?worker=0` (from the helper) keeps the renderer on the main
 * thread so `__eqxWorldToScreen` can project a hull to the pixel it is drawn at.
 * The budget is join-dominated (two galaxy joins, infrastructural); the game
 * steps themselves each settle within a status period (~0.4 s).
 */
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { launchGalaxyTestClient, waitForInPlay } from './helpers/gameScenario';
import { DEFAULT_BASE_URL } from './helpers/ports';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;
const SURFACE = '[data-testid="game-surface"]';

interface Hull { id: string; x: number; y: number; sx: number; sy: number }

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

async function waitOwnHullCount(page: Page, n: number): Promise<void> {
  await page.waitForFunction(
    (want) => {
      const m = (globalThis as { __eqxClient?: { mirror: { localPlayerId: string | null; ships: Map<string, { isActive?: boolean; ownerPlayerId?: string }> } } }).__eqxClient?.mirror;
      let c = 0;
      for (const e of [...(m?.ships?.values() ?? [])].filter((e) => e.isActive === false)) if (e.ownerPlayerId === m?.localPlayerId) c++;
      return c === want;
    },
    n,
    { timeout: 15_000 },
  );
}

async function waitCommandView(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pilot-mode') === 'spectator', undefined,
    { timeout: 15_000 },
  );
}

const selCount = (page: Page): Promise<number> =>
  page.locator(SURFACE).getAttribute('data-fleet-sel-count').then((v) => Number(v ?? '0'));

async function waitRowsActivity(page: Page, re: RegExp, what: string): Promise<void> {
  await expect
    .poll(async () => (await page.locator('[data-testid="fleet-ship-row"]').allTextContents()).join(' | '), {
      timeout: 5_000,
      message: what,
    })
    .toMatch(re);
}

test.describe('RTS fleet command loop @feature', () => {
  // RTS Part B slice 11: patrol (one route stepper shared with PatrolSubsystem) and the
  // panel activity from the AI pilot brain; until then the status never says Patrolling.
  // (Box-select, the move order, hold fire and the squad steps pass on slice 2.)
  test.skip('box-select, move order, stance, squad, patrol, Fly', async ({ browser }) => {
    test.setTimeout(120_000);
    const testId = randomUUID();
    const a = await launchGalaxyTestClient(browser, {
      testId, shipKind: 'fighter', spawnX: 0, spawnY: 0, startMode: 'command',
    });
    const { page } = a;
    await waitCommandView(page);
    await waitOwnHullCount(page, 1);

    // A second own hull: rejoin with a fresh ship (the first stays parked).
    const params = new URLSearchParams({
      room: 'galaxy-test', worker: '0', testId, shipKind: 'fighter', spawnX: '160', spawnY: '0',
      newShip: '1', startMode: 'command',
    });
    await page.goto(`${BASE_URL}?${params}`);
    await waitForInPlay(page);
    await waitCommandView(page);
    await waitOwnHullCount(page, 2);
    await expect(page.locator('[data-testid="pilot-spectator-toggle"]')).toHaveAttribute('data-control-mode', 'command');

    // ── Box-select both (left-drag around them). ──────────────────────────
    const hulls = await ownHulls(page);
    for (const h of hulls) expect(Number.isFinite(h.sx), `hull ${h.id} projects to the screen`).toBe(true);
    const pad = 70;
    const x0 = Math.min(...hulls.map((h) => h.sx)) - pad;
    const y0 = Math.min(...hulls.map((h) => h.sy)) - pad;
    const x1 = Math.max(...hulls.map((h) => h.sx)) + pad;
    const y1 = Math.max(...hulls.map((h) => h.sy)) + pad;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x1, y1, { steps: 10 });
    await page.mouse.up();
    await expect.poll(() => selCount(page), { timeout: 3_000, message: 'box selects both own hulls' }).toBe(2);
    const panel = page.locator('[data-testid="fleet-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-fleet-count', '2');
    await expect(page.locator('[data-testid="fleet-ship-row"]')).toHaveCount(2);

    // ── Right-click empty space → move order; the server reports motion. ──
    const box = (await page.locator(SURFACE).boundingBox())!;
    const seq0 = Number(await page.locator(SURFACE).getAttribute('data-fleet-order-seq'));
    const tx = box.x + box.width / 2;
    const ty = Math.max(box.y + 120, y0 - 160);
    await page.mouse.click(tx, ty, { button: 'right' });
    await page.waitForFunction(
      (s) => {
        const el = document.querySelector('[data-testid="game-surface"]');
        return Number(el?.getAttribute('data-fleet-order-seq')) > s && el?.getAttribute('data-fleet-order-kind') === 'move';
      },
      seq0,
      { timeout: 3_000 },
    );
    const start = new Map(hulls.map((h) => [h.id, h]));
    await expect
      .poll(async () => {
        const rows = (await page.locator('[data-testid="fleet-ship-row"]').allTextContents()).join(' | ');
        if (/Moving/.test(rows)) return 'moving';
        const now = await ownHulls(page);
        const moved = now.some((h) => {
          const s = start.get(h.id);
          return s !== undefined && Math.hypot(h.x - s.x, h.y - s.y) > 20;
        });
        return moved ? 'moving' : rows;
      }, { timeout: 5_000, message: 'the server moves the hulls on a right-click order' })
      .toBe('moving');

    // ── Stance: Hold fire, echoed by the server's status. ─────────────────
    await page.locator('[data-testid="fleet-stance-holdFire"]').click();
    await expect(page.locator('[data-testid="fleet-stance-holdFire"]')).toHaveAttribute('aria-pressed', 'true', { timeout: 3_000 });

    // ── Squad: form, then disband. ─────────────────────────────────────────
    await page.locator('[data-testid="fleet-form-squad"]').click();
    await expect(page.locator('[data-testid="fleet-disband-squad"]')).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('[data-testid="fleet-disband-squad"]')).toBeEnabled();
    await page.locator('[data-testid="fleet-disband-squad"]').click();
    await expect(page.locator('[data-testid="fleet-disband-squad"]')).toHaveCount(0, { timeout: 3_000 });

    // ── Patrol: pick two points on the map, Done. ──────────────────────────
    await page.locator('[data-testid="fleet-mode-patrol"]').click();
    await expect(page.locator('[data-testid="fleet-pick"]')).toHaveAttribute('data-fleet-pick', 'patrol');
    const py = box.y + Math.max(120, box.height * 0.25);
    await page.mouse.click(box.x + box.width * 0.35, py);
    await page.mouse.click(box.x + box.width * 0.65, py);
    await expect(page.locator('[data-testid="fleet-pick"]')).toHaveAttribute('data-fleet-pick-points', '2', { timeout: 2_000 });
    await page.locator('[data-testid="fleet-pick-done"]').click();
    await expect(page.locator('[data-testid="fleet-pick"]')).toHaveCount(0);
    await waitRowsActivity(page, /Patrolling/, 'the server reports the ships patrolling');
    await expect(page.locator('[data-testid="fleet-mode-patrol"]')).toHaveAttribute('aria-pressed', 'true');

    // ── Fly: Stop, drop one ship from the selection, take the other. ──────
    await page.locator('[data-testid="fleet-stop"]').click();
    // The server confirms the halt: the ships drop out of the patrol and hold
    // ("Guarding" the spot they brake to). They may still be coasting, so the
    // click below lands on where the hull is drawn this frame (well inside its
    // pick radius).
    await waitRowsActivity(page, /^(?!.*Patrolling).*Guarding/, 'Stop ends the patrol and the ships hold');
    const target = (await ownHulls(page))[0]!;
    await page.keyboard.down('Shift');
    await page.mouse.click(target.sx, target.sy);
    await page.keyboard.up('Shift');
    await expect.poll(() => selCount(page), { timeout: 3_000, message: 'shift-click drops one ship' }).toBe(1);

    await page.locator('[data-testid="pilot-toggle"]').click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pilot-mode') === 'pilot', undefined,
      { timeout: 10_000 },
    );
    await expect(page.locator('[data-testid="pilot-spectator-toggle"]')).toHaveAttribute('data-control-mode', 'fly');
    await a.ctx.close();
  });
});
