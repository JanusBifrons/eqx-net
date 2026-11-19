import type { Shot } from '../types.js';
import { touch } from '../touch.js';
import { artSettled } from './capitals.js';

/**
 * Autopilot (navigation slice 17; docs/features/autopilot.md): on a phone held
 * sideways, the pilot pinches out and taps open space on the far side of a
 * rock at the cut field's eastern rim (seed `look`, the rock of
 * `tests/e2e/autopilot-round-rock.spec.ts`). The helm asks the server for a
 * route, its line shows round the rock, and the fighter flies it.
 *
 * Start and goal (from the planner on seed `look`, fighter clearance and
 * comfort): the straight line between them clips the rim rock's tip; the route
 * bends east round it (corner near (-6664, 11960)). Both sit inside one phone
 * screen at the fighter's widest zoom (±2 800 × ±1 300 u), and the goal lies down
 * and right of the ship, clear of the bottom-centre HUD pill, so the tap is a
 * real tap on the drawn goal in open space.
 */
const S = { x: -7_350, y: 12_500 };
const G = { x: -6_514, y: 11_504 };
/** Nose toward the goal: forward is (-sin θ, cos θ). */
const FACING = Math.round(Math.atan2(-(G.x - S.x), G.y - S.y) * 1000) / 1000;

export const autopilotRoundRock: Shot = {
  id: 'autopilot-round-rock',
  section: 'mechanics',
  title: 'Autopilot round the rock',
  caption: 'Tap past the rock: the route bends round it and the ship flies it.',
  features: ['NAV'],
  docs: ['autopilot'],
  reel: false,
  server: 'lean',
  viewport: 'phone-landscape',
  target: {
    room: 'showcase-cut-field',
    params: { shipKind: 'fighter', art: 'machined', fx: 'new', spawnX: S.x, spawnY: S.y, initialAngle: FACING, initialHull: 1_000_000 },
  },
  hud: 'full',
  durationMs: 16_000,
  async startWhen(ctx) {
    await artSettled(ctx);
  },
  async run(ctx) {
    const pad = await touch(ctx.page, ctx.log);
    const { width: w, height: h } = ctx.viewport;
    await ctx.sleep(1500);
    // Pinch out (fingers together) to the fighter's widest view: the rock and the far side in frame.
    for (let i = 0; i < 3; i++) {
      const a = pad.finger(), b = pad.finger();
      await a.down(w / 2 - w * 0.3, h / 2); await b.down(w / 2 + w * 0.3, h / 2);
      await Promise.all([a.dragTo(w / 2 - w * 0.05, h / 2, { ms: 700 }), b.dragTo(w / 2 + w * 0.05, h / 2, { ms: 700 })]);
      await a.up(); await b.up();
      await ctx.sleep(250);
    }
    await ctx.sleep(1500);
    // A real tap where the goal is drawn (open space past the rock).
    for (let i = 0; i < 5; i++) {
      const p = await ctx.page.evaluate(([x, y]) =>
        (window as unknown as { __eqxWorldToScreen?: (x: number, y: number) => { x: number; y: number } }).__eqxWorldToScreen?.(x!, y!) ?? { x: NaN, y: NaN },
      [G.x, G.y] as const);
      if (!Number.isFinite(p.x) || p.x < 0 || p.y < 0 || p.x > w || p.y > h) throw new Error(`goal not on screen: ${JSON.stringify(p)}`);
      await pad.finger().tap(p.x, p.y);
      const on = await ctx.page.evaluate(() => (globalThis as { __eqxStore?: { getState(): { helmActive?: boolean } } }).__eqxStore?.getState().helmActive === true);
      if (on) break;
      await ctx.sleep(300);
    }
    // The route comes back and the helm flies it (~1.35 km, about 7 s), then holds on the goal.
    await ctx.sleep(8_000);
    await pad.dispose();
  },
};

