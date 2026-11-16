/**
 * Weapon cuts (docs/architecture/capital-destruction.md "Kill cuts"): a
 * heavy-beam kill slices a ship along the beam; a railgun kill erases a
 * channel as wide as the slug, and the slug flies on through the ship it
 * killed. Both are real fights: the scene is set before recording (the room,
 * the pilot's hull, ONE `test_aggro`), then nothing changes play. The pilot
 * spectates (a free camera needs spectator mode); its parked hull is still the
 * NPC's target (spectating never dodges a fight).
 */
import type { CameraCue } from '../../src/core/contracts/cameraScript.js';
import type { Shot, ShotContext } from '../types.js';
import { sendRoom } from './_helpers.js';
import { artSettled } from './capitals.js';
import { localPose } from './_pilot.js';

interface MirrorView {
  swarm: Map<number, { kind: number; shipKind?: string; chargingMask?: number }>;
  wrecks: Map<number, { parentKind: string; cutKind?: string }>;
}

/** Wrecks in the pilot's mirror, by parent kind and cut ("heavy-cruiser:slice"). */
async function wreckKinds(ctx: ShotContext): Promise<string[]> {
  return ctx.page.evaluate(() => {
    const m = (globalThis as { __eqxClient?: { mirror: MirrorView } }).__eqxClient?.mirror;
    const out: string[] = [];
    m?.wrecks.forEach((w) => out.push(`${w.parentKind}:${w.cutKind ?? 'none'}`));
    return out;
  }).catch(() => []);
}

/** Wait for the room's NPCs to reach the pilot's mirror, with the art baked. */
async function sceneReady(ctx: ShotContext, n: number): Promise<void> {
  await artSettled(ctx);
  await ctx.page.waitForFunction((want) => {
    let k = 0;
    (globalThis as { __eqxClient?: { mirror: MirrorView } }).__eqxClient?.mirror.swarm.forEach((e) => { if (e.kind === 1) k++; });
    return k >= want;
  }, n, { timeout: 60_000, polling: 250 });
}

/** Watch the wrecks until `done(kinds)` holds, logging each new one; then
 *  `after` more ms. Returns the elapsed ms when `done` first held (or -1). */
async function watchWrecks(ctx: ShotContext, t0: number, capMs: number, done: (k: string[]) => boolean, onNew: (k: string) => Promise<void>): Promise<number> {
  const seen = new Set<string>();
  while (Date.now() - t0 < capMs) {
    const kinds = await wreckKinds(ctx);
    for (const k of kinds) {
      if (seen.has(k)) continue;
      seen.add(k);
      ctx.log(`  [cuts] t=${((Date.now() - t0) / 1000).toFixed(1)}s wreck ${k}`);
      await onNew(k);
    }
    if (done(kinds)) return Date.now() - t0;
    await ctx.sleep(100);
  }
  return -1;
}

/** Game-space poses of the room's NPC ships, by kind. */
async function npcPoses(ctx: ShotContext): Promise<Record<string, { x: number; y: number }>> {
  return ctx.page.evaluate(() => {
    const out: Record<string, { x: number; y: number }> = {};
    (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number; shipKind?: string; x: number; y: number }> } } }).__eqxClient?.mirror.swarm.forEach((e) => {
      if (e.kind === 1 && e.shipKind) out[e.shipKind] = { x: e.x, y: e.y };
    });
    return out;
  });
}

/** Centre of the wreck pieces (swarm kind 4) in the pilot's mirror. */
async function wreckCentre(ctx: ShotContext): Promise<{ x: number; y: number } | null> {
  return ctx.page.evaluate(() => {
    let n = 0, sx = 0, sy = 0;
    (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number; x: number; y: number }> } } }).__eqxClient?.mirror.swarm.forEach((e) => {
      if (e.kind === 4) { n++; sx += e.x; sy += e.y; }
    });
    return n > 0 ? { x: sx / n, y: sy / n } : null;
  }).catch(() => null);
}

