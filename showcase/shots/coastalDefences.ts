/**
 * Coastal defences (plan coastal-defences): the static gun catalogue, filmed.
 *
 * Rooms (src/server/rooms/showcaseRooms.ts): `showcase-coastal` (every battery
 * in a line on a range, with parked targets at each gun's reach),
 * `showcase-coastal-aa` (an AA screen and a fighter pack),
 * `showcase-coastal-duel` (a battery against a battleship) and
 * `showcase-garrison` (a region-heart garrison with its super-guns).
 *
 * The guns fire on their real reloads (16" 30 s, the siege gun 2 min), so a
 * shot cues `test_reload_turrets` (testMode) to have a battery fire as the
 * camera reaches it. Aim, lead and targeting are the real fire control: a gun
 * still fires only when it is on its target.
 */
import type { Shot, ShotContext } from '../types.js';
import { sendRoom } from './_helpers.js';
import { COASTAL_LINE, GARRISON_EXTENT } from '../../src/server/rooms/showcaseRooms.js';

const PARAMS = { shipKind: 'fighter', art: 'machined', fx: 'new', initialHull: 1_000_000, noselfdmg: 1 } as const;

async function artSettled(ctx: ShotContext): Promise<void> {
  await ctx.page.waitForFunction(() => {
    const st = (globalThis as { __eqxArtStats?: () => { pending?: number; ready?: number } }).__eqxArtStats?.();
    return !!st && (st.ready ?? 0) > 0 && (st.pending ?? 1) === 0;
  }, null, { timeout: 120_000, polling: 500 });
}

/** Wait until the client has at least `n` structures (the batteries) mirrored. */
async function structuresIn(ctx: ShotContext, n: number): Promise<void> {
  await ctx.page.waitForFunction((min) => {
    const c = (globalThis as { __eqxClient?: { mirror: { structures?: Map<number, unknown> } } }).__eqxClient;
    return (c?.mirror.structures?.size ?? 0) >= min;
  }, n, { timeout: 60_000, polling: 250 });
}

const reload = (ctx: ShotContext): Promise<void> => sendRoom(ctx, 'test_reload_turrets', { type: 'test_reload_turrets' });

/** World x of a battery in the line. */
const lineX = (kind: string): number => COASTAL_LINE.find((g) => g.kind === kind)!.x;

/**
 * The catalogue: a dolly along the line from the quad AA to the 80 cm siege
 * gun, each battery firing as the camera reaches it, then a pull-out over the
 * range to the targets.
 */
export const coastalCatalogue: Shot = {
  id: 'coastal-catalogue',
  section: 'mechanics',
  title: 'Gun batteries',
  caption: 'From a quad Bofors to an 80 cm siege gun: every coastal battery, firing on the range.',
  features: ['COAST'],
  docs: ['coastal-defences'],
  reel: true,
  server: 'capitals',
  target: { room: 'showcase-coastal', params: PARAMS },
  hud: 'none',
  durationMs: 34_000,
  async startWhen(ctx) {
    await artSettled(ctx);
    await structuresIn(ctx, 20);
    // Let every barrel train onto its target before the take.
    await ctx.sleep(8000);
  },
  async run(ctx) {
    const start = Date.now();
    const k = ctx.viewport.width / 1920;
    const y = 150;
    await ctx.cinema.play([{
      atMs: 0, smoothMs: 0, shot: {
        kind: 'path', easing: 'linear', keys: [
          { t: 0, x: lineX('aa_quad_40mm') + 200, y, zoom: 0.62 * k },
          { t: 4000, x: lineX('dp_mount_5in'), y, zoom: 0.58 * k },
          { t: 8000, x: lineX('coastal_casemate_8in'), y, zoom: 0.5 * k },
          { t: 12_500, x: lineX('coastal_turret_11in'), y, zoom: 0.46 * k },
          { t: 17_000, x: lineX('coastal_barbette_16in'), y, zoom: 0.42 * k },
          { t: 21_500, x: lineX('coastal_lindemann'), y, zoom: 0.4 * k },
          { t: 25_500, x: lineX('siege_gun_80cm'), y, zoom: 0.38 * k },
          { t: 29_000, x: 0, y: 2300, zoom: 0.15 * k },
        ],
      },
    }]);
    // Each heavy battery fires as it comes into frame.
    for (const at of [6500, 11_000, 15_500, 20_000, 24_000]) {
      await ctx.sleep(Math.max(0, at - (Date.now() - start)));
      await reload(ctx);
    }
    await ctx.sleep(Math.max(0, 34_000 - (Date.now() - start) - 200));
  },
};

