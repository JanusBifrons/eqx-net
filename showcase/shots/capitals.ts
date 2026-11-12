import type { Shot } from '../types.js';
import { sendRoom } from './_helpers.js';
import { targetUrl } from '../recorder.js';
import { startZoomForScale } from '../../src/shared-types/shipScale/tuning.js';
import { getShipKind } from '../../src/shared-types/shipKinds.js';
import { localPose, flyTo } from './_pilot.js';
import type { ShotContext } from '../types.js';

/** Steer through waypoints with W / A / D (the flight shot's keys): turn
 *  toward the next point, thrust when roughly facing it, pass within `arrive`.
 *  Game space, y up; angle 0 = facing +y. */
async function steerRoute(ctx: ShotContext, pts: ReadonlyArray<[number, number]>, arrive = 160, legMs = 5000, onArrive?: (i: number) => Promise<void>): Promise<void> {
  const held = new Set<string>();
  const set = async (k: string, on: boolean): Promise<void> => {
    if (on && !held.has(k)) { await ctx.page.keyboard.down(k); held.add(k); }
    if (!on && held.has(k)) { await ctx.page.keyboard.up(k); held.delete(k); }
  };
  for (let i = 0; i < pts.length; i++) {
    const [tx, ty] = pts[i]!;
    const end = Date.now() + legMs;
    while (Date.now() < end) {
      const p = await localPose(ctx);
      if (p) {
        const dx = tx - p.x, dy = ty - p.y;
        if (Math.hypot(dx, dy) < arrive) break;
        let diff = Math.atan2(-dx, dy) - p.angle;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        await set('a', diff > 0.1);
        await set('d', diff < -0.1);
        await set('w', Math.abs(diff) < 0.7);
      }
      await ctx.sleep(40);
    }
    if (onArrive) await onArrive(i);
  }
  for (const k of [...held]) await set(k, false);
}

/** Centre-to-centre spacing of the showcase-capitals line-up (mirrors
 *  `capitalLineup` in src/server/rooms/showcaseRooms.ts). */
function fleetGap(): number {
  let gap = 0;
  for (const id of ['destroyer', 'light-cruiser', 'heavy-cruiser', 'battlecruiser', 'battleship']) {
    const hull = (getShipKind(id).shape as { hull?: ReadonlyArray<readonly [number, number]> }).hull ?? [];
    let w = 10;
    for (const [x] of hull) w = Math.max(w, Math.abs(x));
    gap = Math.max(gap, 2 * w * 2.6);
  }
  return gap;
}

/** The renderer's gameplay start zoom before ship-scale correction
 *  (`DEFAULT_GAMEPLAY_ZOOM` in PixiRenderer.ts). */
const GAMEPLAY_START_ZOOM = 0.5;
/** The fly-by camera. The game's 2Ã— start zoom (startZoomForScale â†’ 0.35)
 *  read as "very zoomed out" (user, 2026-11-05); 1.0 keeps the fighter
 *  ~50 px and a battleship about half the screen. */
const FLYBY_ZOOM = 1.0;
void startZoomForScale; void GAMEPLAY_START_ZOOM;

/**
 * Capital-ship R&D (plan eager-sauteeing-curry), filmed per arm with
 * EQX_CAPITAL_STYLE (A|B|C) and EQX_CAPITAL_MAP (A|B): the five WW2-grounded
 * capitals beside a fighter and a base core. The camera frames the whole
 * fleet, so the shot fits either size mapping. Not in the reel until a style
 * is picked.
 */
