import type { Shot } from '../types.js';
import { sendRoom } from './_helpers.js';
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
  durationMs: 10_000,
  async startWhen(ctx) {
    await artSettled(ctx);
  },
  camera: [
    { atMs: 0, smoothMs: 0, shot: { kind: 'frame', group: 'drones', padding: 0.15, maxZoom: 3 } },
    { atMs: 6000, smoothMs: 2500, shot: { kind: 'frame', group: 'all', padding: 0.2, maxZoom: 3 } },
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
  target: { room: 'showcase-capitals-combat', params: { sectorScale: '4', shipKind: 'fighter', art: 'machined', fx: 'new', initialHull: 1_000_000, noselfdmg: 1 } },
  hud: 'none',
  durationMs: 14_000,
  async startWhen(ctx) {
    await artSettled(ctx);
  },
  camera: [{ atMs: 0, smoothMs: 0, shot: { kind: 'frame', group: 'all', padding: 0.2, maxZoom: 2.5 } }],
  async run(ctx) {
    await sendRoom(ctx, 'test_aggro', { type: 'test_aggro' });
    await ctx.sleep(13_500);
  },
};

/** Wait until no ship / structure art is still baking (a 10x battleship
 *  takes ~15 s), so the take never shows the vector stand-in. */
async function artSettled(ctx: ShotContext): Promise<void> {
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
  camera: [{ atMs: 0, smoothMs: 0, shot: { kind: 'track', target: 'local', zoom: 0.09, leadMs: 400 } }],
  async startWhen(ctx) {
    await artSettled(ctx);
  },
  async run(ctx) {
    const k = ctx.viewport.width / 1920;
    await ctx.sleep(1500);
    // A real tap on empty space up and to the right: the helm takes the course.
    const pt = ctx.px(1500, 260);
    for (let i = 0; i < 5; i++) {
      await ctx.page.mouse.click(pt.x, pt.y);
      const on = await ctx.page.evaluate(() => (globalThis as { __eqxStore?: { getState(): { helmActive?: boolean } } }).__eqxStore?.getState().helmActive === true);
      if (on) break;
      await ctx.sleep(300);
    }
    await ctx.sleep(7000);
    await ctx.cinema.play([{ atMs: 0, smoothMs: 4000, shot: { kind: 'track', target: 'local', zoom: 0.032 * k, leadMs: 400 } }]);
    await ctx.sleep(9000);
    await ctx.cinema.play([{ atMs: 0, smoothMs: 3000, shot: { kind: 'track', target: 'local', zoom: 0.09 * k, leadMs: 400 } }]);
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
  camera: [{ atMs: 0, smoothMs: 0, shot: { kind: 'track', target: 'local', zoom: 0.6, offsetY: -3000 } }],
  async startWhen(ctx) {
    await artSettled(ctx);
  },
  async run(ctx) {
    const k = ctx.viewport.width / 1920;
    await ctx.page.keyboard.down('ArrowUp');
    try {
      await ctx.sleep(9000);
      await ctx.cinema.play([{ atMs: 0, smoothMs: 4000, shot: { kind: 'track', target: 'local', zoom: 0.08 * k } }]);
      await ctx.sleep(12_500);
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
  caption: 'The battleship turns its 16-inch guns onto a fighter 4,000 units off its beam and opens fire.',
  features: ['CAP'],
  docs: ['ship-kinds'],
  reel: false,
  server: 'capitals',
  // One battleship, the pilot 4,000 u off its beam (showcase-capital-duel). No
  // startHostile: the fight starts on cue in run(), after the art has baked.
  target: { room: 'showcase-capital-duel', params: { shipKind: 'fighter', art: 'machined', fx: 'new', initialHull: 1_000_000, noselfdmg: 1 } },
  hud: 'none',
  durationMs: 30_000,
  async startWhen(ctx) {
    await artSettled(ctx);
    // The battleship must be in the client's view before the camera tracks it.
    await ctx.page.waitForFunction(() => {
      const c = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient;
      let n = 0;
      c?.mirror.swarm.forEach((e) => { if (e.kind === 1) n++; });
      return n > 0;
    }, null, { timeout: 60_000, polling: 250 });
    // Start the fight off camera: at the real 4°/s a 16" turret takes ~25 s to
    // train onto the beam, so the take opens with the guns finishing the swing.
    await keepHostile(ctx, 18_000);
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
    await keepHostile(ctx, 13_000);
    // Then the whole gap, so the salvos are seen crossing it.
    await ctx.cinema.play([{ atMs: 0, smoothMs: 3500, shot: { kind: 'frame', ids: [bs, 'local'], padding: 0.2 } }]);
    await keepHostile(ctx, 16_500);
  },
};

/** Hold the fight for `ms`: drone hostility decays after 30 s without a hit
 *  on the drone, so re-send the test cue every 9 s (a pilot that never shoots
 *  back would otherwise be forgotten mid-take). */
async function keepHostile(ctx: ShotContext, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sendRoom(ctx, 'test_aggro', { type: 'test_aggro' });
    await ctx.sleep(Math.min(9000, end - Date.now()));
  }
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
  caption: 'A battleship\'s 16-inch and 5-inch guns firing at a fighter alongside, seen from the fighter at normal zoom.',
  features: ['CAP'],
  docs: ['ship-kinds'],
  reel: false,
  server: 'capitals',
  target: { room: 'showcase-capital-duel', params: { shipKind: 'fighter', art: 'machined', fx: 'new', initialHull: 1_000_000, noselfdmg: 1, spawnX: 1500, spawnY: -1800 } },
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
    await keepHostile(ctx, 14_000);
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
    await Promise.all([
      keepHostile(ctx, 21_500),
      bs ? flyTo(ctx, bs.x + 1100, bs.y - 1200, { arrive: 250, maxMs: 14_000, cruise: 420 }) : ctx.sleep(1),
    ]);
  },
};
