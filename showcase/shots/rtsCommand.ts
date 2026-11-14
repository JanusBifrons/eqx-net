import type { Page } from '@playwright/test';
import type { Shot, ShotContext } from '../types.js';
import { mouse, type Mouse } from '../touch.js';

/**
 * RTS command layer (docs/features/rts-command.md), the owner's sign-off film.
 *
 * Setup (before the take): the pilot joins `showcase-rts` in Command view
 * (`startMode=command`, as a galaxy join does) and the room's scene gives it
 * four more fighters, so it owns five parked, AI-flown hulls. A robot squad
 * (hostile to pilots on sight) holds position ~2.7 km north.
 *
 * The take is a player at the mouse and keyboard, nothing else: box-select
 * the fleet (the fleet panel appears), right-click to send it north, Hunt +
 * Aggressive (the rows read "Chasing ..."), they fight; Form squad, right-click
 * them back south (they fly in formation), double-click a member to take its
 * controls (the camera follows, the others form up on it), fly a turn, then
 * Command to hand it back. The camera is the command view's own: wheel zoom
 * and WASD panning toward the fleet. `?touchviz=1` draws the mouse pointer (a
 * screencast shows no cursor). No test cue touches play during the take.
 */

interface Hull { id: string; x: number; y: number; sx: number; sy: number }

/** Own parked hulls (game pose + page px). Empty while none is drawn. */
async function ownHulls(page: Page): Promise<Hull[]> {
  return page.evaluate(() => {
    const g = globalThis as {
      __eqxClient?: { mirror: { localPlayerId: string | null; lingeringShips?: Map<string, { ownerPlayerId?: string; x: number; y: number }> } };
      __eqxWorldToScreen?: (x: number, y: number) => { x: number; y: number };
    };
    const m = g.__eqxClient?.mirror;
    const canvas = document.querySelector('[data-testid="game-surface"]')?.getBoundingClientRect();
    const out: Array<{ id: string; x: number; y: number; sx: number; sy: number }> = [];
    if (!m || !g.__eqxWorldToScreen) return out;
    for (const [id, e] of m.lingeringShips ?? []) {
      if (e.ownerPlayerId !== m.localPlayerId) continue;
      const s = g.__eqxWorldToScreen(e.x, e.y);
      out.push({ id, x: e.x, y: e.y, sx: s.x + (canvas?.x ?? 0), sy: s.y + (canvas?.y ?? 0) });
    }
    return out;
  }).catch(() => []);
}

/** The local pilot's flown ship on the page (Fly mode), or null. */
async function flownShip(page: Page): Promise<{ sx: number; sy: number } | null> {
  return page.evaluate(() => {
    const g = globalThis as {
      __eqxClient?: { mirror: { localPlayerId: string | null; ships: Map<string, { x: number; y: number }> } };
      __eqxWorldToScreen?: (x: number, y: number) => { x: number; y: number };
    };
    const m = g.__eqxClient?.mirror;
    const me = m?.localPlayerId ? m.ships.get(m.localPlayerId) : undefined;
    if (!me || !g.__eqxWorldToScreen) return null;
    const s = g.__eqxWorldToScreen(me.x, me.y);
    return { sx: s.x, sy: s.y };
  }).catch(() => null);
}

/** Game point → page px through the renderer's own camera. */
async function worldToPage(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(([gx, gy]) => {
    const g = globalThis as { __eqxWorldToScreen?: (x: number, y: number) => { x: number; y: number } };
    const canvas = document.querySelector('[data-testid="game-surface"]')?.getBoundingClientRect();
    const s = g.__eqxWorldToScreen!(gx, gy);
    return { x: s.x + (canvas?.x ?? 0), y: s.y + (canvas?.y ?? 0) };
  }, [x, y] as const);
}

const rows = (page: Page): Promise<string> =>
  page.locator('[data-testid="fleet-ship-row"]').allTextContents().then((t) => t.join(' | ')).catch(() => '');

const selCount = (page: Page): Promise<number> =>
  page.locator('[data-testid="game-surface"]').getAttribute('data-fleet-sel-count').then((v) => Number(v ?? '0')).catch(() => 0);

const controlMode = (page: Page): Promise<string | null> =>
  page.locator('[data-testid="pilot-spectator-toggle"]').getAttribute('data-control-mode').catch(() => null);

/** Wait (polling, read only) until `pred` holds or `ms` passes; true if it held. */
async function waitUntil(ctx: ShotContext, pred: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await ctx.sleep(120);
  }
  return false;
}