export const capitalLineup: Shot = {
  id: 'capital-lineup',
  section: 'mechanics',
  title: 'Capital line-up',
  caption: 'Destroyer, light cruiser, heavy cruiser, battlecruiser and battleship, sized from their WW2 counterparts, beside a fighter and a base.',
  features: ['CAP'],
  docs: ['ship-kinds'],
  reel: false,
  server: 'capitals',
  target: { room: 'showcase-capitals', params: { sectorScale: '4', shipKind: 'fighter', art: 'machined', fx: 'new' } },
  hud: 'none',
  durationMs: 14_000,
  async startWhen(ctx) {
    await artSettled(ctx);
    // A framed camera needs a free camera: watch as a spectator (record as is).
    await ctx.spectate();
  },
  // Owner (2026-11-12): "The shot should start from a fighter and zoom out."
  // Open close on the pilot's own parked fighter at normal fighter zoom, hold,
  // then pull slowly back until the whole line-up and the base are in frame.
  // smoothMs is the camera spring's time constant, not the move's length: the
  // move takes ~2.4x it. 9000 was still a quarter short when the take ended
  // (hulls cropped, read as a zoom in; review 2026-11-12). 3500 lands it ~10 s
  // in and holds on the whole fleet. Lock: showcase/cameraSettles.test.ts.
  camera: [
    { atMs: 0, smoothMs: 0, shot: { kind: 'track', target: 'local', zoom: 1.0 } },
    { atMs: 2000, smoothMs: 3500, shot: { kind: 'frame', group: 'all', padding: 0.2, maxZoom: 3 } },
  ],
};

/** The same fleet turned hostile: hulls ramp into their turns, turrets
 *  track and fire by size. */
export const capitalBroadside: Shot = {
  id: 'capital-broadside',
  section: 'mechanics',
  title: 'Capital broadside',
  caption: 'Big hulls take their time to turn; the main batteries swing slowly and hit hard, the secondaries track fast.',
  features: ['CAP'],
  docs: ['ship-kinds'],
  reel: false,
  server: 'capitals',
  // The fight starts on cue (test_aggro) once the art has baked, not at join.
  target: { room: 'showcase-capitals-combat', params: { sectorScale: '4', shipKind: 'heavy-cruiser', art: 'machined', fx: 'new', initialHull: 1_000_000, noselfdmg: 1 } },
  hud: 'none',
  durationMs: 14_000,
  async startWhen(ctx) {
    await artSettled(ctx);
    // A framed camera needs a free camera: watch as a spectator (record as is).
    await ctx.spectate();
  },
  camera: [{ atMs: 0, smoothMs: 0, shot: { kind: 'frame', group: 'all', padding: 0.2, maxZoom: 2.5 } }],
  async run(ctx) {
    await sendRoom(ctx, 'test_aggro', { type: 'test_aggro' });
    await ctx.sleep(13_500);
  },
};

/** Wait until no ship / structure art is still baking (a 10x battleship
 *  takes ~15 s), so the take never shows the vector stand-in. */
export async function artSettled(ctx: ShotContext): Promise<void> {
  await ctx.page.waitForFunction(() => {
    const st = (globalThis as { __eqxArtStats?: () => { pending?: number; ready?: number } }).__eqxArtStats?.();
    return !!st && (st.ready ?? 0) > 0 && (st.pending ?? 1) === 0;
  }, null, { timeout: 120_000, polling: 500 });
}

/**
 * The feel shot, to the user's shot list (2026-11-05, round 3): "a fighter
 * flying through space and then the huge ship coming into view, then it turns
 * 90 degrees to fly alongside it, then after a bit it zooms out, then the
 * focus shifts to the capital and the entire view transitions to recenter on
 * it and slowly pans out to show the scale."
 *
 * The fighter starts east of the battleship (the last of the line-up, nose
 * +y), flies west at zoom 1 until the hull fills the left of the frame, turns
 * north and runs along the hull's starboard side. The camera cues fire on the
 * fighter's real position (not a clock), so a slow take still lines up.
 */
