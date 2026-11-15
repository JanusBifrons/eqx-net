import type { Shot, ShotContext } from '../types.js';
import { sendRoom } from './_helpers.js';

/**
 * Keep working one piece the way a player does: while the locked wreck piece
 * (kind 4) is there, leave the lock alone; when it is gone (it split, or wore
 * down to salvage), lock the piece of ITS wreck family (the cut children,
 * `mirror.wrecks` parent links) nearest where it was, else the nearest piece
 * to that point. The first lock takes the piece nearest the pilot. Each lock
 * is the info box's LOCK with the ACTIVE weapon group only (the main battery,
 * picked on the HUD weapon strip in setup; a neutral terrain lock), so only
 * the heavy beams fire on it; the secondaries and AA hold no lock and stay
 * quiet (AUTO picks only hostiles). Returns whether a piece is locked.
 */
async function keepWorkingPiece(ctx: ShotContext): Promise<boolean> {
  return ctx.page.evaluate(() => {
    type Piece = { kind: number; x: number; y: number; wreckId?: number };
    const w = window as unknown as {
      __eqxStore?: { getState(): { setSelectedEntity(id: string | null, kind: string | null): void } };
      __eqxClient?: {
        lockSelected?: () => boolean;
        mirror?: {
          localPlayerId: string | null;
          ships: Map<string, { x: number; y: number }>;
          swarm: Map<number, Piece>;
          wrecks?: Map<number, { parentWreck?: number }>;
        };
      };
      __eqxShotWork?: { eid: number; x: number; y: number; wreckId: number };
    };
    const m = w.__eqxClient?.mirror;
    const me = m?.localPlayerId ? m.ships.get(m.localPlayerId) : undefined;
    const st = w.__eqxStore?.getState();
    if (!m || !me || !st) return false;
    const work = w.__eqxShotWork;
    const cur = work !== undefined ? m.swarm.get(work.eid) : undefined;
    if (work !== undefined && cur !== undefined && cur.kind === 4) {
      work.x = cur.x;
      work.y = cur.y;
      return true;
    }
    const ox = work?.x ?? me.x;
    const oy = work?.y ?? me.y;
    let best: number | null = null, bestD = Infinity, bestFam = false;
    for (const [eid, e] of m.swarm) {
      if (e.kind !== 4) continue;
      // Is this piece's wreck the worked wreck or cut from it (its parent
      // chain)? Inline, not a named helper: tsx wraps named functions in a
      // `__name` call the page doesn't define (docs/LESSONS.md, probe gotchas).
      let fam = false;
      for (let k = e.wreckId, n = 0; k !== undefined && n < 32; n++) {
        if (work !== undefined && k === work.wreckId) { fam = true; break; }
        k = m.wrecks?.get(k)?.parentWreck;
      }
      const d = Math.hypot(e.x - ox, e.y - oy);
      if ((fam && !bestFam) || (fam === bestFam && d < bestD)) { bestD = d; best = eid; bestFam = fam; }
    }
    if (best === null) return false;
    const p = m.swarm.get(best)!;
    w.__eqxShotWork = { eid: best, x: p.x, y: p.y, wreckId: p.wreckId ?? -1 };
    st.setSelectedEntity(`swarm-${best}`, 'wreck');
    w.__eqxClient?.lockSelected?.();
    return true;
  });
}

/**
 * Salvage stream PR 5/6: wreck pieces wear down under fire, split again where
 * they are hit, and the last small pieces turn into salvage pods. The pilot
 * flies a lance battlecruiser (heavy-beam main battery) off a battleship's
 * beam in `wreck-test`; one setup cue kills the battleship
 * (`test_kill_capitals`). The pilot picks the main battery on the HUD weapon
 * strip and locks the nearest piece with it in setup, and the
 * take starts once the main battery's turrets have trained on it (they
 * traverse slowly: ~15 s for the quarter turn to the beam). During the take
 * the pilot keeps working that piece and, as it splits, the cut children
 * (ordinary weapons wear a wreck at a tenth of their damage; the mining
 * laser, on no ship yet, at full, so the take never reaches salvage). No cue
 * during the take.
 */
export const wreckResplit: Shot = {
  id: 'wreck-resplit',
  section: 'mechanics',
  title: 'Cutting up a wreck',
  caption: 'Heavy beams wear a battleship wreck down: each piece splits again along the beam, and the last scraps become salvage pods.',
  features: ['CAP'],
  docs: ['mining-and-salvage'],
  reel: false,
  server: 'lean',
  target: { room: 'wreck-test', params: { shipKind: 'battlecruiser-lance', instantLock: 1, art: 'machined', fx: 'new', spawnX: 5500, spawnY: 2500 } },
  // The pilot flies, so the take films the game's own follow camera (no
  // `camera` script: a pan needs spectator mode, showcase-pipeline.md, and a
  // spectator's parked hull doesn't fire). The follow camera keeps our ship
  // centred, so the closest view of the pieces is the zoom-in cap.
  durationMs: 60_000,
  async startWhen(ctx) {
    await ctx.page.waitForFunction(() => {
      let n = 0;
      (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient?.mirror.swarm.forEach((e) => { if (e.kind === 1) n++; });
      return n > 0;
    }, null, { timeout: 60_000, polling: 250 });
    // Zoom in with the mouse wheel, as a player would, to the game's zoom-in
    // cap (the whole hull just fits: ~0.13 for this battlecruiser in a 720 px
    // tall view), so the pieces off the beam read large. Owner (2026-11-15):
    // "It's too zoomed out".
    const c = ctx.px(640, 360);
    await ctx.page.mouse.move(c.x, c.y);
    for (let i = 0; i < 15; i++) {
      await ctx.page.mouse.wheel(0, -100);
      await ctx.sleep(120);
    }
    // Pick the main battery (heavy beams) on the HUD weapon strip, as a player
    // taps a group chip; the locks below go to it alone, so the 5" secondaries
    // never fire. Owner (2026-11-15): "the 5 inch guns are firing, which
    // muddies the water".
    await ctx.page.getByTestId('fc-chip-main').click();
    await sendRoom(ctx, 'test_kill_capitals', { type: 'test_kill_capitals' });
    await ctx.sleep(2500); // the hull cracks and parts
    // Lock a piece and wait (≤ 30 s) until the main battery's beams are on it.
    for (let t = 0; t < 30_000; t += 500) {
      await keepWorkingPiece(ctx);
      const firing = await ctx.page.evaluate(() =>
        ((globalThis as { __eqxClient?: { mirror: { liveBeams?: Map<string, unknown> } } }).__eqxClient?.mirror.liveBeams?.size ?? 0) > 0);
      if (firing) break;
      await ctx.sleep(500);
    }
  },
  async run(ctx) {
    for (let t = 0; t < 59_500; t += 500) {
      await keepWorkingPiece(ctx);
      await ctx.sleep(500);
    }
  },
};
