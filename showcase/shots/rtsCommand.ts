import type { Page } from '@playwright/test';
import type { Shot, ShotContext } from '../types.js';
import { mouse, type Mouse } from '../touch.js';

/**
 * RTS command layer (docs/features/rts-command.md), the owner's sign-off film.
 *
 * Setup (before the take): the pilot joins `showcase-rts` in Command view
 * (`startMode=command`, as a galaxy join does) and the room's scene gives it
 * four more fighters, so it owns five parked, AI-flown hulls. Three robot
 * cubes (hostile to pilots on sight) hold position ~2 km north.
 *
 * The take is a player at the mouse and keyboard, nothing else:
 *  1. box-select all five (the fleet panel appears), right-click to send them
 *     somewhere away from the robots;
 *  2. Form squad, right-click the squad on (it flies in formation);
 *  3. double-click a squad member: take its controls (the camera follows),
 *     fly it with the keys while the others form up on it;
 *  4. Command: hand it back, free camera again;
 *  5. re-select, Hunt + Aggressive, right-click toward the robots and let the
 *     fight play out to the end of the take, whatever happens.
 * The camera is the command view's own: wheel zoom and WASD panning toward
 * the fleet. `?touchviz=1` draws the mouse pointer (a screencast shows no
 * cursor). No test cue touches play during the take.
 */
interface Hull { id: string; x: number; y: number; sx: number; sy: number }