export const capitalFlyby: Shot = {
  id: 'capital-flyby',
  section: 'mechanics',
  title: 'Capital fly-by',
  caption: 'A fighter meets a battleship 110 fighters long, runs down its side, and the camera pulls back to show the scale.',
  features: ['CAP'],
  docs: ['ship-kinds'],
  reel: false,
  server: 'capitals',
  target: { room: 'showcase-capitals', params: { sectorScale: '4', shipKind: 'fighter', art: 'machined', fx: 'new', spawnX: Math.round(2 * fleetGap() + 2600), spawnY: -1600, initialHull: 1_000_000 } },
  hud: 'none',
  durationMs: 35_000,
  camera: [{ atMs: 0, smoothMs: 0, shot: { kind: 'track', target: 'local', zoom: FLYBY_ZOOM, leadMs: 250 } }],
  async startWhen(ctx) {
    await artSettled(ctx);
  },
  async run(ctx) {
    const bsX = 2 * fleetGap();
    // The turn point sits close to the hull: the fighter skids wide through a
    // 90Â° turn at speed, ending ~400 u off the starboard side.
    const side = bsX + 650;
    const bow = getShipKind('battleship').radius;
    const k = ctx.viewport.width / 1920;
    await steerRoute(ctx, [
      [side, -1600], // west, until the hull fills the left of the frame; then the 90Â° turn
      [side, -200], // a few seconds alongside
      [side, bow + 9000], // and away, while the camera pulls back
    ], 160, 12_000, async (i) => {
      if (i === 0) {
        // "after a bit it zooms out" (not awaited: the fighter keeps flying)
        void ctx.sleep(3000).then(() => ctx.cinema.play([{ atMs: 0, smoothMs: 2500, shot: { kind: 'track', target: 'local', zoom: 0.4 * k, leadMs: 250 } }]));
      }
      if (i === 1) {
        // "the focus shifts to the capital ... recenter on it and slowly pans out"
        await ctx.cinema.play([{ atMs: 0, smoothMs: 2500, shot: { kind: 'path', keys: [
          { t: 0, x: bsX, y: 0, zoom: 0.4 * k },
          { t: 2500, x: bsX, y: 0, zoom: 0.4 * k },
          { t: 14_000, x: bsX, y: 0, zoom: 0.15 * k },
        ] } }]);
      }
    });
  },
};

/**
 * Round 3 D/E: fly the battleship. The pilot taps a course (helm orders), the
 * hull swings onto it under its own slow torque, then the camera pulls right
 * back to the capital pilot's zoom floor: the fleet in view, the parked
 * fighter wing as dots. Then back in.
 */
export const capitalPilot: Shot = {
  id: 'capital-pilot',
  section: 'mechanics',
  title: 'Flying a capital',
  caption: 'Tap a course and the battleship steers itself onto it; pull back and the fighters around it are specks.',
  features: ['CAP'],
  docs: ['ship-kinds'],
  reel: false,
  server: 'capitals',
  target: { room: 'showcase-capitals', params: { sectorScale: '4', shipKind: 'battleship', art: 'machined', fx: 'new', spawnX: 0, spawnY: -9000, initialHull: 1_000_000 } },
  hud: 'minimal',
  durationMs: 26_000,
  // The game's follow camera; the pilot zooms with the mouse wheel (record as is).
  async startWhen(ctx) {
    await artSettled(ctx);
  },
  async run(ctx) {
    await ctx.sleep(1500);
    // A real tap on empty space up and to the right: the helm takes the course.
    const pt = ctx.px(1500, 260);
    for (let i = 0; i < 5; i++) {
      await ctx.page.mouse.click(pt.x, pt.y);
      const on = await ctx.page.evaluate(() => (globalThis as { __eqxStore?: { getState(): { helmActive?: boolean } } }).__eqxStore?.getState().helmActive === true);
      if (on) break;
      await ctx.sleep(300);
    }
    await ctx.sleep(6000);
    // Pull right back to the capital pilot's zoom floor, then back in.
    const c = ctx.px(960, 540);
    await ctx.page.mouse.move(c.x, c.y);
    // Each notch is x0.9 / x1.1; the battleship's floor sits ~3.5x out from
    // the start, so 15 out reaches it and 12 back in returns to the start.
    await wheelSteps(ctx, 100, 15, 200);
    await ctx.sleep(6000);
    await wheelSteps(ctx, -100, 12, 200);
    await ctx.sleep(3000);
  },
};

/**
 * Capitals review round, item 1: the engines. The battleship holds full thrust
 * in a straight line (spawned nose +y, so the stern is at -y). The camera sits
 * on the stern close enough to see each nozzle's flame and ribbon, then pulls
 * back to the whole hull under way.
 */