/** The pilot's hull where it was parked (taken before spectating), per take. */
const parked = new Map<string, { x: number; y: number }>();

const hold = (x: number, y: number, zoom: number, smoothMs: number): CameraCue => ({ atMs: 0, smoothMs, shot: { kind: 'hold', x, y, zoom } });

/**
 * Shot A: a lance battlecruiser's heavy beams burn through the pilot's heavy
 * cruiser and slice it. Wide on both ships while the turrets train and the
 * burn starts; at the kill the camera closes on the cruiser for the split and
 * the violet cut glow.
 */
export const beamSlice: Shot = {
  id: 'beam-slice',
  section: 'mechanics',
  title: 'Heavy beams slice',
  caption: 'A battlecruiser\'s heavy beams burn into a heavy cruiser until it breaks apart along the beam\'s line, the cut glowing violet.',
  features: ['CAP'],
  docs: ['capital-destruction', 'capital-ships'],
  reel: false,
  server: 'capitals',
  target: { room: 'showcase-beam-slice', params: { shipKind: 'heavy-cruiser', art: 'machined', fx: 'new', spawnX: 8000, spawnY: 0 } },
  hud: 'none',
  durationMs: 75_000,
  endsWithRun: true,
  async startWhen(ctx) {
    await sceneReady(ctx, 1);
    // One cue sets the scene: the battlecruiser turns hostile now.
    await sendRoom(ctx, 'test_aggro', { type: 'test_aggro' });
    await ctx.spectate();
  },
  async run(ctx) {
    const k = ctx.viewport.width / 1920;
    const t0 = Date.now();
    await ctx.cinema.play([hold(4000, 0, 0.17 * k, 0)]);
    let closed = false;
    const at = await watchWrecks(ctx, t0, 70_000,
      (kinds) => kinds.some((s) => s.startsWith('heavy-cruiser:')),
      async () => {
        if (closed) return;
        closed = true;
        // Stay wide through the follow-through (the turret holds its line
        // and the beam burns on through the cut ~1 s), then push in.
        await ctx.sleep(1100);
        await ctx.cinema.play([hold(7350, 0, 0.26 * k, 1400)]);
      });
    ctx.log(`  [beam-slice] ${at < 0 ? 'the cruiser did not die inside the cap' : `cruiser down at ${(at / 1000).toFixed(1)}s`}`);
    if (at >= 0) await ctx.sleep(9000); // the pieces part and the glow cools
  },
};

/** Where the sub-capital pilot parks: the cruiser's spot. (Filmed at 18.5 km,
 *  past the 5" secondaries, 2026-11-15: the beams killed it but no beam was
 *  drawn anywhere near the frigate, and the lock took ~60 s.) */
const SUBCAP_SPAWN_X = 8000;

/** The pilot's parked hull (spectating, it is a lingering hull owned by the
 *  pilot), or null when it is not in the mirror (a destroy removes it). */
async function ownHull(ctx: ShotContext): Promise<{ x: number; y: number } | null> {
  return ctx.page.evaluate(() => {
    const m = (globalThis as { __eqxClient?: { mirror?: { localPlayerId?: string | null; lingeringShips?: Map<string, { x: number; y: number; ownerPlayerId: string }> } } }).__eqxClient?.mirror;
    const id = m?.localPlayerId;
    let out: { x: number; y: number } | null = null;
    if (id) m?.lingeringShips?.forEach((s) => { if (s.ownerPlayerId === id) out = { x: s.x, y: s.y }; });
    return out;
  }).catch(() => null);
}

/** The loot pod (swarm kind 3, `cargo-pod`) nearest `p` within `maxD`. */
async function podNear(ctx: ShotContext, p: { x: number; y: number }, maxD: number): Promise<{ x: number; y: number; radius: number } | null> {
  return ctx.page.evaluate(({ px, py, maxD }) => {
    let best: { x: number; y: number; radius: number } | null = null;
    let bd = maxD;
    (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number; shipKind?: string; x: number; y: number; radius: number }> } } }).__eqxClient?.mirror.swarm.forEach((e) => {
      if (e.kind !== 3 || e.shipKind !== 'cargo-pod') return;
      const d = Math.hypot(e.x - px, e.y - py);
      if (d < bd) { bd = d; best = { x: e.x, y: e.y, radius: e.radius }; }
    });
    return best;
  }, { px: p.x, py: p.y, maxD }).catch(() => null);
}

