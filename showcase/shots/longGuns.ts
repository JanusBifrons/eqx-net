import type { Shot, ShotContext } from '../types.js';
import { sendRoom } from './_helpers.js';
import { artSettled } from './capitals.js';

/** The NPC battleship's swarm entity id (the only ship in the room). */
async function npcBattleship(ctx: ShotContext): Promise<number | null> {
  return ctx.page.evaluate(() => {
    const m = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient?.mirror;
    let id: number | null = null;
    m?.swarm.forEach((e, eid) => { if (id === null && e.kind === 1) id = eid; });
    return id;
  });
}

/** One status line for the take log: what the row and the pilot's mirror show. */
async function status(ctx: ShotContext, rowSel: string): Promise<string> {
  const row = ctx.page.locator(rowSel);
  const lock = await row.getAttribute('data-lock', { timeout: 500 }).catch(() => '?');
  const you = await row.getAttribute('data-locking-you', { timeout: 500 }).catch(() => '?');
  const shells = await ctx.page.evaluate(() => {
    const m = (globalThis as { __eqxClient?: { mirror: { projectiles: Map<unknown, unknown> } } }).__eqxClient?.mirror;
    return m?.projectiles.size ?? -1;
  }).catch(() => -1);
  return `lock=${lock} lockingYou=${you} shells=${shells}`;
}

/**
 * Real-scale ranges (docs/architecture/real-scale-ranges.md), flown as a
 * player flies it. The pilot is a battleship; an NPC battleship sits 30 km off
 * its starboard beam, turned hostile by ONE `test_aggro` before recording.
 * Setup also puts the main battery in MAN (Shift+1, a player's key) so the
 * lock is the pilot's pick from the list, not the AUTO group's.
 *
 * During the take, only player inputs: O opens the contacts list, a click on
 * the far battleship's row asks the main battery to lock it, the mouse wheel
 * pulls the camera back to the gunnery zoom while the lock builds at its real
 * pace, and Space (held) fires the battery once locked. The shells fly their
 * real ~25 s. The enemy's own lock and salvos run on the game's clock, with
 * the incoming-fire warning when they come. No survive params, no lock or
 * reload cues, the follow camera throughout.
 */
export const longGuns: Shot = {
  id: 'long-guns',
  section: 'mechanics',
  title: 'Long guns',
  caption: 'A battleship 30 km out: pick it from the contacts list, pull back to the gunnery zoom while the lock builds, fire, and wait out the flight.',
  features: ['CAP'],
  docs: ['real-scale-ranges', 'fire-control', 'off-screen-indicators'],
  reel: false,
  server: 'naval',
  target: { room: 'showcase-long-guns', params: { sectorScale: '4', navalRange: 'real', shipKind: 'battleship' } },
  durationMs: 100_000,
  async startWhen(ctx) {
    await artSettled(ctx);
    await ctx.page.waitForFunction(() => {
      const m = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient?.mirror;
      let n = 0;
      m?.swarm.forEach((e) => { if (e.kind === 1) n++; });
      return n > 0;
    }, undefined, { timeout: 60_000, polling: 250 });
    // The main battery is group 1: select it and switch it to MAN, as a pilot
    // who wants to choose the target would.
    await ctx.page.waitForSelector('[data-testid="fc-chip-main"]', { timeout: 30_000 });
    await ctx.page.keyboard.press('Digit1');
    await ctx.page.keyboard.press('Shift+Digit1');
    await ctx.page.waitForSelector('[data-testid="fc-chip-main"][data-mode="manual"]', { timeout: 10_000 });
    // One cue sets the scene: the far battleship turns hostile now.
    await sendRoom(ctx, 'test_aggro', { type: 'test_aggro' });
    await ctx.sleep(500);
  },
  async run(ctx) {
    const t0 = Date.now();
    const id = await npcBattleship(ctx);
    if (id === null) throw new Error('long-guns: the NPC battleship is not in the mirror');
    const rowSel = `[data-testid="contact-row-s:${id}"]`;
    const row = ctx.page.locator(rowSel);

    await ctx.sleep(1500);
    // Open the contacts list.
    await ctx.page.keyboard.press('o');
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    await ctx.sleep(1500);
    // Lock it from the list (a click on an acquiring/locked row would cancel).
    if ((await row.getAttribute('data-lock')) === 'none') await row.click();
    ctx.log(`  [long-guns] t=${((Date.now() - t0) / 1000).toFixed(1)}s lock requested: ${await status(ctx, rowSel)}`);

    // Pull back to the gunnery zoom with the wheel while the lock builds.
    const c = ctx.px(1100, 540);
    await ctx.page.mouse.move(c.x, c.y);
    await ctx.sleep(800);
    for (let i = 0; i < 30; i++) {
      await ctx.page.mouse.wheel(0, 100);
      await ctx.sleep(160);
    }

    // Wait for the lock at its real pace.
    const lockDeadline = Date.now() + 50_000;
    let locked = false;
    let nextLog = Date.now() + 5000;
    while (Date.now() < lockDeadline) {
      if ((await row.getAttribute('data-lock').catch(() => null)) === 'locked') { locked = true; break; }
      if (Date.now() > nextLog) { ctx.log(`  [long-guns] t=${((Date.now() - t0) / 1000).toFixed(1)}s ${await status(ctx, rowSel)}`); nextLog += 5000; }
      await ctx.sleep(250);
    }
    ctx.log(`  [long-guns] t=${((Date.now() - t0) / 1000).toFixed(1)}s ${locked ? 'LOCKED' : 'no lock in 50 s'}: ${await status(ctx, rowSel)}`);

    // Fire: hold Space on the active (main) group for the rest of the take.
    await ctx.page.keyboard.down('Space');
    try {
      const end = t0 + 99_000;
      while (Date.now() < end) {
        await ctx.sleep(Math.min(10_000, Math.max(0, end - Date.now())));
        ctx.log(`  [long-guns] t=${((Date.now() - t0) / 1000).toFixed(1)}s ${await status(ctx, rowSel)}`);
      }
    } finally {
      await ctx.page.keyboard.up('Space');
    }
  },
};