export const capitalEngines: Shot = {
  id: 'capital-engines',
  section: 'mechanics',
  title: 'Capital engines',
  caption: 'A battleship at full thrust: four engines, each with its own flame and exhaust trail.',
  features: ['CAP'],
  docs: ['ship-kinds'],
  reel: false,
  server: 'capitals',
  target: { room: 'showcase-capitals', params: { sectorScale: '4', shipKind: 'battleship', art: 'machined', fx: 'new', spawnX: 0, spawnY: -9000, initialHull: 1_000_000 } },
  hud: 'none',
  durationMs: 22_000,
  // The game's follow camera (record as is): the pilot zooms out a little to
  // see the engines, then further to the whole hull under way.
  async startWhen(ctx) {
    await artSettled(ctx);
  },
  async run(ctx) {
    const c = ctx.px(960, 540);
    await ctx.page.mouse.move(c.x, c.y);
    await ctx.page.keyboard.down('ArrowUp');
    try {
      // The follow camera leads the ship forward, so zoomed in the stern is
      // off screen (take 1, 2026-11-12). Zoom out until it clears the caption,
      // watch the engines, then pull back to the whole hull under way.
      await wheelSteps(ctx, 100, 4, 200);
      await ctx.sleep(8000);
      await wheelSteps(ctx, 100, 10, 200);
      await ctx.sleep(7500);
    } finally {
      await ctx.page.keyboard.up('ArrowUp');
    }
  },
};

/**
 * Capitals review round, item 2: the battleship's turrets. The pilot (a
 * fighter that can't die) sits 5,000 u off the starboard beam with the fleet
 * hostile: beyond every gun but the 16" main battery (Phase 3 fire control).
 * The camera holds on the battleship's turrets as they swing, then frames the
 * ship and the pilot so the salvos are seen crossing the gap.
 */
export const capitalTurrets: Shot = {
  id: 'capital-turrets',
  section: 'mechanics',
  title: 'Capital turrets',
  caption: 'The battleship turns its 16-inch guns onto a heavy cruiser 4,000 units off its beam and opens fire.',
  features: ['CAP'],
  docs: ['ship-kinds'],
  reel: false,
  server: 'capitals',
  // One battleship, the pilot 4,000 u off its beam (showcase-capital-duel). No
  // startHostile: the fight starts on cue in run(), after the art has baked.
  // Explicit spawn at the room's 4,000 u beam position: without it the join
  // clearance pushes a cruiser to 5,200 u, past the 16-inch reach (5,376)
  // once the idle battleship drifts (measured 2026-11-12).
  target: { room: 'showcase-capital-duel', params: { shipKind: 'heavy-cruiser', art: 'machined', fx: 'new', initialHull: 1_000_000, noselfdmg: 1, spawnX: 4000, spawnY: 0 } },
  hud: 'none',
  durationMs: 22_000,
  async startWhen(ctx) {
    await artSettled(ctx);
    // The battleship must be in the client's view before the camera tracks it.
    await ctx.page.waitForFunction(() => {
      const c = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient;
      let n = 0;
      c?.mirror.swarm.forEach((e) => { if (e.kind === 1) n++; });
      return n > 0;
    }, null, { timeout: 60_000, polling: 250 });
    // Start the fight off camera with ONE cue. Measured in this browser flow
    // (2026-11-12): the lock lands ~3 s after the cue and the first 16" salvo
    // ~23 s; one cue keeps the battleship hostile ~30 s. Wait ~12 s so the take
    // shows the turrets swinging and the salvo, with no cue during it.
    await sendRoom(ctx, 'test_aggro', { type: 'test_aggro' });
    await ctx.sleep(12_000);
    // A framed camera needs a free camera: watch as a spectator (record as is).
    await ctx.spectate();
  },
  async run(ctx) {
    const k = ctx.viewport.width / 1920;
    const id = await ctx.page.evaluate(() => {
      const c = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient;
      let found: number | null = null;
      c?.mirror.swarm.forEach((e, eid) => { if (found === null && e.kind === 1) found = eid; });
      return found;
    });
    const bs = id === null ? 'local' : `swarm-${id}`;
    // Close on the battleship (offset toward the pilot) through the first salvos.
    // Offset toward the pilot so the salvos cross the frame (the hull may have
    // drifted while the art baked, so read the live positions).
    const toward = await ctx.page.evaluate(() => {
      const m = (globalThis as { __eqxClient?: { mirror: { localPlayerId?: string; ships: Map<string, { x: number; y: number }>; swarm: Map<number, { kind: number; x: number; y: number }> } } }).__eqxClient?.mirror;
      const me = m?.localPlayerId ? m.ships.get(m.localPlayerId) : undefined;
      let bx = 0, by = 0;
      m?.swarm.forEach((e) => { if (e.kind === 1) { bx = e.x; by = e.y; } });
      return me ? { x: (me.x - bx) * 0.35, y: (me.y - by) * 0.35 } : { x: 1200, y: 0 };
    });
    await ctx.cinema.play([{ atMs: 0, smoothMs: 0, shot: { kind: 'track', target: bs, zoom: 0.18 * k, offsetX: toward.x, offsetY: toward.y } }]);
    // Close on the guns as they finish the swing and fire...
    await ctx.sleep(5_000);
    // ...then the whole gap, so the shells are seen crossing it and landing.
    await ctx.cinema.play([{ atMs: 0, smoothMs: 2500, shot: { kind: 'frame', ids: [bs, 'local'], padding: 0.2 } }]);
    await ctx.sleep(16_500); // the first salvo lands ~13-15 s in; hold for the impacts
  },
};