/** Glide the pointer onto a button and click it, as a player would. */
async function clickButton(ctx: ShotContext, m: Mouse, testId: string): Promise<void> {
  const box = await ctx.page.locator(`[data-testid="${testId}"]`).first().boundingBox({ timeout: 3000 });
  if (!box) throw new Error(`${testId} is not on screen`);
  await m.glideTo(box.x + box.width / 2, box.y + box.height / 2, { ms: 450 });
  await ctx.sleep(120);
  await m.down('left');
  await ctx.sleep(60);
  await m.up('left');
}

/**
 * Keep the fleet in view the way a player does in Command view: hold WASD
 * toward it while its centre drifts out of the middle of the screen. Runs
 * until `stop.done`; releases every key it holds.
 */
async function panToFleet(ctx: ShotContext, stop: { done: boolean }, target: 'fleet' | 'flown' = 'fleet'): Promise<void> {
  const { width, height } = ctx.viewport;
  const held = new Set<string>();
  const set = async (key: string, on: boolean): Promise<void> => {
    if (on && !held.has(key)) { held.add(key); await ctx.page.keyboard.down(key); }
    if (!on && held.has(key)) { held.delete(key); await ctx.page.keyboard.up(key); }
  };
  try {
    while (!stop.done) {
      let cx: number | null = null, cy: number | null = null;
      if (target === 'fleet') {
        const hs = await ownHulls(ctx.page);
        if (hs.length > 0) {
          cx = hs.reduce((a, h) => a + h.sx, 0) / hs.length;
          cy = hs.reduce((a, h) => a + h.sy, 0) / hs.length;
        }
      }
      if (cx !== null && cy !== null) {
        const dx = (cx - width / 2) / width, dy = (cy - height / 2) / height;
        // Start panning past 15 % off-centre, stop once back within 6 %.
        await set('d', dx > (held.has('d') ? 0.06 : 0.15));
        await set('a', dx < -(held.has('a') ? 0.06 : 0.15));
        await set('s', dy > (held.has('s') ? 0.06 : 0.15));
        await set('w', dy < -(held.has('w') ? 0.06 : 0.15));
      }
      await ctx.sleep(100);
    }
  } finally {
    for (const k of [...held]) await ctx.page.keyboard.up(k);
  }
}

/** A few mouse-wheel notches at the screen centre (positive = zoom out). */
async function wheel(ctx: ShotContext, m: Mouse, notches: number): Promise<void> {
  await m.glideTo(ctx.viewport.width / 2, ctx.viewport.height * 0.42, { ms: 350 });
  for (let i = 0; i < Math.abs(notches); i++) {
    await ctx.page.mouse.wheel(0, Math.sign(notches) * 200);
    await ctx.sleep(110);
  }
}

