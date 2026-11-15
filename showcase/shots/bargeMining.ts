import type { Shot, ShotContext } from '../types.js';

/** The barge's two weapon groups (slot ids = the HUD chip test ids). */
const LASER = 'laser';
const TRACTOR = 'tractor';

/** Half the visible frame (world u) round the barge at its closest zoom. */
const FRAME_HALF_W = 6000;
const FRAME_HALF_H = 3500;

/** What the page asks the shot to do this beat: a fresh lock for a group
 *  (a swarm entity id), and where the worked target sits from our ship. */
type Beat = { laser: number | null; tractor: number | null; dx: number; dy: number } | null;

/**
 * One beat of the pilot's choices, read from the render mirror (no named
 * helper in the callback: tsx's `__name`, docs/LESSONS.md).
 * - Mining lasers: keep the rock or piece in work while it is there; when it
 *   is gone (it split or became a pod), take the rock piece (kind 4) nearest
 *   the last worked spot; with no piece left, the rock (kind 0) nearest the
 *   barge on the other side from the last one.
 * - Tractors: keep the held pod while it is there; else the ore pod (kind 3)
 *   nearest the barge; never the piece the lasers work.
 * Only what is in frame is picked.
 * A non-null id means "lock this with that group" (the shot does it through
 * the HUD chip + the info box's LOCK, the real path).
 */
async function beat(ctx: ShotContext): Promise<Beat> {
  // Half the frame in world u at the barge's closest zoom (1080p): only what
  // the viewer can see is worked.
  return ctx.page.evaluate((a) => {
    type E = { kind: number; x: number; y: number };
    const w = window as unknown as {
      __eqxClient?: { mirror?: { localPlayerId: string | null; ships: Map<string, { x: number; y: number }>; swarm: Map<number, E> } };
      __eqxMineLaser?: number;
      __eqxMineTractor?: number;
      __eqxMineAt?: { x: number; y: number };
    };
    const m = w.__eqxClient?.mirror;
    const me = m?.localPlayerId ? m.ships.get(m.localPlayerId) : undefined;
    if (!m || !me) return null;
    let laser: number | null = null;
    const lCur = w.__eqxMineLaser !== undefined ? m.swarm.get(w.__eqxMineLaser) : undefined;
    if (lCur !== undefined && (lCur.kind === 0 || lCur.kind === 4)) {
      w.__eqxMineAt = { x: lCur.x, y: lCur.y };
    } else {
      const at = w.__eqxMineAt;
      let best: number | null = null, bestD = Infinity;
      if (at) {
        for (const [eid, e] of m.swarm) {
          if (e.kind !== 4 || eid === w.__eqxMineTractor || Math.abs(e.x - me.x) > a.fw || Math.abs(e.y - me.y) > a.fh) continue;
          const d = Math.hypot(e.x - at.x, e.y - at.y);
          if (d < bestD) { bestD = d; best = eid; }
        }
      }
      if (best === null) {
        // Next rock: the nearest on the OTHER side of the barge from the last
        // one, so the finished side's pods come in while the lasers are busy
        // across the hull (a beam stops at the first body on its line, and an
        // ore pod is one); the nearest anywhere when that side is bare.
        const side = at ? Math.sign(at.x - me.x) : 0;
        for (let pass = 0; pass < 2 && best === null; pass++) {
          for (const [eid, e] of m.swarm) {
            if (e.kind !== 0 || Math.abs(e.x - me.x) > a.fw || Math.abs(e.y - me.y) > a.fh) continue;
            if (pass === 0 && side !== 0 && Math.sign(e.x - me.x) === side) continue;
            const d = Math.hypot(e.x - me.x, e.y - me.y);
            if (d < bestD) { bestD = d; best = eid; }
          }
        }
      }
      if (best !== null) {
        const p = m.swarm.get(best)!;
        w.__eqxMineLaser = best;
        w.__eqxMineAt = { x: p.x, y: p.y };
        laser = best;
      }
    }
    // Tractors: an ore pod in frame (the nearest the barge) while there is
    // one; never what the lasers work.
    let tractor: number | null = null;
    let tWant: number | undefined;
    let podD = Infinity;
    for (const [eid, e] of m.swarm) {
      if (e.kind !== 3 || Math.abs(e.x - me.x) > a.fw || Math.abs(e.y - me.y) > a.fh) continue;
      const d = Math.hypot(e.x - me.x, e.y - me.y);
      if (d < podD) { podD = d; tWant = eid; }
    }
    const tCur = w.__eqxMineTractor !== undefined ? m.swarm.get(w.__eqxMineTractor) : undefined;
    if (tCur !== undefined && tCur.kind === 3) tWant = w.__eqxMineTractor;
    if (tWant !== undefined && tWant !== w.__eqxMineTractor) { w.__eqxMineTractor = tWant; tractor = tWant; }
    const at = w.__eqxMineAt ?? { x: me.x, y: me.y };
    return { laser, tractor, dx: at.x - me.x, dy: at.y - me.y };
  }, { fw: FRAME_HALF_W, fh: FRAME_HALF_H });
}