/** Turn the mouse wheel `n` notches (+ = out), as a player would. */
async function wheelSteps(ctx: ShotContext, dy: number, n: number, gapMs: number): Promise<void> {
  for (let i = 0; i < n; i++) { await ctx.page.mouse.wheel(0, dy); await ctx.sleep(gapMs); }
}


/**
 * Review round (2026-11-07): "how does it look from a fighter at normal zoom
 * nearby the guns as they fire?" The pilot sits ~1,500 u off the battleship's
 * aft turret with the ordinary follow camera (no script), so this is what a
 * player sees: the turrets swing round, then 16" and 5" salvos at close range.
 */
export const capitalGunsFighter: Shot = {
  id: 'capital-guns-fighter',
  section: 'mechanics',
  title: 'Capital guns, up close',
  caption: 'A battleship\'s 16-inch and 5-inch guns firing at a heavy cruiser alongside, seen from the cruiser at normal zoom.',
  features: ['CAP'],
  docs: ['ship-kinds'],
  reel: false,
  server: 'capitals',
  // The pilot's own hull (2026-11-10: no survive params; the fight runs its course).
  target: { room: 'showcase-capital-duel', params: { shipKind: 'heavy-cruiser', art: 'machined', fx: 'new', spawnX: 1500, spawnY: -1800 } },
  hud: 'none',
  durationMs: 22_000,
  async startWhen(ctx) {
    await artSettled(ctx);
    await ctx.page.waitForFunction(() => {
      const c = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient;
      let n = 0;
      c?.mirror.swarm.forEach((e) => { if (e.kind === 1) n++; });
      return n > 0;
    }, null, { timeout: 60_000, polling: 250 });
    // Start the fight off camera so the turrets are already swinging round.
    // One cue sets the scene; nothing re-arms hostility during the take.
    await sendRoom(ctx, 'test_aggro', { type: 'test_aggro' });
    await ctx.sleep(14_000);
  },
  async run(ctx) {
    // The battleship holds a ~4,000 u stand-off, wider than a fighter's normal
    // view, so the pilot dives in at its aft turret, the way a player would.
    const bs = await ctx.page.evaluate(() => {
      const m = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number; x: number; y: number }> } } }).__eqxClient?.mirror;
      let p: { x: number; y: number } | null = null;
      m?.swarm.forEach((e) => { if (e.kind === 1) p = { x: e.x, y: e.y }; });
      return p as { x: number; y: number } | null;
    });
    const t0 = Date.now();
    if (bs) await flyTo(ctx, bs.x + 1100, bs.y - 1200, { arrive: 250, maxMs: 14_000, cruise: 420 });
    await ctx.sleep(Math.max(0, 21_500 - (Date.now() - t0)));
  },
};

