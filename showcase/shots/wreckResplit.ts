import type { Shot, ShotContext } from '../types.js';
import { sendRoom } from './_helpers.js';
import { getShipKind } from '../../src/shared-types/shipKinds.js';
import { zoomCeilingForView, zoomFloorForView } from '../../src/shared-types/shipScale/tuning.js';

/** Where the locked piece sits relative to our ship (world u), or null. */
type Offset = { dx: number; dy: number } | null;

/**
 * Keep working one piece the way a player does: while the locked wreck piece
 * (kind 4) is there, leave the lock alone; when it is gone (it split, or wore
 * down to salvage), lock the piece NEAREST OUR SHIP (the one in frame), never
 * a far one. Each lock is the info box's LOCK with the ACTIVE weapon group
 * only (the main battery, picked on the HUD weapon strip in setup; a neutral
 * terrain lock), so only the heavy beams fire on it; the secondaries and AA
 * hold no lock and stay quiet (AUTO picks only hostiles). Returns the locked
 * piece's offset from our ship, or null.
 */
async function keepWorkingPiece(ctx: ShotContext): Promise<Offset> {
  return ctx.page.evaluate(() => {
    type Piece = { kind: number; x: number; y: number };
    const w = window as unknown as {
      __eqxStore?: { getState(): { setSelectedEntity(id: string | null, kind: string | null): void } };
      __eqxClient?: {
        lockSelected?: () => boolean;
        mirror?: {
          localPlayerId: string | null;
          ships: Map<string, { x: number; y: number }>;
          swarm: Map<number, Piece>;
        };
      };
      __eqxShotWork?: number;
    };
    const m = w.__eqxClient?.mirror;
    const me = m?.localPlayerId ? m.ships.get(m.localPlayerId) : undefined;
    const st = w.__eqxStore?.getState();
    if (!m || !me || !st) return null;
    const work = w.__eqxShotWork;
    const cur = work !== undefined ? m.swarm.get(work) : undefined;
    if (cur !== undefined && cur.kind === 4) return { dx: cur.x - me.x, dy: cur.y - me.y };
    let best: number | null = null, bestD = Infinity;
    for (const [eid, e] of m.swarm) {
      if (e.kind !== 4) continue;
      const d = Math.hypot(e.x - me.x, e.y - me.y);
      if (d < bestD) { bestD = d; best = eid; }
    }
    if (best === null) return null;
    const p = m.swarm.get(best)!;
    w.__eqxShotWork = best;
    st.setSelectedEntity(`swarm-${best}`, 'wreck');
    w.__eqxClient?.lockSelected?.();
    return { dx: p.x - me.x, dy: p.y - me.y };
  });
}

/** World u kept in frame round a piece's centre (about a big piece's half-length). */
const PIECE_EXTENT = 700;
/** Screen px kept clear between the piece and the frame edge. */
const FRAME_MARGIN_PX = 90;

/**
 * The pilot's mouse-wheel zoom, tracked shot-side. The follow camera keeps our
 * ship centred, so the tightest zoom that still shows the locked piece follows
 * from its offset. Each wheel notch steps the camera's target scale ×1.1 in /
 * ×0.9 out (`wheelZoomFactor`), between the game's floor and cap for this hull
 * and viewport (`zoomFloorForView` / `zoomCeilingForView`).
 */
type Zoom = { scale: number; floor: number; cap: number; halfW: number; halfH: number };

/** Wheel in to the cap from wherever the camera starts (a known state). */
async function zoomToCap(ctx: ShotContext): Promise<Zoom> {
  const view = await ctx.page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const lance = getShipKind('battlecruiser-lance');
  const floor = zoomFloorForView(lance, view.w, view.h);
  const cap = zoomCeilingForView(lance, view.w, view.h, floor);
  const c = ctx.px(960, 540);
  await ctx.page.mouse.move(c.x, c.y);
  for (let i = 0; i < 30; i++) {
    await ctx.page.mouse.wheel(0, -100);
    await ctx.sleep(40);
  }
  return { scale: cap, floor, cap, halfW: view.w / 2, halfH: view.h / 2 };
}

/** Wheel out until the piece at `off` fits the frame with a margin; wheel back
 *  in (with slack, so it doesn't hunt) when it would still fit a notch closer. */