/** A hold that puts the game-space box's centre at the centre of the clear
 *  band above the caption (x 30-80 %, y 12-62 %), zoomed to fit it (capped at
 *  `maxZoom`). */
function holdOnBox(ctx: ShotContext, b: { minX: number; maxX: number; minY: number; maxY: number }, maxZoom: number, smoothMs: number): CameraCue {
  const { width: w, height: h } = ctx.viewport;
  const left = 0.3 * w, right = 0.8 * w, top = 0.12 * h, bottom = 0.62 * h;
  const zoom = Math.min(maxZoom, (0.85 * (bottom - top)) / (b.maxY - b.minY), (0.85 * (right - left)) / (b.maxX - b.minX));
  // The camera centre sits that far left of and below the band's centre (game Y is up).
  const cx = (b.minX + b.maxX) / 2 - ((left + right) / 2 - w / 2) / zoom;
  const cy = (b.minY + b.maxY) / 2 - (h / 2 - (top + bottom) / 2) / zoom;
  return hold(cx, cy, zoom, smoothMs);
}

/**
 * Shot A2: the same room, the pilot in a missile frigate (the largest
 * sub-capital a player can fly), parked where the cruiser was. A heavy beam's
 * kill leaves no piece big enough to drift, so the frigate is vaporised
 * (fracture v11): a violet flash and an ash puff, and one salvage pod beside
 * the kill point, off the beam's line. Its 5" secondaries hit it too; if one
 * of them lands the kill the frigate dies the ordinary way (logged).
 * Wide on both ships at first, then a close hold on the frigate so the beam
 * crosses the frame and the flash reads; at the kill (the pilot's hull leaves
 * its mirror: an observation, no test cue) the camera frames the kill point
 * and, once it shows, the pod.
 */