/** Bystander spot in the battleship's own frame (forward, starboard): ahead of
 *  the forward turrets, clear of their line of fire to a target on the
 *  starboard beam, so the guns swing across it as they train round (the feel
 *  the user wants, review 2026-11-07). The target sits TARGET_OFF u off that
 *  beam. */
const BYSTANDER = { fwd: 2200, stbd: 500 };
const TARGET_OFF = 4000;

/** The battleship's live pose from a client's mirror. */
async function battleship(page: import('@playwright/test').Page): Promise<{ x: number; y: number; angle: number } | null> {
  return page.evaluate(() => {
    const m = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number; x: number; y: number; angle: number }> } } }).__eqxClient?.mirror;
    let p: { x: number; y: number; angle: number } | null = null;
    m?.swarm.forEach((e) => { if (e.kind === 1) p = { x: e.x, y: e.y, angle: e.angle }; });
    return p as { x: number; y: number; angle: number } | null;
  });
}
/** A point (fwd, stbd) in the battleship's frame, in world space. */
function shipPoint(bs: { x: number; y: number; angle: number }, fwd: number, stbd: number): { x: number; y: number } {
  const fx = -Math.sin(bs.angle), fy = Math.cos(bs.angle); // forward
  const sx = Math.cos(bs.angle), sy = Math.sin(bs.angle); // starboard
  return { x: bs.x + fx * fwd + sx * stbd, y: bs.y + fy * fwd + sy * stbd };
}

/**
 * Review round (2026-11-07): "leave the fighter where it was and spawn another
 * one near the turrets so someone who isn't a target gets a feeling for what
 * it's like." The RECORDED pilot is a bystander parked beside the battleship's
 * starboard turrets on the normal follow camera; a second, unrecorded client
 * flies the target 4,000 u off the beam and is the only one the battleship is
 * hostile to (test_aggro from its own session).
 */
export const capitalGunsBystander: Shot = {
  id: 'capital-guns-bystander',
  section: 'mechanics',
  title: 'Capital guns, from beside them',
  caption: 'A battleship firing at a heavy cruiser 4,000 units away, seen from a fighter parked beside its turrets.',
  features: ['CAP'],
  docs: ['ship-kinds'],
  reel: false,
  server: 'capitals',
  target: { room: 'showcase-capital-duel', params: { shipKind: 'fighter', art: 'machined', fx: 'new', initialHull: 1_000_000, noselfdmg: 1, spawnX: 2000, spawnY: 2000 } },
  hud: 'none',
  durationMs: 24_000,
  async startWhen(ctx) {
    // The target: a separate browser context (its own player id) at the
    // room's default spawn, 4,000 u off the battleship's starboard beam. It
    // joins and starts the fight BEFORE the art bake finishes, so the
    // battleship spends that time squaring up to its target, not wandering.
    const browser = ctx.page.context().browser();
    if (!browser) throw new Error('no browser for the target client');
    const tctx = await browser.newContext({ viewport: { width: 640, height: 360 } });
    const tpage = await tctx.newPage();
    targetPages.set(ctx.testId, { tctx, tpage });
    // Wait until the bystander's client sees the battleship, then put the
    // target on its starboard beam wherever it has drifted to.
    await ctx.page.waitForFunction(() => {
      let n = 0;
      (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient?.mirror.swarm.forEach((e) => { if (e.kind === 1) n++; });
      return n > 0;
    }, null, { timeout: 60_000, polling: 250 });
    const bs0 = await battleship(ctx.page);
    const tp = bs0 ? shipPoint(bs0, 0, TARGET_OFF) : { x: 4000, y: 0 };
    await tpage.goto(targetUrl(ctx.baseUrl, { room: 'showcase-capital-duel', params: { shipKind: 'heavy-cruiser', art: 'classic', initialHull: 1_000_000, noselfdmg: 1, spawnX: Math.round(tp.x), spawnY: Math.round(tp.y) } }, ctx.testId, 'none'));
    await tpage.waitForSelector('[data-testid="warp-screen"][data-warp-visible="0"]', { state: 'attached', timeout: 60_000 });
    const aggro = (): Promise<void> => tpage.evaluate(() => {
      const c = (window as unknown as { __eqxClient?: { getRoom?: () => { send: (ch: string, x: unknown) => void } | null } }).__eqxClient;
      c?.getRoom?.()?.send('test_aggro', { type: 'test_aggro' });
    }).catch(() => undefined);
    // One cue sets the scene; the battleship's lock keeps it hostile, so
    // nothing re-arms it during the take (record as is).
    await aggro();
    await artSettled(ctx);
    // Fly the bystander to its spot while the turrets finish training round.
    await keepStation(ctx, 14_000);
  },
  async run(ctx) {
    const t = targetPages.get(ctx.testId);
    try {
      await keepStation(ctx, 23_500);
    } finally {
      if (t?.timer) clearInterval(t.timer);
      await t?.tctx.close();
      targetPages.delete(ctx.testId);
    }
  },
};

/** Hold the bystander at BYSTANDER relative to the battleship as it moves. */
async function keepStation(ctx: ShotContext, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const bs = await battleship(ctx.page);
    const p = bs ? shipPoint(bs, BYSTANDER.fwd, BYSTANDER.stbd) : null;
    if (p) await flyTo(ctx, p.x, p.y, { arrive: 120, maxMs: Math.min(3000, end - Date.now()), cruise: 320 });
    else await ctx.sleep(500);
  }
}