async function frameOn(ctx: ShotContext, z: Zoom, off: Offset): Promise<void> {
  if (off === null) return;
  const want = Math.min(
    (z.halfW - FRAME_MARGIN_PX) / (Math.abs(off.dx) + PIECE_EXTENT),
    (z.halfH - FRAME_MARGIN_PX) / (Math.abs(off.dy) + PIECE_EXTENT),
  );
  while (z.scale > want && z.scale * 0.9 >= z.floor) {
    await ctx.page.mouse.wheel(0, 100);
    z.scale *= 0.9;
    await ctx.sleep(40);
  }
  while (z.scale * 1.1 * 1.15 <= want && z.scale * 1.1 <= z.cap) {
    await ctx.page.mouse.wheel(0, -100);
    z.scale *= 1.1;
    await ctx.sleep(40);
  }
}

/** This take's wheel zoom (set in `startWhen`, read in `run`). */
let zoom: Zoom | null = null;

/**
 * Salvage stream PR 5/6: wreck pieces wear down under fire, split again where
 * they are hit, and the last small pieces turn into salvage pods. The pilot
 * flies a lance battlecruiser (heavy-beam main battery) off a battleship's
 * beam in `wreck-test` (spawned ~3.5 km abeam, so the pieces stay close); one
 * setup cue kills the battleship (`test_kill_capitals`). The pilot picks the
 * main battery on the HUD weapon strip, locks the piece nearest the ship and
 * zooms in with the wheel as far as keeps that piece in frame; the take starts
 * once the main battery's turrets have trained on it (they traverse slowly:
 * ~15 s for the quarter turn to the beam). During the take the pilot keeps
 * working that piece and, when it is gone, the next nearest, re-framing with
 * the wheel (ordinary weapons wear a wreck at a tenth of their damage; the
 * mining laser, on no ship yet, at full, so the take never reaches salvage).
 * No cue during the take.
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
  target: { room: 'wreck-test', params: { shipKind: 'battlecruiser-lance', instantLock: 1, art: 'machined', fx: 'new', spawnX: 3500, spawnY: 2500 } },
  // The pilot flies, so the take films the game's own follow camera (no
  // `camera` script: a pan needs spectator mode, showcase-pipeline.md, and a
  // spectator's parked hull doesn't fire). The follow camera keeps our ship
  // centred, so the zoom is as close as keeps the worked piece in frame (our
  // ship may sit at the frame's edge). Owner (2026-11-15): "It's too zoomed
  // out", and then: he must SEE the piece being worked.
  durationMs: 60_000,
  async startWhen(ctx) {
    await ctx.page.waitForFunction(() => {
      let n = 0;
      (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient?.mirror.swarm.forEach((e) => { if (e.kind === 1) n++; });
      return n > 0;
    }, null, { timeout: 60_000, polling: 250 });
    // Pick the main battery (heavy beams) on the HUD weapon strip, as a player
    // taps a group chip; the locks below go to it alone, so the 5" secondaries
    // never fire. Owner (2026-11-15): "the 5 inch guns are firing, which
    // muddies the water".
    await ctx.page.getByTestId('fc-chip-main').click();
    await sendRoom(ctx, 'test_kill_capitals', { type: 'test_kill_capitals' });
    await ctx.sleep(2500); // the hull cracks and parts
    // Lock the nearest piece, zoom in with the mouse wheel as a player would
    // (to the cap, then out as far as the piece needs), and wait (≤ 30 s)
    // until the main battery's beams are on it.
    zoom = await zoomToCap(ctx);
    for (let t = 0; t < 30_000; t += 500) {
      await frameOn(ctx, zoom, await keepWorkingPiece(ctx));
      const firing = await ctx.page.evaluate(() =>
        ((globalThis as { __eqxClient?: { mirror: { liveBeams?: Map<string, unknown> } } }).__eqxClient?.mirror.liveBeams?.size ?? 0) > 0);
      if (firing) break;
      await ctx.sleep(500);
    }
  },
  async run(ctx) {
    for (let t = 0; t < 59_500; t += 500) {
      const off = await keepWorkingPiece(ctx);
      if (zoom) await frameOn(ctx, zoom, off);
      await ctx.sleep(500);
    }
  },
};
