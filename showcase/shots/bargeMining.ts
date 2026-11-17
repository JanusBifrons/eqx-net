import type { Shot, ShotContext } from '../types.js';
import { SHOWCASE_BARGE_MINING_ROCKS } from '../../src/server/rooms/showcaseBargeRooms.js';

/** The barge's weapon groups in HUD order: the number key selects one
 *  (`fcKeyAction`: Digit1 = the first group, Digit2 = the second). */
const LASER_KEY = 'Digit1';
const TRACTOR_KEY = 'Digit2';

/** The rock the pilot works: the one off the barge's port bow at its spawn. */
const ROCK = SHOWCASE_BARGE_MINING_ROCKS.find((r) => r.id === 'mine-rock-a')!;

/** The take: the integration take (`bargeMiningTake.test.ts`, same pose)
 *  needs ~174 s of game time from the locks to the last pod in the hold (one
 *  XL laser bears on the whole rock); trimmed later. */
const TAKE_MS = 180_000;

/**
 * Lock mine-rock-a with the ACTIVE weapon group, as a player does: select it
 * (what a click on it does) and press LOCK (the info box's action). The rock
 * is found in the mirror as the one nearest its placed position (from the
 * spawn the nearest rock to the hull is mine-rock-d, not the one in the bow
 * lasers' arc). Returns its swarm id, or null with no rock.
 * No named helper in the callback (tsx's `__name`, docs/LESSONS.md).
 */
async function lockRock(ctx: ShotContext): Promise<number | null> {
  return ctx.page.evaluate((at) => {
    const w = window as unknown as {
      __eqxStore?: { getState(): { setSelection(ids: readonly string[], id: string | null, kind: string | null): void } };
      __eqxClient?: {
        lockSelected?: () => boolean;
        mirror?: {
          localPlayerId: string | null;
          ships: Map<string, { x: number; y: number }>;
          swarm: Map<number, { kind: number; x: number; y: number }>;
        };
      };
    };
    const m = w.__eqxClient?.mirror;
    if (!m) return null;
    let best: number | null = null, bestD = Infinity;
    for (const [eid, e] of m.swarm) {
      if (e.kind !== 0) continue; // a rock (asteroid)
      const d = Math.hypot(e.x - at.x, e.y - at.y);
      if (d < bestD) { bestD = d; best = eid; }
    }
    if (best === null) return null;
    w.__eqxStore?.getState().setSelection([], `swarm-${best}`, 'asteroid');
    w.__eqxClient?.lockSelected?.();
    return best;
  }, { x: ROCK.x, y: ROCK.y });
}

/** Wheel in to the barge's zoom cap (the whole hull still fits: the game's
 *  own limit) from wherever the camera starts. */
async function zoomToCap(ctx: ShotContext): Promise<void> {
  const c = ctx.px(960, 540);
  await ctx.page.mouse.move(c.x, c.y);
  for (let i = 0; i < 30; i++) {
    await ctx.page.mouse.wheel(0, -100);
    await ctx.sleep(40);
  }
}

/**
 * Salvage stream: the mining barge works a rock. The pilot flies the barge
 * (`showcase-barge-mining`: eight placed rocks of mixed sizes in a loose ring,
 * every one too heavy for any tractor, nothing else in the sector), starting
 * with mine-rock-a off the port bow (the room's spawn: only the bow XL lasers
 * cut a whole rock, and there the rock is on screen), and does what a player does: selects the "Mining lasers" group
 * (key 1) and locks mine-rock-a, selects the "Tractors" group (key 2) and
 * locks the same rock, then holds position. Everything after that is the game's own
 * size ladder (`turretLockPick.ts`, `salvageTargeting.ts`): the lasers cut the
 * rock, the locks follow its pieces, the lasers spread over the pieces by
 * size, each tractor takes the pieces at or below its own size and pulls them
 * in to the smaller lasers, and pieces small enough for the hold go into it
 * once they come close. No per-piece cue during the take. Every lock is a
 * real lock (fire is lock-gated, #19; `instantLock` only skips the lock
 * timer, as in the other salvage takes); both groups stay in AUTO, so each
 * fires at its own locks. The camera is the game's follow camera at the
 * barge's closest zoom (the whole hull fits, the game's own cap).
 */
export const bargeMining: Shot = {
  id: 'barge-mining',
  section: 'mechanics',
  title: 'The mining barge works a rock',
  caption: 'Mining lasers slice a rock down the size ladder; the tractors pull the pieces in to the hull.',
  features: ['CAP'],
  docs: ['mining-and-salvage'],
  reel: false,
  server: 'lean',
  target: { room: 'showcase-barge-mining', params: { shipKind: 'barge', instantLock: 1, initialHull: 1_000_000 } },
  durationMs: TAKE_MS,
  async startWhen(ctx) {
    await ctx.page.waitForFunction(() => {
      let n = 0;
      (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient?.mirror.swarm.forEach((e) => { if (e.kind === 0) n++; });
      return n >= 8;
    }, null, { timeout: 60_000, polling: 250 });
    await ctx.page.waitForSelector('[data-testid="fc-chip-tractor"]', { timeout: 30_000 });
    await zoomToCap(ctx);
  },
  async run(ctx) {
    // The pilot's two locks, on camera; then hands off for the rest of the take.
    await ctx.page.keyboard.press(LASER_KEY);
    await ctx.sleep(400);
    await lockRock(ctx);
    await ctx.sleep(800);
    await ctx.page.keyboard.press(TRACTOR_KEY);
    await ctx.sleep(400);
    await lockRock(ctx);
    await ctx.sleep(TAKE_MS - 2_000);
  },
};
