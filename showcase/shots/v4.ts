import type { Shot, ShotContext } from '../types.js';
import { allGroupsManual, lockAhead } from './_helpers.js';
import { flyTo, localPose, parkAt } from './_pilot.js';
import { touch } from '../touch.js';
import { alienGateOffsetMs, nextAlienGateJumpMs } from '../../src/shared-types/teleport.js';
import { alienGateSite } from '../../src/core/galaxy/alienGates.js';
import { SHOWCASE_HUB_PAD, SHOWCASE_PORT_PAD } from '../../src/server/rooms/showcaseRooms.js';

/**
 * Plan soft-leaping-truffle v4 — teleporters, alien gates, transit hubs and
 * garrisons. All four run on the lean server against staged rooms
 * (`src/server/rooms/showcaseRooms.ts`, `alien-gate-test` in `index.ts`).
 */

/** The jump phase (0 idle … 4 open) of the pad / gate of `kind` nearest
 *  (x, y), as this client decoded it (−1 until its row arrives). */
async function padPhase(ctx: ShotContext, kind: string, x: number, y: number): Promise<number> {
  return ctx.page.evaluate(([k, px, py]) => {
    const m = (window as unknown as {
      __eqxClient?: { mirror?: {
        swarm?: Map<number, { shipKind?: string; x: number; y: number }>;
        structures?: Map<number, { teleport?: { phase?: number } }>;
      } };
    }).__eqxClient?.mirror;
    if (!m?.swarm || !m.structures) return -1;
    let best = -1, bestD = Infinity;
    for (const [id, e] of m.swarm) {
      if (e.shipKind !== k) continue;
      const d = Math.hypot(e.x - (px as number), e.y - (py as number));
      if (d < bestD && m.structures.has(id)) { bestD = d; best = m.structures.get(id)?.teleport?.phase ?? 0; }
    }
    return best;
  }, [kind, x, y] as const);
}

/** Poll until `test` passes or `ms` runs out; true when it passed. */
async function until(ctx: ShotContext, test: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return true;
    await ctx.sleep(100);
  }
  return false;
}

/** West / east pads of `showcase-teleport`; each chamber's doorways are at its ±y ends. */
const TP_WEST = { x: -1300, y: 0 };
const TP_EAST = { x: 1300, y: 0 };

/**
 * Teleporters (T1/T2) — `showcase-teleport`: two paired pads that fire when a
 * ship boards. The pilot starts outside the west chamber, flies in through
 * its south doorway and settles on the pad: the departure warning, the blast
 * doors close, the sealed chamber charges, and the swap lands it on the east
 * pad, whose doors open (lights red until they are open, then green). It
 * flies out through the east chamber's north doorway. Filmed on a sideways
 * phone with the game's follow camera (a camera script needs spectator mode,
 * and the pilot must stay aboard to ride).
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
  viewport: 'phone-landscape',
  // Straight below the west chamber's south doorway (chamber y ±400).
  target: { room: 'showcase-teleport', params: { shipKind: 'heavy', spawnX: TP_WEST.x, spawnY: -1100 } },
  hud: 'minimal',
  durationMs: 25_000,
  endsWithRun: true,
  async run(ctx) {
    await ctx.sleep(800);
    // In through the doorway, and settle on the pad.
    const parked = await parkAt(ctx, TP_WEST.x, TP_WEST.y, 9000);
    ctx.log(`teleporter-ride: parked on the west pad: ${parked}`);
    // Boarded: the cycle runs on its own. Wait for the swap to the east pad.
    const swapped = await until(ctx, async () => ((await localPose(ctx))?.x ?? -1e9) > 0, 15_000);
    ctx.log(`teleporter-ride: swapped to the east pad: ${swapped}`);
    // The east doors open (lights red); fly out once the pad is idle (green).
    const idle = await until(ctx, async () => (await padPhase(ctx, 'teleporter', TP_EAST.x, TP_EAST.y)) === 0, 5000);
    ctx.log(`teleporter-ride: east pad idle: ${idle}`);
    // The lights turn green only once the doors are fully open (5df25fc77),
    // a beat after the pad goes idle: wait for green before flying out.
    await ctx.sleep(1800);
    await flyTo(ctx, TP_EAST.x, 1300, { arrive: 200, passThrough: true, cruise: 220, maxMs: 6000 });
    await ctx.sleep(1500);
  },
};

/** Sol Prime's Ancients' gate to Vega Reach (sits at its ideal site). */
const SOL_GATE = alienGateSite('sol-prime', 'vega-reach') ?? { x: 170_000, y: 0 };
/** How far into the take the gate's timetabled jump starts (its ARMED). */
const GATE_JUMP_AT_MS = 11_000;