/**
 * The AA screen: a fighter pack and two gunships attack. The quad Bofors
 * take the fighters, the 5" mounts the gunships (calibre priority).
 */
export const coastalAa: Shot = {
  id: 'coastal-aa',
  section: 'mechanics',
  title: 'AA screen',
  caption: 'Quad 40 mm mounts take the fighters while the 5-inch guns pick out the gunships.',
  features: ['COAST'],
  docs: ['coastal-defences'],
  reel: true,
  server: 'capitals',
  target: { room: 'showcase-coastal-aa', params: PARAMS },
  hud: 'none',
  durationMs: 24_000,
  async startWhen(ctx) {
    await artSettled(ctx);
    await structuresIn(ctx, 10);
    // The pack turns on the pilot (behind the guns) as the take opens.
    await sendRoom(ctx, 'test_aggro', { type: 'test_aggro' });
    await ctx.sleep(1500);
  },
  async run(ctx) {
    const k = ctx.viewport.width / 1920;
    await ctx.cinema.play([
      { atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: 0, y: 700, zoom: 0.42 * k } },
      { atMs: 11_000, smoothMs: 2500, shot: { kind: 'hold', x: -300, y: 0, zoom: 0.85 * k } },
    ]);
    await ctx.sleep(23_500);
  },
};

/**
 * The coastal duel: an 8" casemate, an 11" triple turret and a 16" barbette
 * against a battleship. Wide on both, in on the battery firing, then on the
 * battleship as the shells land.
 */
export const coastalDuel: Shot = {
  id: 'coastal-duel',
  section: 'mechanics',
  title: 'Coastal duel',
  caption: 'A coastal battery exchanges salvos with a battleship at 5,000 units.',
  features: ['COAST', 'CAP'],
  docs: ['coastal-defences'],
  reel: true,
  server: 'capitals',
  target: { room: 'showcase-coastal-duel', params: PARAMS },
  hud: 'none',
  durationMs: 34_000,
  async startWhen(ctx) {
    await artSettled(ctx);
    await structuresIn(ctx, 10);
    await sendRoom(ctx, 'test_aggro', { type: 'test_aggro' });
    // The battleship closes to its broadside range off camera.
    await ctx.sleep(10_000);
  },
  async run(ctx) {
    const t0 = Date.now();
    const k = ctx.viewport.width / 1920;
    const bs = await ctx.page.evaluate(() => {
      const c = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient;
      let found: number | null = null;
      c?.mirror.swarm.forEach((e, eid) => { if (found === null && e.kind === 1) found = eid; });
      return found === null ? null : `swarm-${found}`;
    });
    await ctx.cinema.play([
      { atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: 0, y: 2300, zoom: 0.13 * k } },
      { atMs: 11_000, smoothMs: 2200, shot: { kind: 'hold', x: 0, y: 200, zoom: 0.42 * k } },
      ...(bs ? [{ atMs: 22_000, smoothMs: 2500, shot: { kind: 'track' as const, target: bs, zoom: 0.17 * k, offsetY: -1200 } }] : []),
    ]);
    for (const at of [1000, 12_500, 20_500]) {
      await ctx.sleep(Math.max(0, at - (Date.now() - t0)));
      await sendRoom(ctx, 'test_aggro', { type: 'test_aggro' });
      await reload(ctx);
    }
    await ctx.sleep(Math.max(0, 33_800 - (Date.now() - t0)));
  },
};

/**
 * The super-guns: the 40.6 cm Lindemann battery and the 80 cm siege gun fire
 * on a battleship 5,000 units out; the camera follows the shells to the
 * siege shell's blast. Twice.
 */
