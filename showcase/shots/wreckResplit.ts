import type { Shot, ShotContext } from '../types.js';
import { sendRoom } from './_helpers.js';

/**
 * Lock the wreck piece (kind 4) nearest the pilot with every weapon group,
 * the same as the info box's LOCK (a neutral terrain lock). A capital's AUTO
 * groups then fire on it turret by turret.
 */
async function lockNearestWreck(ctx: ShotContext): Promise<void> {
  await ctx.page.evaluate(() => {
    const w = window as unknown as {
      __eqxStore?: { getState(): { fcGroups: ReadonlyArray<{ id: string }>; setSelectedEntity(id: string | null, kind: string | null): void; setActiveGroupId(id: string): void } };
      __eqxClient?: {
        lockSelected?: () => boolean;
        mirror?: { localPlayerId: string | null; ships: Map<string, { x: number; y: number }>; swarm: Map<number, { kind: number; x: number; y: number }> };
      };
    };
    const m = w.__eqxClient?.mirror;
    const me = m?.localPlayerId ? m.ships.get(m.localPlayerId) : undefined;
    const st = w.__eqxStore?.getState();
    if (!m || !me || !st) return;
    let best: number | null = null, bestD = Infinity;
    for (const [eid, e] of m.swarm) {
      if (e.kind !== 4) continue;
      const d = Math.hypot(e.x - me.x, e.y - me.y);
      if (d < bestD) { bestD = d; best = eid; }
    }
    if (best === null) return;
    for (const g of st.fcGroups) {
      st.setActiveGroupId(g.id);
      st.setSelectedEntity(`swarm-${best}`, 'wreck');
      w.__eqxClient?.lockSelected?.();
    }
  });
}

/**
 * Salvage stream PR 5/6: wreck pieces wear down under fire, split again where
 * they are hit, and the last small pieces turn into salvage pods. The pilot
 * flies a lance battlecruiser (heavy-beam main battery) off a battleship's
 * beam in `wreck-test`; one setup cue kills the battleship
 * (`test_kill_capitals`). During the take the pilot keeps locking the
 * nearest piece and the beams cut it up (ordinary weapons wear a wreck at a
 * tenth of their damage; the mining laser, on no ship yet, at full). No cue
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
  target: { room: 'wreck-test', params: { shipKind: 'battlecruiser-lance', initialHull: 1_000_000, instantLock: 1, noselfdmg: 1, art: 'machined', fx: 'new', spawnX: 5500, spawnY: 2500 } },
  // The pilot flies, so the take films the game's own follow camera (no
  // `camera` script: a pan needs spectator mode, showcase-pipeline.md).
  durationMs: 30_000,
  async startWhen(ctx) {
    await ctx.page.waitForFunction(() => {
      let n = 0;
      (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient?.mirror.swarm.forEach((e) => { if (e.kind === 1) n++; });
      return n > 0;
    }, null, { timeout: 60_000, polling: 250 });
    // Pull back with the mouse wheel, as a player would, until the battleship
    // off the beam is in frame with our own ship.
    const c = ctx.px(640, 360);
    await ctx.page.mouse.move(c.x, c.y);
    for (let i = 0; i < 5; i++) {
      await ctx.page.mouse.wheel(0, 100);
      await ctx.sleep(120);
    }
    await sendRoom(ctx, 'test_kill_capitals', { type: 'test_kill_capitals' });
    await ctx.sleep(2500); // the hull cracks and parts
  },
  async run(ctx) {
    for (let t = 0; t < 29_000; t += 1000) {
      await lockNearestWreck(ctx);
      await ctx.sleep(1000);
    }
  },
};