/**
 * A battleship on autopilot down a cut-field lane (navigation: width on
 * straights; docs/architecture/navigation.md). Seed `look`, lane 0, 0.6 R in
 * from the rim (deep enough for dense walls): the lane is ~3 400 u of room each side of its centre line,
 * less than the battleship's length clearance (3 595) but far more than its
 * beam (1 067). Planned as a disc of its length the ship found no way at all;
 * planned by its width on the straight it gets the lane, and flies it.
 * Start and goal are on the lane centre line, 8 km apart, nose down the lane.
 */
const BS_S = { x: -31_484, y: -86_415 };
const BS_G = { x: -27_256, y: -79_624 };
const BS_FACING = Math.round(Math.atan2(-(BS_G.x - BS_S.x), BS_G.y - BS_S.y) * 1000) / 1000;

export const autopilotCapitalLane: Shot = {
  id: 'autopilot-capital-lane',
  section: 'mechanics',
  title: 'Battleship down a lane',
  caption: 'A battleship taps a point down a rock-field lane: the route runs straight down it.',
  features: ['NAV'],
  docs: ['autopilot'],
  reel: false,
  server: 'lean',
  viewport: 'phone-landscape',
  target: {
    room: 'showcase-cut-field',
    params: { shipKind: 'battleship', art: 'machined', fx: 'new', spawnX: BS_S.x, spawnY: BS_S.y, initialAngle: BS_FACING, initialHull: 1_000_000 },
  },
  hud: 'full',
  durationMs: 66_000,
  maxBitrateKbps: 3_000,
  async startWhen(ctx) {
    await artSettled(ctx);
  },
  async run(ctx) {
    const pad = await touch(ctx.page, ctx.log);
    const { width: w, height: h } = ctx.viewport;
    await ctx.sleep(800);
    // A gentle pinch out (about 2×): the hull still reads, both lane walls and the goal in frame.
    for (let i = 0; i < 1; i++) {
      const a = pad.finger(), b = pad.finger();
      await a.down(w / 2 - w * 0.3, h / 2); await b.down(w / 2 + w * 0.3, h / 2);
      await Promise.all([a.dragTo(w / 2 - w * 0.15, h / 2, { ms: 700 }), b.dragTo(w / 2 + w * 0.15, h / 2, { ms: 700 })]);
      await a.up(); await b.up();
      await ctx.sleep(250);
    }
    await ctx.sleep(500);
    // A real tap on the goal; if 8 km is past the screen edge, tap the farthest on-screen point on the centre line.
    for (let i = 0; i < 5; i++) {
      const p = await ctx.page.evaluate(([sx, sy, gx, gy, W, H]) => {
        const f = (window as unknown as { __eqxWorldToScreen?: (x: number, y: number) => { x: number; y: number } }).__eqxWorldToScreen;
        if (!f) return { x: NaN, y: NaN };
        for (let k = 1; k >= 0.3; k -= 0.05) {
          const q = f(sx! + (gx! - sx!) * k, sy! + (gy! - sy!) * k);
          if (q.x > W! * 0.06 && q.y > H! * 0.06 && q.x < W! * 0.94 && q.y < H! * 0.94) return q;
        }
        return { x: NaN, y: NaN };
      }, [BS_S.x, BS_S.y, BS_G.x, BS_G.y, w, h] as const);
      if (!Number.isFinite(p.x)) throw new Error('lane goal not on screen');
      ctx.log(`tap goal at ${Math.round(p.x)},${Math.round(p.y)}`);
      await pad.finger().tap(p.x, p.y);
      const on = await ctx.page.evaluate(() => (globalThis as { __eqxStore?: { getState(): { helmActive?: boolean } } }).__eqxStore?.getState().helmActive === true);
      if (on) break;
      await ctx.sleep(300);
    }
    // 8 km at battleship cruise (~160 u/s) plus spool-up and the stop: it settles on the goal ~58 s in.
    await ctx.sleep(57_000);
    await pad.dispose();
  },
};