export const rtsCommand: Shot = {
  id: 'rts-command',
  section: 'mechanics',
  title: 'Fleet command',
  caption: 'Command your fleet from above: box-select, right-click to move, set Hunt and Aggressive, form a squad — then take the controls of one ship and hand it back.',
  features: [],
  docs: ['rts-command', 'fleet-command'],
  reel: false,
  server: 'lean',
  target: {
    room: 'showcase-rts',
    params: { shipKind: 'fighter', startMode: 'command', zoom: 0.5, touchviz: 1 },
  },
  hud: 'full',
  durationMs: 80_000,
  endsWithRun: true,
  async prepare(ctx) {
    // Setup: the scene's four extra hulls are parked and drawn, and the view
    // is Command (the join's own flip; nothing forced).
    const ok = await waitUntil(ctx, async () => (await ownHulls(ctx.page)).length >= 5 && (await controlMode(ctx.page)) === 'command', 20_000);
    if (!ok) throw new Error(`setup: expected 5 own parked hulls in Command view, got ${(await ownHulls(ctx.page)).length} (${await controlMode(ctx.page)})`);
    await ctx.sleep(1500);
  },
  async run(ctx) {
    const { page, viewport } = ctx;
    const W = viewport.width, H = viewport.height;
    const m = await mouse(page, { x: W * 0.62, y: H * 0.3 });
    const t0 = Date.now();
    const mark = (what: string): void => ctx.log(`  [rts ${((Date.now() - t0) / 1000).toFixed(1)} s] ${what}`);

    await ctx.sleep(1500);

    // 1. Box-select the fleet with a left drag around it.
    const hs = await ownHulls(page);
    const pad = 60;
    const x0 = Math.min(...hs.map((h) => h.sx)) - pad, y0 = Math.min(...hs.map((h) => h.sy)) - pad;
    const x1 = Math.max(...hs.map((h) => h.sx)) + pad, y1 = Math.max(...hs.map((h) => h.sy)) + pad;
    await m.glideTo(x0, y0, { ms: 700 });
    await m.down('left');
    await m.glideTo(x1, y1, { ms: 1100 });
    await m.up('left');
    mark(`box drag done; selected ${await selCount(page)}`);
    await waitUntil(ctx, async () => (await selCount(page)) >= 5, 3000);
    mark(`selected ${await selCount(page)}; rows: ${await rows(page)}`);
    await ctx.sleep(2200);

    // 2. Zoom out a little, then right-click empty space up the screen
    //    (north, below the top HUD): move there.
    await wheel(ctx, m, 4);
    await ctx.sleep(700);
    const mx = W * 0.53, my = H * 0.3;
    await m.glideTo(mx, my, { ms: 700 });
    await ctx.sleep(150);
    await page.mouse.click(mx, my, { button: 'right' });
    mark('right-click move north');
    const follow = { done: false };
    const panning = panToFleet(ctx, follow);
    await waitUntil(ctx, async () => /Moving/.test(await rows(page)), 3000);
    mark(`rows: ${await rows(page)}`);
    await ctx.sleep(4000);

    // 3. Hunt + Aggressive: they go after the robots on their own.
    await clickButton(ctx, m, 'fleet-mode-hunt');
    await ctx.sleep(500);
    await clickButton(ctx, m, 'fleet-stance-aggressive');
    mark('hunt + aggressive');
    await m.glideTo(W * 0.7, H * 0.25, { ms: 600 });
    await wheel(ctx, m, 1);
    const chasing = await waitUntil(ctx, async () => /Chasing/.test(await rows(page)), 12_000);
    mark(`chasing=${chasing}; rows: ${await rows(page)}`);
    // Let the fight play out (it ends when the robots are gone or the window passes).
    const fightEnd = Date.now() + 22_000;
    while (Date.now() < fightEnd) {
      const r = await rows(page);
      if (!/Chasing|Attacking/.test(r) && Date.now() > fightEnd - 16_000) break;
      await ctx.sleep(500);
    }
    mark(`fight window over; rows: ${await rows(page)}`);
    await ctx.sleep(1500);

    // 4. Form squad, then right-click them back south: they fly in formation.
    await clickButton(ctx, m, 'fleet-form-squad');
    const formed = await waitUntil(ctx, async () => (await page.locator('[data-testid="fleet-disband-squad"]').count()) > 0, 3000);
    mark(`squad formed=${formed} (${await selCount(page)} selected)`);
    await ctx.sleep(1200);
    const now = await ownHulls(page);
    const cxw = now.reduce((a, h) => a + h.x, 0) / Math.max(1, now.length);
    const cyw = now.reduce((a, h) => a + h.y, 0) / Math.max(1, now.length);
    const back = await worldToPage(page, cxw - 700, cyw - 900);
    const bx = Math.min(W * 0.85, Math.max(W * 0.15, back.x)), by = Math.min(H * 0.72, Math.max(H * 0.15, back.y));
    await m.glideTo(bx, by, { ms: 700 });
    await ctx.sleep(150);
    await page.mouse.click(bx, by, { button: 'right' });
    mark('right-click squad move');
    await ctx.sleep(9000);
    mark(`rows: ${await rows(page)}`);

    // 5. Double-click one squad member: take its controls.
    follow.done = true;
    await panning;
    const pick = (await ownHulls(page))[1] ?? (await ownHulls(page))[0];
    if (!pick) throw new Error('no own hull to take');
    await m.glideTo(pick.sx, pick.sy, { ms: 500 });
    const fresh = (await ownHulls(page)).find((h) => h.id === pick.id) ?? pick;
    await page.mouse.dblclick(fresh.sx, fresh.sy);
    mark('double-click a member');
    const flying = await waitUntil(ctx, async () => (await controlMode(page)) === 'fly', 6000);
    mark(`fly=${flying}`);
    await ctx.sleep(1500);
    // Fly a slow turn; the others form up on the flown ship.
    await page.keyboard.down('ArrowUp');
    await ctx.sleep(1200);
    await page.keyboard.down('ArrowLeft');
    await ctx.sleep(2200);
    await page.keyboard.up('ArrowLeft');
    await ctx.sleep(2500);
    await page.keyboard.up('ArrowUp');
    mark(`flown ship on screen at ${JSON.stringify(await flownShip(page))}`);
    await ctx.sleep(2500);

    // 6. Command: hand the ship back to its wingman, free camera again.
    await clickButton(ctx, m, 'spectator-toggle');
    const cmd = await waitUntil(ctx, async () => (await controlMode(page)) === 'command', 6000);
    mark(`command=${cmd}`);
    await m.glideTo(W * 0.5, H * 0.45, { ms: 800 });
    await ctx.sleep(3500);
  },
};