export const beamVaporiseSubcap: Shot = {
  id: 'beam-vaporise-subcap',
  section: 'mechanics',
  title: 'Heavy beam vaporises a frigate',
  caption: 'A heavy beam burns a missile frigate away; it leaves a salvage crate to collect.',
  features: ['CAP'],
  docs: ['capital-destruction', 'capital-ships'],
  reel: false,
  server: 'capitals',
  target: { room: 'showcase-beam-slice', params: { shipKind: 'missile-frigate', art: 'machined', fx: 'new', spawnX: SUBCAP_SPAWN_X, spawnY: 0 } },
  hud: 'none',
  durationMs: 75_000,
  endsWithRun: true,
  async startWhen(ctx) {
    await sceneReady(ctx, 1);
    const me = await localPose(ctx);
    if (me) parked.set(ctx.testId, { x: me.x, y: me.y });
    await sendRoom(ctx, 'test_aggro', { type: 'test_aggro' });
    await ctx.spectate();
  },
  async run(ctx) {
    const k = ctx.viewport.width / 1920;
    const t0 = Date.now();
    let me = parked.get(ctx.testId) ?? { x: SUBCAP_SPAWN_X, y: 0 };
    parked.delete(ctx.testId);
    const bc = (await npcPoses(ctx))['battlecruiser-lance'] ?? { x: 0, y: 0 };
    // Wide: the battlecruiser and the frigate, wherever they are now.
    const x0 = Math.min(bc.x, me.x) - 2500, x1 = Math.max(bc.x, me.x) + 1500;
    await ctx.cinema.play([hold((x0 + x1) / 2, (bc.y + me.y) / 2, (1920 / (x1 - x0)) * k, 0)]);
    // Watch the pilot's hull; its last pose is the kill point.
    let settled = false;
    let seen = false;
    let at = -1;
    while (Date.now() - t0 < 70_000) {
      const p = await ownHull(ctx);
      if (!p) {
        if (seen) { at = Date.now() - t0; break; }
      } else {
        seen = true;
        me = p;
      }
      if (!settled && Date.now() - t0 >= 5000) {
        settled = true;
        // Close on the frigate (the battlecruiser off screen to the left, so
        // the beam comes in across the frame).
        await ctx.cinema.play([holdOnBox(ctx, { minX: me.x - 300, maxX: me.x + 300, minY: me.y - 120, maxY: me.y + 120 }, 3, 2500)]);
      }
      await ctx.sleep(50);
    }
    if (at < 0) { ctx.log('  [beam-vaporise-subcap] the frigate did not die inside the cap'); return; }
    const kill = me;
    ctx.log(`  [beam-vaporise-subcap] frigate down at ${(at / 1000).toFixed(1)}s at (${kill.x.toFixed(0)}, ${kill.y.toFixed(0)})`);
    // Push in on the kill point while the flash and the ash play, then take
    // the pod in with it once it shows.
    await ctx.cinema.play([holdOnBox(ctx, { minX: kill.x - 90, maxX: kill.x + 90, minY: kill.y - 90, maxY: kill.y + 90 }, 3, 900)]);
    let pod: { x: number; y: number; radius: number } | null = null;
    let wreckSeen = false;
    const end = Date.now() + 5500;
    while (Date.now() < end) {
      if (!wreckSeen && (await wreckKinds(ctx)).some((s) => s.startsWith('missile-frigate:'))) {
        wreckSeen = true;
        ctx.log('  [beam-vaporise-subcap] the frigate left a wreck (not vaporised)');
      }
      if (!pod) {
        pod = await podNear(ctx, kill, 600);
        if (pod) {
          const d = Math.hypot(pod.x - kill.x, pod.y - kill.y);
          ctx.log(`  [beam-vaporise-subcap] pod at (${pod.x.toFixed(0)}, ${pod.y.toFixed(0)}), ${d.toFixed(0)} u from the kill point, t=${((Date.now() - t0) / 1000).toFixed(1)}s`);
          const m = 60;
          await ctx.cinema.play([holdOnBox(ctx, {
            minX: Math.min(kill.x, pod.x) - m, maxX: Math.max(kill.x, pod.x) + m,
            minY: Math.min(kill.y, pod.y) - m, maxY: Math.max(kill.y, pod.y) + m,
          }, 3, 900)]);
        }
      }
      await ctx.sleep(100);
    }
    if (!pod) ctx.log('  [beam-vaporise-subcap] no pod near the kill point');
  },
};

/** Where the collateral room puts the pilot's own ship (due south, out of
 *  the enemy capital's reach): `BEAM_COLLATERAL` in showcaseWeaponCutsRooms.ts. */
const COLLATERAL_SPAWN = { x: 0, y: -6000 };

/** The pilot's own lance battlecruiser (an AI-flown hull in the pilot's
 *  mirror, owned by the local player), or null when it is not there. */
async function myCapital(ctx: ShotContext): Promise<{ id: string; x: number; y: number } | null> {
  return ctx.page.evaluate(() => {
    const m = (globalThis as { __eqxClient?: { mirror?: { localPlayerId?: string | null; ships?: Map<string, { x: number; y: number; kind?: string; ownerPlayerId?: string }> } } }).__eqxClient?.mirror;
    const me = m?.localPlayerId;
    let out: { id: string; x: number; y: number } | null = null;
    if (me) m?.ships?.forEach((s, id) => { if (s.ownerPlayerId === me && s.kind === 'battlecruiser-lance') out = { id, x: s.x, y: s.y }; });
    return out;
  }).catch(() => null);
}

/** Game-space pose and wire id of the room's NPC ship of `kind`. */
async function npcOf(ctx: ShotContext, kind: string): Promise<{ wire: string; x: number; y: number } | null> {
  return ctx.page.evaluate((k) => {
    let out: { wire: string; x: number; y: number } | null = null;
    (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number; shipKind?: string; x: number; y: number }> } } }).__eqxClient?.mirror.swarm.forEach((e, n) => {
      if (e.kind === 1 && e.shipKind === k) out = { wire: `swarm-${n}`, x: e.x, y: e.y };
    });
    return out;
  }, kind).catch(() => null);
}