const targetPages = new Map<string, { tctx: import('@playwright/test').BrowserContext; tpage: import('@playwright/test').Page; timer?: ReturnType<typeof setInterval> }>();


/**
 * Wrap-up W2c: a flagship fleet spools and warps (the NPC warp, W2a). Seen
 * from a pilot beside it: the battleship and its escorts spool up together and
 * jump west as one, leaving burning trails (`showcase-fleet-warp`, the jump cued
 * with `test_fleet_warp` once the art has baked).
 */
export const capitalFleetWarp: Shot = {
  id: 'capital-fleet-warp',
  section: 'mechanics',
  title: 'A capital fleet jumps',
  caption: 'A flagship and its escorts spool up together and warp out as one, leaving their engine trails burning behind them.',
  features: ['CAP', 'P4'],
  docs: ['capital-ships', 'warp-to'],
  reel: false,
  server: 'capitals',
  target: { room: 'showcase-fleet-warp', params: { shipKind: 'fighter', art: 'machined', fx: 'new', initialHull: 1_000_000, noselfdmg: 1 } },
  hud: 'none',
  durationMs: 7_000,
  async startWhen(ctx) {
    await artSettled(ctx);
    // A framed camera needs a free camera: watch as a spectator (record as is).
    await ctx.spectate();
  },
  // A HELD camera: 'frame all' followed the fleet to its arrival point,
  // where the formation looks the same, so the jump didn't read (first take).
  camera: [{ atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: 0, y: 0, zoom: 0.15 } }],
  async run(ctx) {
    await ctx.sleep(1000);
    await sendRoom(ctx, 'test_fleet_warp', { type: 'test_fleet_warp', x: -45_000, y: 0 });
    await ctx.sleep(5_800);
  },
};

