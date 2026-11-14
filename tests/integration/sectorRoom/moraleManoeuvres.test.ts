/**
 * AI overhaul slice 6b (plan composed-harbor §3): Kite and the morale die in a
 * real room, ships flown only by the virtual pilot.
 *
 *  (a) A missile frigate kites a fighter that closes on it: it stays on Kite,
 *      and while the fighter presses it, it opens the gap (the band share is
 *      logged: a fighter on its tail out-runs it).
 *  (b) A fighter at 20 % hull with three friends near, its die forced to
 *      FallBack, heads for its friends (the gap to their centroid shrinks).
 *  (c) The same fighter alone against three enemies, its die forced to Flee,
 *      runs from them and warps out (the room's NPC warp, `BOT_WARP`).
 *
 * The roll is forced through the brain's `setMoraleRoll` test seam; the
 * trigger is real (hull at 20 % crosses the 25 % threshold).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { HostileDroneBehaviour } from '../../../src/core/ai/HostileDroneBehaviour.js';
import { MANOEUVRE_FALL_BACK, MANOEUVRE_FLEE, MANOEUVRE_KITE } from '../../../src/core/ai/tactics/manoeuvre.js';
import { MORALE_OUTCOME } from '../../../src/core/ai/tactics/morale.js';
import { roleProfile } from '../../../src/core/ai/tactics/roleProfiles.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';

const SAMPLE_MS = 50;

interface Room {
  _internals: {
    swarmRegistry: { all(): Iterable<{ id: string; kind: number; shipKind?: string }> };
    swarmPose: (id: string) => { x: number; y: number; angle: number } | null;
    swarmHealth: Map<string, number>;
  };
  aiController: {
    markHostile(id: string, other: string, tick: number): void;
    getBehaviour(id: string): unknown;
  };
  serverTick: number;
  applyDamage: (t: string, s: string, ...rest: unknown[]) => void;
  botWarpPhase(id: string): number;
}

async function boot(poses: Array<{ kind: string; x: number; y: number; angle: number }>) {
  const harness = await bootSectorTestServer({
    sectorKey: null,
    droneCount: 0,
    testMode: true,
    asteroidConfig: [],
    dronePoses: poses.map((p) => ({ ...p, hullExposed: false })),
    defaultSpawnX: 0,
    defaultSpawnY: 9000,
  });
  // A PENDING observer creates the room; the AI only targets ACTIVE hulls.
  await harness.connectAs(randomUUID());
  const room = harness.getServerRoom() as unknown as Room;
  // Registry order = pose order.
  const ids = [...room._internals.swarmRegistry.all()].filter((r) => r.kind === 1).map((r) => r.id);
  return { harness, room, ids };
}

function brain(room: Room, id: string): HostileDroneBehaviour {
  return room.aiController.getBehaviour(id) as HostileDroneBehaviour;
}

describe('SectorRoom integration — Kite and the morale die (AI slice 6b)', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => { if (harness) await harness.cleanup(); harness = undefined; }, 15_000);

  it('(a) a missile frigate kites a closing fighter: nose on, backing off, running when caught', { timeout: 60_000 }, async () => {
    // Frigate (drones) at the origin; a Traders patrol fighter 1100 u off,
    // nose on, closing.
    const s = await boot([
      { kind: 'missile-frigate', x: 0, y: 0, angle: 0 },
      { kind: 'patrol-fighter', x: 0, y: 1100, angle: Math.PI },
    ]);
    harness = s.harness;
    const { room } = s;
    const [f, b] = s.ids as [string, string];
    room._internals.swarmHealth.set(f, 1e9);
    room._internals.swarmHealth.set(b, 1e9);
    room.aiController.markHostile(f, b, room.serverTick);
    room.aiController.markHostile(b, f, room.serverTick);
    const fb = brain(room, f);
    // This is the Kite test. The fighter's hits are a real burst (20 % of the
    // frigate's hull in 2 s) and roll the die, and a FallBack is not a Kite:
    // keep morale out of it; (b) and (c) cover the die. (Before 2026-11-14
    // the die was live here: the band held only because the FIGHTER's die
    // came up FallBack and it left; with both on FightOn, #564 alone held the
    // band on 34 % of samples.)
    fb.setMoraleRoll(() => MORALE_OUTCOME.FightOn);
    brain(room, b).setMoraleRoll(() => MORALE_OUTCOME.FightOn);
    const R = fb.getFireRange();
    const band = roleProfile('missileBoat').rangeBand;
    const lo = band.min * R * 0.8;
    const hi = band.max * R * 1.2;
    // Let the fighter's first approach start, then sample 12 s.
    await harness.advance(1000);
    let inBand = 0, n = 0, kite = 0, minD = Infinity, maxD = 0;
    // Samples with the fighter inside the band edge and closing, and how many
    // of them the frigate spent opening the gap (moving away from it).
    let pressed = 0, opening = 0;
    let prevF = room._internals.swarmPose(f)!;
    let prevD = Infinity;
    const t0 = Date.now();
    while (Date.now() - t0 < 12_000) {
      await harness.advance(SAMPLE_MS);
      const pf = room._internals.swarmPose(f);
      const pb = room._internals.swarmPose(b);
      if (!pf || !pb) break;
      const d = Math.hypot(pf.x - pb.x, pf.y - pb.y);
      n++;
      if (d >= lo && d <= hi) inBand++;
      if (fb.getManoeuvre() === MANOEUVRE_KITE) kite++;
      if (d <= hi && d < prevD) {
        pressed++;
        // The frigate's own motion along fighter → frigate.
        if ((pf.x - prevF.x) * (pf.x - pb.x) + (pf.y - prevF.y) * (pf.y - pb.y) > 0) opening++;
      }
      prevF = pf;
      prevD = d;
      minD = Math.min(minD, d); maxD = Math.max(maxD, d);
    }
    const frac = inBand / Math.max(1, n);
    console.log(`[kite] R=${R.toFixed(0)} band=[${lo.toFixed(0)}, ${hi.toFixed(0)}] samples=${n} inBand=${frac.toFixed(3)} kite=${(kite / Math.max(1, n)).toFixed(3)} opening=${opening}/${pressed} minD=${minD.toFixed(0)} maxD=${maxD.toFixed(0)}`);
    expect(n).toBeGreaterThan(100);
    expect(kite / n, 'the frigate kites').toBeGreaterThan(0.8);
    // A fighter on its tail out-runs and out-turns a frigate (fighter top
    // speed ~600 u/s vs ~420, turn 1 vs 0.4 rad/s, frigate reverse ~40 u/s),
    // so no Kite holds the band against one: the band share is logged, not
    // asserted. What Kite does control: while the fighter presses it, it
    // opens the gap (reverses nose on, or turns and runs once caught).
    expect(pressed, 'the fighter presses the frigate (the scene works)').toBeGreaterThan(20);
    expect(opening / pressed, 'pressed, the frigate opens the gap').toBeGreaterThanOrEqual(0.8);
  });

  it('(b) a 20 %-hull fighter with friends near, forced FallBack, falls back toward them', { timeout: 60_000 }, async () => {
    // Me at the origin; an enemy patrol fighter 900 u north; three friendly
    // fighters 1600 u south-west.
    const s = await boot([
      { kind: 'fighter', x: 0, y: 0, angle: 0 },
      { kind: 'patrol-fighter', x: 0, y: 900, angle: Math.PI },
      { kind: 'fighter', x: -1200, y: -1000, angle: 0 },
      { kind: 'fighter', x: -1350, y: -1150, angle: 0 },
      { kind: 'fighter', x: -1050, y: -1150, angle: 0 },
    ]);
    harness = s.harness;
    const { room } = s;
    const [me, enemy, ...friends] = s.ids as [string, string, ...string[]];
    const mb = brain(room, me);
    mb.setMoraleRoll(() => MORALE_OUTCOME.FallBack);
    room._internals.swarmHealth.set(me, 0.2 * getShipKind('fighter').maxHealth);
    room._internals.swarmHealth.set(enemy, 1e9);
    for (const id of friends) room._internals.swarmHealth.set(id, 1e9);
    // Keep the test about steering: hits on me never land (hull stays 20 %).
    const orig = room.applyDamage.bind(room);
    room.applyDamage = (t: string, src: string, ...rest: unknown[]) => { if (t !== me) orig(t, src, ...rest); };
    room.aiController.markHostile(me, enemy, room.serverTick);
    room.aiController.markHostile(enemy, me, room.serverTick);

    const centroidGap = (): number => {
      const p = room._internals.swarmPose(me)!;
      let cx = 0, cy = 0;
      for (const id of friends) { const q = room._internals.swarmPose(id)!; cx += q.x; cy += q.y; }
      return Math.hypot(p.x - cx / friends.length, p.y - cy / friends.length);
    };
    const d0 = centroidGap();
    let fellBack = false;
    let dMin = d0;
    const t0 = Date.now();
    while (Date.now() - t0 < 10_000) {
      await harness.advance(SAMPLE_MS);
      if (mb.getManoeuvre() === MANOEUVRE_FALL_BACK) fellBack = true;
      dMin = Math.min(dMin, centroidGap());
    }
    const d1 = centroidGap();
    console.log(`[fallback] d0=${d0.toFixed(0)} dMin=${dMin.toFixed(0)} d1=${d1.toFixed(0)} outcome=${mb.getLastMoraleOutcome()} manoeuvre=${mb.getManoeuvre()}`);
    expect(mb.getLastMoraleOutcome()).toBe(MORALE_OUTCOME.FallBack);
    expect(fellBack, 'ran FALL_BACK').toBe(true);
    expect(dMin, 'closer to its friends').toBeLessThan(0.7 * d0);
  });

  it('(c) the same fighter alone vs three enemies, forced Flee, runs and warps out', { timeout: 60_000 }, async () => {
    const s = await boot([
      { kind: 'fighter', x: 0, y: 0, angle: 0 },
      { kind: 'patrol-fighter', x: -300, y: 900, angle: Math.PI },
      { kind: 'patrol-fighter', x: 0, y: 1000, angle: Math.PI },
      { kind: 'patrol-fighter', x: 300, y: 900, angle: Math.PI },
    ]);
    harness = s.harness;
    const { room } = s;
    const [me, ...enemies] = s.ids as [string, ...string[]];
    const mb = brain(room, me);
    mb.setMoraleRoll(() => MORALE_OUTCOME.Flee);
    room._internals.swarmHealth.set(me, 0.2 * getShipKind('fighter').maxHealth);
    const orig = room.applyDamage.bind(room);
    room.applyDamage = (t: string, src: string, ...rest: unknown[]) => { if (t !== me) orig(t, src, ...rest); };
    for (const e of enemies) {
      room._internals.swarmHealth.set(e, 1e9);
      room.aiController.markHostile(me, e, room.serverTick);
      room.aiController.markHostile(e, me, room.serverTick);
    }

    const p0 = room._internals.swarmPose(me)!;
    let fled = false, warpPhaseSeen = 0, warpAtMs = -1, minYWhileFleeing = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 16_000) {
      await harness.advance(SAMPLE_MS);
      const p = room._internals.swarmPose(me);
      if (!p) break;
      if (mb.getManoeuvre() === MANOEUVRE_FLEE) { fled = true; minYWhileFleeing = Math.min(minYWhileFleeing, p.y - p0.y); }
      const ph = room.botWarpPhase(me);
      if (ph !== 0) { warpPhaseSeen = Math.max(warpPhaseSeen, ph); if (warpAtMs < 0) warpAtMs = Date.now() - t0; }
      if (warpPhaseSeen >= 2 && ph === 0) break;
    }
    const p1 = room._internals.swarmPose(me)!;
    const moved = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    console.log(`[flee] fled=${fled} minDy=${minYWhileFleeing.toFixed(0)} warpAt=${warpAtMs}ms phase=${warpPhaseSeen} moved=${moved.toFixed(0)} warpOuts=${mb.getWarpOutCount()} sensor=${mb.getSensorRange().toFixed(0)}`);
    expect(mb.getLastMoraleOutcome()).toBe(MORALE_OUTCOME.Flee);
    expect(fled, 'ran FLEE').toBe(true);
    expect(minYWhileFleeing, 'ran away from the enemies (they sit north)').toBeLessThan(-150);
    expect(mb.getWarpOutCount(), 'asked to warp out once').toBe(1);
    expect(warpAtMs, 'the room started its warp').toBeGreaterThanOrEqual(0);
    expect(warpAtMs, 'within ~8 s of the fight').toBeLessThan(9000);
    expect(warpPhaseSeen, 'it ran (left the fight)').toBeGreaterThanOrEqual(2);
    expect(moved, 'far from where it fled').toBeGreaterThan(2 * mb.getSensorRange());
  });
});
