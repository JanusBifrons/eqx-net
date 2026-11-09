import type { Shot } from '../types.js';
import { allGroupsManual, lockAhead } from './_helpers.js';
import { SHOWCASE_HUB_PAD, SHOWCASE_PORT_PAD } from '../../src/server/rooms/showcaseRooms.js';

/**
 * Plan soft-leaping-truffle v4 — teleporters, alien gates, transit hubs and
 * garrisons. All four run on the lean server against staged rooms
 * (`src/server/rooms/showcaseRooms.ts`, `alien-gate-test` in `index.ts`).
 */

/**
 * Teleporters (T1/T2) — `showcase-teleport`: two paired pads that fire when a
 * ship boards. The pilot waits on the west pad: warned, the doors close, and
 * the jump lands it on the east pad.
 */
export const teleporterRide: Shot = {
  id: 'teleporter-ride',
  section: 'mechanics',
  title: 'Teleporters',
  caption: 'Paired teleporters swap whatever sits on their pads: the doors close, and the ship lands on the far pad.',
  features: ['V4-T'],
  docs: ['teleporters'],
  reel: true,
  server: 'lean',
  // A heavy reads at this zoom; a fighter is a few pixels across.
  target: { room: 'showcase-teleport', params: { shipKind: 'heavy', spawnX: -1300, spawnY: -60 } },
  hud: 'minimal',
  durationMs: 15_000,
  camera: [{ atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: 0, y: -60, zoom: 0.55 } }],
  async run(ctx) {
    await ctx.sleep(1200);
    await ctx.hold(['a'], 350);
  },
};

/**
 * Alien gates (A) — `alien-gate-test`: an Ancients' gate at the origin. The
 * pilot flies up to it and opens fire inside its zone: engines and weapons
 * go offline, and the countdown appears.
 */
export const alienGate: Shot = {
  id: 'alien-gate',
  section: 'mechanics',
  title: 'Alien gates',
  caption: "Every border has an Ancients' gate. They can't be hurt, and their guns disable anyone who opens fire near one.",
  features: ['V4-A'],
  docs: ['alien-gates'],
  reel: true,
  server: 'lean',
  // Lock-to-fire: instantLock + MAN — the pilot locks the gate and opens fire on cue.
  target: { room: 'alien-gate-test', params: { shipKind: 'fighter', instantLock: 1 } },
  hud: 'minimal',
  durationMs: 10_000,
  camera: [
    { atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: 0, y: -700, zoom: 0.38 } },
    { atMs: 5000, smoothMs: 1200, shot: { kind: 'hold', x: 0, y: -800, zoom: 0.5 } },
  ],
  async run(ctx) {
    await allGroupsManual(ctx);
    await ctx.sleep(1200);
    await ctx.hold(['w'], 900);
    await lockAhead(ctx);
    await ctx.hold(['Space'], 1600);
    // Engines are off now: holding thrust does nothing until it wears off.
    await ctx.hold(['w'], 2000);
  },
};

/**
 * Military bases (M) — `showcase-garrison`: a region power's fenced gun-base
 * with its patrol circling outside. The pilot (a tough heavy) flies in and
 * opens fire on it; the patrol and the guns turn on it.
 */
export const garrisonPatrol: Shot = {
  id: 'garrison-patrol',
  section: 'mechanics',
  title: 'Garrisons',
  caption: 'Garrisons guard region capitals and frontier edges. Their patrols leave you alone until you attack.',
  features: ['V4-M'],
  docs: ['military-bases'],
  reel: true,
  server: 'lean',
  // (Damage numbers on the pilot stay on: they show the patrol's hits.)
  // instantLock + MAN groups: the pilot locks + opens fire ON CUE (lock-to-fire).
  target: { room: 'showcase-garrison', params: { shipKind: 'heavy', initialHull: 1_000_000, instantLock: 1 } },
  hud: 'none',
  durationMs: 26_000,
  // The patrol flies the base's south side (~y -4400); hold there so it
  // crosses the frame, with the pilot and the fence line in view.
  camera: [
    // Wide enough for the corners the patrol turns at (x about ±2500).
    { atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: 0, y: -4250, zoom: 0.4 } },
    // Then close in on the pilot as the patrol reaches it.
    { atMs: 11_000, smoothMs: 2000, shot: { kind: 'track', target: 'local', zoom: 0.62, leadMs: 200 } },
  ],
  async run(ctx) {
    // The patrol circles; the pilot is left alone.
    await allGroupsManual(ctx);
    await ctx.sleep(2500);
    await ctx.hold(['w'], 1500);
    await ctx.hold(['s'], 400);
    // Opens fire on the base: now it's hostile, and the patrol closes in.
    await lockAhead(ctx);
    await ctx.hold(['Space'], 3000);
    // Turn west and fly to meet the patrol (patrol craft cruise ~90 u/s).
    await ctx.hold(['a'], 800);
    await ctx.hold(['w'], 2200);
    await lockAhead(ctx);
    await ctx.hold(['Space'], 3000);
    await ctx.sleep(2000);
    await lockAhead(ctx);
    await ctx.hold(['Space'], 3000);
  },
};

/**
 * Transit hubs (H) — `showcase-hub`: a hub and a trade port it links to (in
 * one room for the shot; galaxy links join two sectors). The pilot boards the
 * hub's link pad, pays the toll, and lands at the port.
 */
export const transitHub: Shot = {
  id: 'transit-hub',
  section: 'mechanics',
  title: 'Transit hubs',
  caption: 'Transit hubs link regions with pre-paired teleporters. Board a pad, pay the toll, and arrive at the far base.',
  features: ['V4-H'],
  docs: ['transit-hubs'],
  reel: true,
  server: 'lean',
  target: { room: 'showcase-hub', params: { shipKind: 'fighter', initialWallet: 1000 } },
  hud: 'minimal',
  durationMs: 16_000,
  camera: [
    {
      atMs: 0,
      smoothMs: 0,
      shot: { kind: 'hold', x: Math.round((SHOWCASE_HUB_PAD.x + SHOWCASE_PORT_PAD.x) / 2), y: SHOWCASE_HUB_PAD.y, zoom: 0.3 },
    },
  ],
  async run(ctx) {
    const prompt = ctx.page.getByTestId('toll-prompt');
    try {
      await prompt.waitFor({ state: 'visible', timeout: 9000 });
      await ctx.sleep(1400);
      await ctx.page.getByTestId('toll-pay').click();
    } catch {
      ctx.log('transit-hub: no toll prompt this take');
    }
  },
};