/** The other end: a pilot waiting where the fleet drops out of warp. */
export const capitalFleetArrive: Shot = {
  id: 'capital-fleet-arrive',
  section: 'mechanics',
  title: 'A capital fleet arrives',
  caption: 'Out of nowhere the fleet drops out of warp in formation, flagship in the middle.',
  features: ['CAP', 'P4'],
  docs: ['capital-ships'],
  reel: false,
  server: 'capitals',
  // The pilot waits 45 km west, south of where the flagship will land.
  target: { room: 'showcase-fleet-warp', params: { shipKind: 'fighter', art: 'machined', fx: 'new', initialHull: 1_000_000, noselfdmg: 1, spawnX: -45_000, spawnY: -Math.round(getShipKind('battleship-b').radius * 2.2) } },
  hud: 'none',
  durationMs: 7_000,
  // Cue the jump before the take: it spools ~3 s and runs ~2 s unseen, so the
  // recording starts ~1.5 s before the drop (review: 5 s of empty sky).
  async startWhen(ctx) {
    await sendRoom(ctx, 'test_fleet_warp', { type: 'test_fleet_warp', x: -45_000, y: 0 });
    // A framed camera needs a free camera: watch as a spectator (record as is).
    await ctx.spectate();
    await ctx.sleep(1_800);
  },
  camera: [{ atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: -45_000, y: 0, zoom: 0.15 } }],
  async run(ctx) {
    await ctx.sleep(6_800);
  },
};

/**
 * Wrap-up W7: GPU-lit art (default for players since #344–#346; automated
 * browsers stay on Baked unless the URL asks). The capital-guns-fighter take
 * with : seen from a fighter ~1,500 u off the aft turret, the
 * 16- and 5-inch muzzle flashes light the gunhouses and deck around them.
 * (The capital-turrets framing was tried first: at 4,000 u only two salvos
 * land, the bow ran off frame and no light read; review 2026-11-09.)
 */
export const gpuLitShips: Shot = {
  ...capitalGunsFighter,
  id: 'gpu-lit-ships',
  section: 'tech',
  title: 'GPU-lit ships',
  caption: 'Ships are lit on the GPU every frame: each muzzle flash lights the gunhouses and deck around it.',
  docs: ['gpu-lit-ships'],
  reel: false,
  target: { room: 'showcase-capital-duel', params: { ...capitalGunsFighter.target.params, shiplight: 'high' } },
  // Known (review 2026-11-09): the follow camera keeps the hull near the left
  // edge and the caption over the stern; two scripted track cameras framed it
  // worse. Flash light shows for 1-2 frames and 5" turrets cast none (game-side).
};

/**
 * Capital destruction (owner, 2026-11-12): a capital breaks up along the hit
 * that killed it. Real play, no cue during the take: the pilot's heavy cruiser
 * sits off the battleship's beam with little hull and no shield, the
 * battleship's 16-inch salvo kills it on camera, and the hull fractures where
 * the shells struck. Needs capital wrecks on (EQX_CAPITAL_WRECKS=1 on the
 * showcase server) until the feature ships.
 */
export const capitalBreakup: Shot = {
  id: 'capital-breakup',
  section: 'mechanics',
  title: 'A capital breaks up',
  caption: 'A battleship salvo kills a heavy cruiser, and the hull breaks apart along where the shells struck.',
  features: ['CAP'],
  docs: ['capital-destruction'],
  reel: false,
  server: 'capitals',
  target: { room: 'showcase-capital-duel', params: { shipKind: 'heavy-cruiser', art: 'machined', fx: 'new', initialHull: 6000, initialShield: 0, spawnX: 4000, spawnY: 0 } },
  hud: 'none',
  durationMs: 32_000,
  async startWhen(ctx) {
    await artSettled(ctx);
    await ctx.page.waitForFunction(() => {
      let n = 0;
      (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient?.mirror.swarm.forEach((e) => { if (e.kind === 1) n++; });
      return n > 0;
    }, null, { timeout: 60_000, polling: 250 });
    // One cue in setup; the first salvo lands ~23-27 s after it.
    await sendRoom(ctx, 'test_aggro', { type: 'test_aggro' });
    await ctx.sleep(10_000);
    // A free camera needs spectator mode (record as is).
    await ctx.spectate();
  },
  async run(ctx) {
    const k = ctx.viewport.width / 1920;
    // Hold on the cruiser so the break-up fills the frame.
    await ctx.cinema.play([{ atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: 4000, y: -350, zoom: 0.17 * k } }]); // the cruiser is parked at its explicit spawn
    await ctx.sleep(31_500); // ~14 s after the kill for the pieces to drift apart
  },
};