type BeamsOnLog = { lastShooter: string | null; hits: number; killer: string | null };

/** Records, in the page, the shooter of the last beam that hit `wire` and,
 *  from the room's `destroy` event, who killed it (observations of the
 *  room's broadcasts; nothing is sent). */
async function watchBeamsOn(ctx: ShotContext, wire: string): Promise<void> {
  await ctx.page.evaluate((w) => {
    const g = globalThis as { __eqxClient?: { room?: { onMessage(t: string, cb: (e: { shooterId: string; targetId?: string }) => void): void } }; __collateral?: BeamsOnLog };
    const rec: BeamsOnLog = { lastShooter: null, hits: 0, killer: null };
    g.__collateral = rec;
    g.__eqxClient?.room?.onMessage('laser_fired', (e) => { if (e.targetId === w) { rec.lastShooter = e.shooterId; rec.hits++; } });
    g.__eqxClient?.room?.onMessage('destroy', (e) => { if (e.targetId === w) rec.killer = e.shooterId; });
  }, wire);
}

async function beamsOnLog(ctx: ShotContext): Promise<BeamsOnLog> {
  const none: BeamsOnLog = { lastShooter: null, hits: 0, killer: null };
  return ctx.page.evaluate(() => (globalThis as { __collateral?: BeamsOnLog }).__collateral ?? null)
    .then((r) => r ?? none).catch(() => none);
}

/** How long the shot waits for the kill after your capital arrives: the
 *  room's `BEAM_COLLATERAL.killWindowMs` (60 s, asserted at 1x by
 *  beamCollateralKill.test.ts) plus a margin for a busy host. */
const COLLATERAL_WAIT_MS = 75_000;

/**
 * Shot A3, collateral: your lance battlecruiser (AI-flown, Hunt + Aggressive)
 * fights the enemy's lance battlecruiser, and the enemy's missile frigate sits
 * side-on across the line between them (12 km from yours, 7.5 km from the
 * enemy's). Nobody locks or aims at the frigate; your heavy beams, laid on the
 * enemy capital, burn through it on the way. Wide on both capitals while the
 * turrets train, then a hold on the frigate (the beams cross the frame); at
 * the kill (the frigate leaves the mirror or the room's `destroy` names it:
 * observations, no cue) the camera frames the kill point and, once it shows,
 * the salvage pod. Logs the kill time, the killer and whose beam last hit it.
 * No `test_aggro`: the enemy capital is hostile from its spawn, and the
 * frigate must stay out of the fight.
 */