/** Lock swarm entity `eid` with weapon group `group`, as a player does: tap
 *  the group's chip on the HUD weapon strip (it becomes the active group),
 *  select the target and press LOCK (the info box's action). */
async function lockWith(ctx: ShotContext, group: string, eid: number): Promise<void> {
  await ctx.page.getByTestId(`fc-chip-${group}`).click();
  await ctx.page.evaluate((id) => {
    const w = window as unknown as {
      __eqxStore?: { getState(): { setSelection(ids: readonly string[], id: string | null, kind: string | null): void } };
      __eqxClient?: { lockSelected?: () => boolean };
    };
    w.__eqxStore?.getState().setSelection([], `swarm-${id}`, 'asteroid');
    w.__eqxClient?.lockSelected?.();
  }, eid);
}

async function step(ctx: ShotContext): Promise<void> {
  const b = await beat(ctx);
  if (!b) return;
  if (b.tractor !== null) await lockWith(ctx, TRACTOR, b.tractor);
  if (b.laser !== null) await lockWith(ctx, LASER, b.laser);
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
 * Salvage stream: the mining barge works a rock field. The pilot flies the
 * barge (`showcase-barge-mining`: eight placed rocks of mixed sizes in a loose
 * ring round it, nothing else in the sector). On the HUD weapon strip the
 * pilot taps "Mining lasers" and locks the nearest rock; the side lasers burn
 * it until it breaks along the beams into pieces, then lock the pieces in
 * turn until the last small ones become ore pods. Each pod is locked with the
 * "Tractors" group, which pulls it in to the hull where it goes into the hold.
 * Every lock is a real lock (fire is lock-gated, #19; `instantLock` only
 * skips the lock timer, as in the other salvage takes); both groups stay in
 * AUTO, so each fires at its own lock. The camera is the game's follow camera
 * at the barge's closest zoom (the whole hull fits, the game's own cap).
 */
export const bargeMining: Shot = {
  id: 'barge-mining',
  section: 'mechanics',
  title: 'The mining barge works a rock field',
  caption: 'Mining lasers slice a rock into pieces, then into ore pods; the tractors pull the pods into the hold.',
  features: ['CAP'],
  docs: ['mining-and-salvage'],
  reel: false,
  server: 'lean',
  target: { room: 'showcase-barge-mining', params: { shipKind: 'barge', instantLock: 1, art: 'machined', fx: 'new', initialHull: 1_000_000 } },
  durationMs: 55_000,
  async startWhen(ctx) {
    await ctx.page.waitForFunction(() => {
      let n = 0;
      (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient?.mirror.swarm.forEach((e) => { if (e.kind === 0) n++; });
      return n >= 8;
    }, null, { timeout: 60_000, polling: 250 });
    await zoomToCap(ctx);
    // Lock the first rock and wait (<= 20 s) for the side lasers to train on
    // it and open up.
    await step(ctx);
    for (let t = 0; t < 20_000; t += 500) {
      const firing = await ctx.page.evaluate(() =>
        ((globalThis as { __eqxClient?: { mirror: { liveBeams?: Map<string, unknown> } } }).__eqxClient?.mirror.liveBeams?.size ?? 0) > 0);
      if (firing) break;
      await ctx.sleep(500);
    }
  },
  async run(ctx) {
    for (let t = 0; t < 54_500; t += 500) {
      await step(ctx);
      await ctx.sleep(500);
    }
  },
};