export const coastalSuperGuns: Shot = {
  id: 'coastal-super-guns',
  section: 'mechanics',
  title: 'Super-guns',
  caption: 'Land guns bigger than any ship carried: a 40.6 cm coast gun and an 80 cm siege gun.',
  features: ['COAST'],
  docs: ['coastal-defences'],
  reel: true,
  server: 'capitals',
  target: { room: 'showcase-coastal', params: PARAMS },
  hud: 'none',
  durationMs: 24_000,
  async startWhen(ctx) {
    await artSettled(ctx);
    await structuresIn(ctx, 20);
    await ctx.sleep(10_000); // both trained on the battleship
  },
  async run(ctx) {
    const k = ctx.viewport.width / 1920;
    const gx = (lineX('coastal_lindemann') + lineX('siege_gun_80cm')) / 2;
    const salvo = async (): Promise<void> => {
      await ctx.cinema.play([{ atMs: 0, smoothMs: 1200, shot: { kind: 'hold', x: gx, y: 200, zoom: 0.55 * k } }]);
      await ctx.sleep(1800);
      await reload(ctx);
      await ctx.sleep(500);
      // Follow the shells out to the battleship (flight ~2–3 s).
      await ctx.cinema.play([{
        atMs: 0, smoothMs: 0, shot: {
          kind: 'path', keys: [
            { t: 0, x: gx, y: 200, zoom: 0.55 * k },
            { t: 2600, x: 1900, y: 3600, zoom: 0.3 * k },
            { t: 3800, x: 1900, y: 4800, zoom: 0.32 * k },
          ],
        },
      }]);
      await ctx.sleep(7000);
    };
    await salvo();
    await salvo();
    await ctx.sleep(1500);
  },
};

/**
 * A regenerated region-heart garrison: a fly-over of its bastions (the
 * siege gun, the Lindemann, the coastal guns and AA), then the pilot opens
 * fire on it and the batteries answer.
 */
export const garrisonDefences: Shot = {
  id: 'garrison-defences',
  section: 'mechanics',
  title: 'Garrison batteries',
  caption: "A region capital's garrison mounts its batteries on bastions outside the fence, siege gun and all.",
  features: ['COAST', 'V4-M'],
  docs: ['coastal-defences', 'military-bases'],
  reel: true,
  server: 'lean',
  target: { room: 'showcase-garrison', params: { shipKind: 'heavy', initialHull: 1_000_000, noselfdmg: 1, art: 'machined', fx: 'new' } },
  hud: 'none',
  durationMs: 30_000,
  async startWhen(ctx) {
    await artSettled(ctx);
  },
  async run(ctx) {
    const k = ctx.viewport.width / 1920;
    const e = GARRISON_EXTENT;
    const cx = (e.x0 + e.x1) / 2, cy = (e.y0 + e.y1) / 2;
    await ctx.cinema.play([{
      atMs: 0, smoothMs: 0, shot: {
        kind: 'path', keys: [
          { t: 0, x: cx, y: cy, zoom: 0.11 * k },
          { t: 4000, x: cx, y: cy, zoom: 0.11 * k },
          { t: 9000, x: e.x1 - 600, y: e.y0 + 1200, zoom: 0.32 * k },
          { t: 14_000, x: e.x1 - 600, y: e.y1 - 1200, zoom: 0.32 * k },
          { t: 19_000, x: e.x0 + 600, y: e.y1 - 1200, zoom: 0.3 * k },
          { t: 23_000, x: e.x0 + 600, y: e.y0 + 1200, zoom: 0.3 * k },
        ],
      },
    }]);
    // The pilot (south of the base) opens fire on it: now it's hostile.
    await ctx.sleep(20_000);
    await ctx.cinema.play([{ atMs: 0, smoothMs: 2500, shot: { kind: 'track', target: 'local', zoom: 0.2 * k, offsetY: 1800 } }]);
    await ctx.hold(['Space'], 2500);
    await ctx.sleep(7000);
  },
};