export const beamCollateralSubcap: Shot = {
  id: 'beam-collateral-subcap',
  section: 'mechanics',
  title: 'Heavy beam collateral kill',
  caption: 'Two capitals trade heavy beams; a frigate caught on the line between them is burned away, though nobody was aiming at it.',
  features: ['CAP'],
  docs: ['capital-destruction', 'capital-ships'],
  reel: false,
  server: 'capitals',
  target: { room: 'showcase-beam-collateral', params: { art: 'machined', fx: 'new', spawnX: COLLATERAL_SPAWN.x, spawnY: COLLATERAL_SPAWN.y } },
  hud: 'full',
  durationMs: 100_000,
  endsWithRun: true,
  async startWhen(ctx) {
    // The enemy capital and its frigate, then your capital (the scene's
    // `fleet` step plays on the pilot's ready).
    await sceneReady(ctx, 2);
    await ctx.page.waitForFunction(() => {
      const m = (globalThis as { __eqxClient?: { mirror?: { localPlayerId?: string | null; ships?: Map<string, { kind?: string; ownerPlayerId?: string }> } } }).__eqxClient?.mirror;
      let ok = false;
      m?.ships?.forEach((s) => { if (s.ownerPlayerId === m.localPlayerId && s.kind === 'battlecruiser-lance') ok = true; });
      return ok;
    }, undefined, { timeout: 60_000, polling: 250 });
    const f = await npcOf(ctx, 'missile-frigate');
    if (f) await watchBeamsOn(ctx, f.wire);
    await ctx.spectate();
  },
  async run(ctx) {
    const t0 = Date.now();
    const mine = await myCapital(ctx);
    const enemy = await npcOf(ctx, 'battlecruiser-lance');
    let frig = await npcOf(ctx, 'missile-frigate');
    if (!mine || !enemy || !frig) { ctx.log('  [beam-collateral] scene incomplete; filming anyway'); }
    const a = mine ?? { x: 0, y: 0 }, b = enemy ?? { x: 0, y: 19_500 };
    // Wide: your capital (south), the enemy's (north), the frigate between.
    await ctx.cinema.play([holdOnBox(ctx, {
      minX: Math.min(a.x, b.x) - 2500, maxX: Math.max(a.x, b.x) + 2500,
      minY: Math.min(a.y, b.y) - 1500, maxY: Math.max(a.y, b.y) + 1500,
    }, 3, 0)]);
    let closed = false;
    let at = -1;
    let kill = frig ?? { wire: '', x: 0, y: 0 };
    while (Date.now() - t0 < COLLATERAL_WAIT_MS) {
      frig = await npcOf(ctx, 'missile-frigate');
      // Dead: gone from the mirror, or the room's `destroy` named it.
      if (!frig || (await beamsOnLog(ctx)).killer !== null) { at = Date.now() - t0; break; }
      kill = frig;
      // The fight opens ~9 s after your capital arrives (its turrets lock
      // and train): close in before then.
      if (!closed && Date.now() - t0 >= 4000) {
        closed = true;
        // The frigate, side-on across the frame: the beams come up from your
        // capital (off the bottom of the frame), through it, on toward the
        // enemy capital (off the top).
        await ctx.cinema.play([holdOnBox(ctx, {
          minX: frig.x - 1200, maxX: frig.x + 1200,
          minY: frig.y - 1500, maxY: frig.y + 1500,
        }, 3, 2500)]);
      }
      await ctx.sleep(50);
    }
    if (at < 0) { ctx.log('  [beam-collateral] the frigate did not die inside the cap'); return; }
    const log = await beamsOnLog(ctx);
    const me = await myCapital(ctx);
    const name = (id: string | null, none: string): string => id === null ? none : id === me?.id ? 'your capital' : `another shooter (${id})`;
    ctx.log(`  [beam-collateral] frigate down at ${(at / 1000).toFixed(1)}s at (${kill.x.toFixed(0)}, ${kill.y.toFixed(0)}); killed by ${name(log.killer, 'unknown (no destroy event seen)')}; last beam on it: ${name(log.lastShooter, 'none')}; beam hits on it ${log.hits}`);
    await ctx.cinema.play([holdOnBox(ctx, { minX: kill.x - 120, maxX: kill.x + 120, minY: kill.y - 120, maxY: kill.y + 120 }, 3, 900)]);
    let pod: { x: number; y: number; radius: number } | null = null;
    const end = Date.now() + 6000;
    while (Date.now() < end) {
      if (!pod) {
        pod = await podNear(ctx, kill, 600);
        if (pod) {
          ctx.log(`  [beam-collateral] pod at (${pod.x.toFixed(0)}, ${pod.y.toFixed(0)}), t=${((Date.now() - t0) / 1000).toFixed(1)}s`);
          const m = 60;
          await ctx.cinema.play([holdOnBox(ctx, {
            minX: Math.min(kill.x, pod.x) - m, maxX: Math.max(kill.x, pod.x) + m,
            minY: Math.min(kill.y, pod.y) - m, maxY: Math.max(kill.y, pod.y) + m,
          }, 3, 900)]);
        }
      }
      await ctx.sleep(100);
    }
    if (!pod) ctx.log('  [beam-collateral] no pod near the kill point');
  },
};