/**
 * Alien gates (A) — the real Ancients' gate in Sol Prime (the one to Vega
 * Reach), in an ordinary galaxy sector on the solar profile. The pilot flies
 * toward it from the side and pinches out as a player would, to see the whole
 * Astrolabe; the take is timed so the gate's own timetable seals it mid-clip.
 * Filmed on a sideways phone with the game's follow camera.
 */
export const alienGate: Shot = {
  id: 'alien-gate',
  section: 'mechanics',
  title: 'Alien gates',
  caption: "Every border has an Ancients' gate. They jump on a timetable, and their guns disable anyone who opens fire near one.",
  features: ['V4-A'],
  docs: ['alien-gates'],
  reel: true,
  server: 'solar',
  viewport: 'phone-landscape',
  // West of the gate and a little south (-y): a sideways phone's wide view takes the
  // whole ring up and to the right, clear of the rail and the fire button, once
  // the pilot stops ~200 from its centre, on the light pool (the ride area,
  // inside the inner ring), under the stone rings it flew beneath.
  target: { galaxy: 'sol-prime', params: { shipKind: 'fighter', spawnX: SOL_GATE.x - 3200, spawnY: SOL_GATE.y - 150 } },
  hud: 'minimal',
  durationMs: 22_000,
  async prepare(ctx) {
    // A galaxy join can land in Command view: take the controls as a player does.
    const toggle = ctx.page.getByTestId('pilot-toggle');
    if ((await toggle.count()) > 0 && (await toggle.getAttribute('aria-pressed')) === 'false') {
      await toggle.click();
      await ctx.sleep(800);
      const item = ctx.page.locator('[data-testid^="pilot-menu-ship-"]').first();
      if ((await item.count()) > 0) await item.click();
      await ctx.sleep(1200);
      ctx.log('alien-gate: took the controls (Fly)');
    }
  },
  async startWhen(ctx) {
    // Roll so the gate's timetabled jump lands GATE_JUMP_AT_MS into the take.
    const offset = alienGateOffsetMs('sol-prime', 'vega-reach');
    let jump = nextAlienGateJumpMs(Date.now(), offset);
    if (jump - Date.now() < GATE_JUMP_AT_MS + 500) jump = nextAlienGateJumpMs(jump + 1, offset);
    const wait = jump - GATE_JUMP_AT_MS - Date.now();
    ctx.log(`alien-gate: waiting ${Math.round(wait / 1000)} s so the jump falls ${GATE_JUMP_AT_MS / 1000} s in`);
    await ctx.sleep(Math.max(0, wait));
  },
  async run(ctx) {
    const pad = await touch(ctx.page, ctx.log);
    const { width: w, height: h } = ctx.viewport;
    const pinchOut = async (): Promise<void> => {
      const a = pad.finger(), b = pad.finger();
      await a.down(w / 2 - w * 0.3, h / 2); await b.down(w / 2 + w * 0.3, h / 2);
      await Promise.all([a.dragTo(w / 2 - w * 0.05, h / 2, { ms: 900 }), b.dragTo(w / 2 + w * 0.05, h / 2, { ms: 900 })]);
      await a.up(); await b.up();
    };
    await ctx.sleep(600);
    // Fly toward the gate, pinching out on the way, under its rings and onto
    // the light pool, the ride area.
    const fly = flyTo(ctx, SOL_GATE.x - 150, SOL_GATE.y - 100, { arrive: 100, maxMs: 9000 });
    await ctx.sleep(1500);
    await pinchOut();
    await ctx.sleep(300);
    await pinchOut();
    await fly;
    // Watch the gate's own cycle (logged so the take says whether it sealed).
    let last = -2;
    const end = Date.now() + 13_000;
    while (Date.now() < end) {
      const ph = await padPhase(ctx, 'alien_gate', SOL_GATE.x, SOL_GATE.y);
      if (ph !== last) ctx.log(`alien-gate: gate phase ${ph}`);
      last = ph;
      await ctx.sleep(150);
    }
    await pad.dispose();
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