/** Own parked hulls (game pose + page px). Empty while none is drawn. */
async function ownHulls(page: Page): Promise<Hull[]> {
  return page.evaluate(() => {
    const g = globalThis as {
      __eqxClient?: { mirror: { localPlayerId: string | null; ships: Map<string, { isActive?: boolean; ownerPlayerId?: string; x: number; y: number }> } };
      __eqxWorldToScreen?: (x: number, y: number) => { x: number; y: number };
    };
    const m = g.__eqxClient?.mirror;
    const canvas = document.querySelector('[data-testid="game-surface"]')?.getBoundingClientRect();
    const out: Array<{ id: string; x: number; y: number; sx: number; sy: number }> = [];
    if (!m || !g.__eqxWorldToScreen) return out;
    // Own ships are ordinary ships in the mirror (AI-flown ones not active,
    // the one the pilot flies active); the take wants all of them.
    for (const [id, e] of m.ships) {
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
async function panToFleet(ctx: ShotContext, stop: { done: boolean }, target: 'fleet' | 'fight' = 'fleet'): Promise<void> {
  const { width, height } = ctx.viewport;
  const held = new Set<string>();
  const set = async (key: string, on: boolean): Promise<void> => {
    if (on && !held.has(key)) { held.add(key); await ctx.page.keyboard.down(key); }
    if (!on && held.has(key)) { held.delete(key); await ctx.page.keyboard.up(key); }
  };
  try {
    while (!stop.done) {
      let cx: number | null = null, cy: number | null = null;
      // 'fight': the middle of the fleet and the robots it is fighting.
      const pts: Array<{ sx: number; sy: number }> = [...(await ownHulls(ctx.page))];
      if (target === 'fight') pts.push(...(await robots(ctx.page)));
      if (pts.length > 0) {
        cx = pts.reduce((a, h) => a + h.sx, 0) / pts.length;
        cy = pts.reduce((a, h) => a + h.sy, 0) / pts.length;
      }
      if (cx !== null && cy !== null) {
        const dx = (cx - width / 2) / width, dy = (cy - height / 2) / height;
        // Start panning past 15 % (fight: 8 %) off-centre, stop once back within 6 % (3 %).
        const go = target === 'fight' ? 0.08 : 0.15, stay = target === 'fight' ? 0.03 : 0.06;
        await set('d', dx > (held.has('d') ? stay : go));
        await set('a', dx < -(held.has('a') ? stay : go));
        await set('s', dy > (held.has('s') ? stay : go));
        await set('w', dy < -(held.has('w') ? stay : go));
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

/** Live robots (game pose + page px). */
async function robots(page: Page): Promise<Array<{ x: number; y: number; sx: number; sy: number }>> {
  return page.evaluate(() => {
    const g = globalThis as {
      __eqxClient?: { mirror: { swarm: Map<number, { kind: number; shipKind?: string; x: number; y: number }> } };
      __eqxWorldToScreen?: (x: number, y: number) => { x: number; y: number };
    };
    const canvas = document.querySelector('[data-testid="game-surface"]')?.getBoundingClientRect();
    const out: Array<{ x: number; y: number; sx: number; sy: number }> = [];
    if (!g.__eqxClient || !g.__eqxWorldToScreen) return out;
    g.__eqxClient.mirror.swarm.forEach((e) => {
      if (e.kind !== 1 || !e.shipKind?.startsWith('robot')) return;
      const s = g.__eqxWorldToScreen!(e.x, e.y);
      out.push({ x: e.x, y: e.y, sx: s.x + (canvas?.x ?? 0), sy: s.y + (canvas?.y ?? 0) });
    });
    return out;
  }).catch(() => []);
}

/** Left-drag a box around every own parked hull. */
async function boxSelectAll(ctx: ShotContext, m: Mouse): Promise<void> {
  // First bring the whole fleet onto the open canvas (clear of the top HUD and
  // the bottom panel), as a player pans/zooms before dragging a box.
  const { width: W, height: H } = ctx.viewport;
  const pad = 60;
  const area = { x0: W * 0.08, x1: W * 0.92, y0: H * 0.18, y1: H * 0.7 };
  const deadline = Date.now() + 5000;
  const held = new Set<string>();
  const set = async (key: string, on: boolean): Promise<void> => {
    if (on && !held.has(key)) { held.add(key); await ctx.page.keyboard.down(key); }
    if (!on && held.has(key)) { held.delete(key); await ctx.page.keyboard.up(key); }
  };
  try {
    while (Date.now() < deadline) {
      const cur = await ownHulls(ctx.page);
      if (cur.length === 0) break;
      const bx0 = Math.min(...cur.map((h) => h.sx)) - pad, bx1 = Math.max(...cur.map((h) => h.sx)) + pad;
      const by0 = Math.min(...cur.map((h) => h.sy)) - pad, by1 = Math.max(...cur.map((h) => h.sy)) + pad;
      if (bx1 - bx0 > area.x1 - area.x0 || by1 - by0 > area.y1 - area.y0) {
        for (const k of [...held]) await set(k, false);
        await wheel(ctx, m, 1);
        await ctx.sleep(300);
        continue;
      }
      const fits = bx0 >= area.x0 && bx1 <= area.x1 && by0 >= area.y0 && by1 <= area.y1;
      if (fits) break;
      const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2;
      const ax = (area.x0 + area.x1) / 2, ay = (area.y0 + area.y1) / 2;
      await set('d', cx > ax + 60);
      await set('a', cx < ax - 60);
      await set('s', cy > ay + 60);
      await set('w', cy < ay - 60);
      await ctx.sleep(60);
    }
  } finally {
    for (const k of [...held]) await ctx.page.keyboard.up(k);
  }
  await ctx.sleep(150);
  const hs = await ownHulls(ctx.page);
  if (hs.length === 0) return;
  const x0 = Math.min(...hs.map((h) => h.sx)) - pad, y0 = Math.min(...hs.map((h) => h.sy)) - pad;
  const x1 = Math.max(...hs.map((h) => h.sx)) + pad, y1 = Math.max(...hs.map((h) => h.sy)) + pad;
  await m.glideTo(x0, y0, { ms: 600 });
  await m.down('left');
  await m.glideTo(x1, y1, { ms: 900 });
  await m.up('left');
}

async function rightClick(ctx: ShotContext, m: Mouse, x: number, y: number): Promise<void> {
  await m.glideTo(x, y, { ms: 600 });
  await ctx.sleep(120);
  await ctx.page.mouse.click(x, y, { button: 'right' });
}

export const rtsCommand: Shot = {
  id: 'rts-command',
  section: 'mechanics',
  title: 'Fleet command',
  caption: 'Command view: select, move and squad your fleet, fly one ship yourself, then send them hunting.',
  features: [],
  docs: ['rts-command', 'fleet-command'],
  reel: false,
  server: 'lean',
  target: {
    room: 'showcase-rts',
    params: { shipKind: 'fighter', startMode: 'command', zoom: 0.7, touchviz: 1 },
  },
  hud: 'full',
  // The action and the fleet panel fill the lower half: a small caption at
  // the top right keeps clear of both.
  captionLayout: 'corner',
  captionHoldMs: 7000,
  durationMs: 85_000,
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

    // A click on empty space gives the page focus, so the WASD camera keys work.
    await m.glideTo(W * 0.86, H * 0.62, { ms: 400 });
    await page.mouse.click(W * 0.86, H * 0.62);
    await ctx.sleep(300);

    // 1. Box-select all five, right-click them somewhere away from the robots.
    await boxSelectAll(ctx, m);
    await waitUntil(ctx, async () => (await selCount(page)) >= 5, 3000);
    mark(`selected ${await selCount(page)}; rows: ${await rows(page)}`);
    await ctx.sleep(1500);
    await rightClick(ctx, m, W * 0.28, H * 0.58);
    mark('right-click move (south-west, away from the robots)');
    let follow = { done: false };
    let panning = panToFleet(ctx, follow);
    await waitUntil(ctx, async () => /Moving/.test(await rows(page)), 3000);
    mark(`rows: ${await rows(page)}`);
    await ctx.sleep(3500);

    // 2. Form squad, then move the squad: it flies in formation.
    await clickButton(ctx, m, 'fleet-form-squad');
    const formed = await waitUntil(ctx, async () => (await page.locator('[data-testid="fleet-disband-squad"]').count()) > 0, 3000);
    mark(`squad formed=${formed} (${await selCount(page)} selected)`);
    await ctx.sleep(900);
    await rightClick(ctx, m, W * 0.74, H * 0.5);
    mark('right-click squad move (east)');
    await ctx.sleep(1500);
    mark(`rows: ${await rows(page)}`);
    await ctx.sleep(4500);

    // 3. Double-click one squad member: take its controls; fly it with the keys.
    follow.done = true;
    await panning;
    const hs = await ownHulls(page);
    const pick = hs[Math.min(1, hs.length - 1)];
    if (!pick) throw new Error('no own hull to take');
    await m.glideTo(pick.sx, pick.sy, { ms: 450 });
    const fresh = (await ownHulls(page)).find((h) => h.id === pick.id) ?? pick;
    await page.mouse.dblclick(fresh.sx, fresh.sy);
    mark('double-click a squad member');
    const flying = await waitUntil(ctx, async () => (await controlMode(page)) === 'fly', 6000);
    mark(`fly=${flying}`);
    await ctx.sleep(500);
    // Close-up while flying: wheel in on the flown ship.
    await wheel(ctx, m, -3);
    await m.glideTo(W * 0.82, H * 0.2, { ms: 400 });
    await page.keyboard.down('ArrowUp');
    await ctx.sleep(1500);
    await page.keyboard.down('ArrowRight');
    await ctx.sleep(900);
    await page.keyboard.up('ArrowRight');
    await ctx.sleep(2200);
    await page.keyboard.up('ArrowUp');
    mark(`flown ship on screen at ${JSON.stringify(await flownShip(page))}`);
    await ctx.sleep(800);
    await wheel(ctx, m, 3);
    await ctx.sleep(700);

    // 4. Command: hand it back to its wingman, free camera again.
    await clickButton(ctx, m, 'spectator-toggle');
    const cmd = await waitUntil(ctx, async () => (await controlMode(page)) === 'command', 6000);
    mark(`command=${cmd}`);
    // The handed-back ship keeps its speed for a moment: let it slow, then
    // the box-drag below pans/zooms until all five are on the canvas.
    await ctx.sleep(2500);
    await waitUntil(ctx, async () => (await ownHulls(page)).length >= 5, 3000);

    // 5. Re-select, Hunt + Aggressive, right-click toward the robots; the fight plays out.
    await boxSelectAll(ctx, m);
    await waitUntil(ctx, async () => (await selCount(page)) >= 1, 3000);
    mark(`re-selected ${await selCount(page)}; rows: ${await rows(page)}`);
    await ctx.sleep(600);
    await clickButton(ctx, m, 'fleet-mode-hunt');
    await ctx.sleep(400);
    await clickButton(ctx, m, 'fleet-stance-aggressive');
    mark('hunt + aggressive');
    await wheel(ctx, m, 2);
    await ctx.sleep(500);
    const rs = await robots(page);
    const rx = rs.length ? rs.reduce((a, r) => a + r.sx, 0) / rs.length : W * 0.5;
    const ry = rs.length ? rs.reduce((a, r) => a + r.sy, 0) / rs.length : H * 0.3;
    await rightClick(ctx, m, Math.min(W * 0.85, Math.max(W * 0.15, rx)), Math.min(H * 0.6, Math.max(H * 0.3, ry)));
    mark(`right-click toward the robots (robots on page ${rs.map((r) => `${r.sx.toFixed(0)},${r.sy.toFixed(0)}`).join(' ')})`);
    follow = { done: false };
    panning = panToFleet(ctx, follow, 'fight');
    await m.glideTo(W * 0.82, H * 0.2, { ms: 600 });
    let zoomOuts = 0;
    /** Zoom out a notch (a few at most) when the fight spreads past the screen. */
    const keepFightInView = async (): Promise<void> => {
      if (zoomOuts >= 4) return;
      const pts: Array<{ sx: number; sy: number }> = [...(await ownHulls(page)), ...(await robots(page))];
      if (pts.length < 2) return;
      const w = Math.max(...pts.map((p) => p.sx)) - Math.min(...pts.map((p) => p.sx));
      const h = Math.max(...pts.map((p) => p.sy)) - Math.min(...pts.map((p) => p.sy));
      if (w > W * 0.8 || h > H * 0.5) {
        zoomOuts++;
        await wheel(ctx, m, 1);
        await m.glideTo(W * 0.82, H * 0.2, { ms: 300 });
      }
    };
    // The fight plays out: end ~3 s after it is decided, or at the cap.
    const engaged = await waitUntil(ctx, async () => /Attacking/.test(await rows(page)), 15_000);
    mark(`engaged=${engaged}; rows: ${await rows(page)}`);
    // Close-up on the fight for a few seconds, then back out.
    await wheel(ctx, m, -3);
    await m.glideTo(W * 0.82, H * 0.2, { ms: 300 });
    await ctx.sleep(5500);
    await wheel(ctx, m, 3);
    await m.glideTo(W * 0.82, H * 0.2, { ms: 300 });
    mark('close-up done');
    const end = Date.now() + 32_000;
    let quietSince = 0;
    let last = '';
    while (Date.now() < end) {
      const r = await rows(page);
      if (r !== last) { mark(`rows: ${r}`); last = r; }
      const fighting = /Chasing|Attacking/.test(r) && (await robots(page)).length > 0;
      if (!fighting) {
        if (quietSince === 0) quietSince = Date.now();
        else if (Date.now() - quietSince > 3000) break;
      } else quietSince = 0;
      await keepFightInView();
      await ctx.sleep(500);
    }
    mark(`fight over; robots left ${(await robots(page)).length}; own hulls ${(await ownHulls(page)).length}`);
    follow.done = true;
    await panning;
  },
};