/**
 * Shot B: a rail battleship charges its main turrets (the glow on the guns),
 * fires, and the slug kills the pilot's heavy cruiser (a channel cut, white-hot
 * walls, ash) and flies on into the light cruiser holding station behind it,
 * the first ship it does not kill. Recording starts as the first turret
 * begins to charge; wide through the charge and the shot, then the camera
 * closes on the cruiser's wreck. (A destroyer pilot dies to the 5-inch
 * secondaries before the railguns finish training round: filmed 2026-11-15.)
 */
export const railChannel: Shot = {
  id: 'rail-channel',
  section: 'mechanics',
  title: 'Railgun channel',
  caption: 'A rail battleship charges and fires: the slug punches a white-hot channel through a heavy cruiser and flies on until a ship survives it.',
  features: ['CAP'],
  docs: ['capital-destruction', 'capital-ships', 'weapon-mounts'],
  reel: false,
  server: 'capitals',
  target: { room: 'showcase-rail-channel', params: { shipKind: 'heavy-cruiser', art: 'machined', fx: 'new', spawnX: 7000, spawnY: 0 } },
  hud: 'none',
  durationMs: 75_000,
  endsWithRun: true,
  async startWhen(ctx) {
    await sceneReady(ctx, 2);
    const me = await localPose(ctx);
    if (me) parked.set(ctx.testId, { x: me.x, y: me.y });
    await sendRoom(ctx, 'test_aggro', { type: 'test_aggro' });
    await ctx.spectate();
    // Start filming when the first main turret begins to charge (its lock and
    // training run off camera).
    await ctx.page.waitForFunction(() => {
      let on = false;
      (globalThis as { __eqxClient?: { mirror: MirrorView } }).__eqxClient?.mirror.swarm.forEach((e) => { if (e.shipKind === 'battleship-rail' && (e.chargingMask ?? 0) !== 0) on = true; });
      return on;
    }, undefined, { timeout: 90_000, polling: 100 }).catch(() => ctx.log('  [rail-channel] no charge seen in 90 s; filming anyway'));
  },
  async run(ctx) {
    const k = ctx.viewport.width / 1920;
    const t0 = Date.now();
    // Wide: the battleship, the pilot's cruiser and the light cruiser behind
    // it, wherever the fight has put them.
    const npc = await npcPoses(ctx);
    const me = parked.get(ctx.testId) ?? { x: 7000, y: 0 };
    parked.delete(ctx.testId);
    const bs = npc['battleship-rail'] ?? { x: 0, y: 0 };
    const lc = npc['light-cruiser'] ?? { x: 10_000, y: 0 };
    const x0 = Math.min(bs.x, lc.x) - 2000, x1 = Math.max(bs.x, lc.x) + 1200;
    await ctx.cinema.play([hold((x0 + x1) / 2, (bs.y + lc.y + me.y) / 3, (1920 / (x1 - x0)) * k, 0)]);
    let closed = false;
    const at = await watchWrecks(ctx, t0, 70_000,
      (kinds) => kinds.some((s) => s.startsWith('heavy-cruiser:')),
      async (kind) => {
        if (closed || !kind.startsWith('heavy-cruiser:')) return;
        closed = true;
        // Stay wide while the slug flies on (~0.6 s) and stops in the light
        // cruiser, then push in on the cut section (a heavy cruiser is taller
        // than the space above the caption, so frame the channel, not the ship).
        await ctx.sleep(900);
        const c = (await wreckCentre(ctx)) ?? me;
        ctx.log(`  [rail-channel] wreck centre (${c.x.toFixed(0)}, ${c.y.toFixed(0)})`);
        await ctx.cinema.play([hold(c.x, c.y, 0.35 * k, 1400)]);
      });
    ctx.log(`  [rail-channel] ${at < 0 ? 'the cruiser did not die inside the cap' : `cruiser down at ${(at / 1000).toFixed(1)}s`}`);
    if (at >= 0) await ctx.sleep(9000);
  },
};
