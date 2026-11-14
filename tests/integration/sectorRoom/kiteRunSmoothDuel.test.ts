/**
 * Two filmed AI pilot failures (take 6 of 2026-11-14, owner review):
 *
 *  (a) "why the missile ship isn't flying away from the ship attacking it? …
 *      It should be fleeing in one direction at full speed (as in, to
 *      maintain distance)… Instead it just sort of stays there or slowly
 *      moves in circles." Sampled: the Kite ships backed off nose on in
 *      reverse at ~63 u/s (0.4 × cruise) while robots closed at 130–200 u/s
 *      (gap 580 → 310 u in 9 s), only turned to run below 0.7 × bandMin, and
 *      flipped Kite / Break every 1–2 s; the Robot Hex (heat-seekers, reach
 *      1400 u) dogfought a fighter at ~150 u for 30 s. A missile frigate
 *      attacked by a fighter must now open the gap or hold it at its band on
 *      ≥ 80 % of samples, and run at ≥ 80 % of its cruise while running.
 *
 *  (b) "The fighter is also stupid and jerky in the one fighting the circle."
 *      Sampled: a drone fighter against a Robot Orb switched Tail / AttackRun
 *      / Break 0.63 times a second (against a Robot Cube in the same take:
 *      0.17–0.32), each Tail → AttackRun on a momentary dip of the Orb's speed
 *      under the "slow target" line. Gate: the fighter's manoeuvre switches
 *      and turn-key reversals per second against an Orb stay within the
 *      bars set from the smooth reference duel (fighter vs Robot Cube, the
 *      same scene), logged alongside.
 *
 * Ships fly only with player controls (virtual pilot). Hulls are endless and
 * the morale die is pinned to FightOn: this suite is about steering.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { HostileDroneBehaviour } from '../../../src/core/ai/HostileDroneBehaviour.js';
import { MANOEUVRE_KITE } from '../../../src/core/ai/tactics/manoeuvre.js';
import { MORALE_OUTCOME } from '../../../src/core/ai/tactics/morale.js';
import { roleProfile } from '../../../src/core/ai/tactics/roleProfiles.js';

const SAMPLE_MS = 50;
const SPEED_WINDOW = 4;

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
  await harness.connectAs(randomUUID());
  const room = harness.getServerRoom() as unknown as Room;
  const ids = [...room._internals.swarmRegistry.all()].filter((r) => r.kind === 1).map((r) => r.id);
  for (const id of ids) room._internals.swarmHealth.set(id, 1e9);
  const brains = ids.map((id) => room.aiController.getBehaviour(id) as HostileDroneBehaviour);
  for (const b of brains) b.setMoraleRoll(() => MORALE_OUTCOME.FightOn);
  room.aiController.markHostile(ids[0]!, ids[1]!, room.serverTick);
  room.aiController.markHostile(ids[1]!, ids[0]!, room.serverTick);
  return { harness, room, ids, brains };
}

interface KiteStats { n: number; ok: number; kite: number; running: number; runFast: number; minD: number }

async function kiteScene(harness: SectorTestHarness, room: Room, me: string, foe: string, b: HostileDroneBehaviour, bandMin: number, ms: number): Promise<KiteStats> {
  const kite = (b as unknown as { _kite: { running: boolean } })._kite;
  const cruise = b.getCruiseSpeed();
  await harness.advance(1000);
  const s: KiteStats = { n: 0, ok: 0, kite: 0, running: 0, runFast: 0, minD: Infinity };
  // Speed over the last SPEED_WINDOW samples (200 ms): a 50 ms pose delta
  // is too coarse a clock.
  const hist: Array<{ x: number; y: number; tick: number }> = [];
  let prevD = Infinity;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await harness.advance(SAMPLE_MS);
    const p = room._internals.swarmPose(me);
    const q = room._internals.swarmPose(foe);
    if (!p || !q) break;
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    hist.push({ x: p.x, y: p.y, tick: room.serverTick });
    const back = hist.length > SPEED_WINDOW ? hist[hist.length - 1 - SPEED_WINDOW]! : undefined;
    const dt = back ? (room.serverTick - back.tick) / 60 : 0;
    s.n++;
    // Opens the gap (or holds it: not closing by more than a hair), or sits at
    // or beyond its band.
    if (d >= prevD - 0.5 || d >= bandMin) s.ok++;
    if (b.getManoeuvre() === MANOEUVRE_KITE) s.kite++;
    if (kite.running && back && dt > 0) {
      s.running++;
      if (Math.hypot(p.x - back.x, p.y - back.y) / dt >= 0.8 * cruise) s.runFast++;
    }
    s.minD = Math.min(s.minD, d);
    prevD = d;
  }
  return s;
}

interface DuelStats { seconds: number; switches: number; reversals: number }

async function duelScene(harness: SectorTestHarness, room: Room, b: HostileDroneBehaviour, ms: number): Promise<DuelStats> {
  await harness.advance(1000);
  let m = b.getManoeuvre();
  let switches = 0;
  const rev0 = b.getTurnReversals();
  const tick0 = room.serverTick;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await harness.advance(SAMPLE_MS);
    const now = b.getManoeuvre();
    if (now !== m) { switches++; m = now; }
  }
  return { seconds: (room.serverTick - tick0) / 60, switches, reversals: b.getTurnReversals() - rev0 };
}

describe('SectorRoom integration — a Kite runs when attacked; a fighter fights a Robot Orb smoothly', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => { if (harness) await harness.cleanup(); harness = undefined; }, 15_000);

  it('(a) a missile frigate attacked by a fighter turns and runs: gap opens or holds at its band on >= 80 % of samples, >= 80 % cruise while running', { timeout: 60_000 }, async () => {
    // A fighter coming in from beyond the frigate's band (0.6–1.0 × 1400),
    // nose on: the frigate faces it until it crosses the band edge, then
    // turns and runs. Caught already INSIDE the band nose to nose (1100 u,
    // moraleManoeuvres (a)) the gap still closes for the first ~4 s: a
    // 180° turn takes the frigate ~1.8 s and it tops out ~240 u/s boosting
    // against the fighter's ~270 (openOrHold 0.70 there, logged by hand
    // 2026-11-14; the turn and the top speed are the kinds' own numbers).
    const s = await boot([
      { kind: 'missile-frigate', x: 0, y: 0, angle: 0 },
      { kind: 'patrol-fighter', x: 0, y: 1700, angle: Math.PI },
    ]);
    harness = s.harness;
    const [f, a] = s.ids as [string, string];
    const fb = s.brains[0]!;
    const bandMin = roleProfile('missileBoat').rangeBand.min * fb.getFireRange();
    const k = await kiteScene(harness, s.room, f, a, fb, bandMin, 12_000);
    console.log(`[kite-run frigate] samples=${k.n} openOrHold=${(k.ok / k.n).toFixed(3)} kite=${(k.kite / k.n).toFixed(3)} running=${k.running} fastWhileRunning=${(k.runFast / Math.max(1, k.running)).toFixed(3)} minD=${k.minD.toFixed(0)} bandMin=${bandMin.toFixed(0)}`);
    expect(k.n).toBeGreaterThan(100);
    expect(k.kite / k.n, 'the frigate kites').toBeGreaterThan(0.8);
    expect(k.running, 'attacked, it runs').toBeGreaterThan(20);
    expect(k.ok / k.n, 'the gap opens or holds at the band').toBeGreaterThanOrEqual(0.8);
    expect(k.runFast / k.running, 'running at >= 80 % of cruise').toBeGreaterThanOrEqual(0.8);
  });

  it('(a2) the Robot Hex (heat-seekers) attacked by a fighter kites and runs instead of dogfighting', { timeout: 60_000 }, async () => {
    const s = await boot([
      { kind: 'robot-hexagon', x: 0, y: 0, angle: 0 },
      { kind: 'fighter', x: 0, y: 500, angle: Math.PI },
    ]);
    harness = s.harness;
    const [h, a] = s.ids as [string, string];
    const hb = s.brains[0]!;
    const bandMin = roleProfile('robot').rangeBand.min * hb.getFireRange();
    const k = await kiteScene(harness, s.room, h, a, hb, bandMin, 12_000);
    console.log(`[kite-run hex] samples=${k.n} openOrHold=${(k.ok / k.n).toFixed(3)} kite=${(k.kite / k.n).toFixed(3)} running=${k.running} fastWhileRunning=${(k.runFast / Math.max(1, k.running)).toFixed(3)} minD=${k.minD.toFixed(0)} bandMin=${bandMin.toFixed(0)}`);
    expect(k.kite / k.n, 'the missile robot kites').toBeGreaterThan(0.8);
    expect(k.running, 'attacked, it runs').toBeGreaterThan(20);
    expect(k.ok / k.n, 'the gap opens or holds at the band').toBeGreaterThanOrEqual(0.8);
    expect(k.runFast / k.running, 'running at >= 80 % of cruise').toBeGreaterThanOrEqual(0.8);
  });

  it('(b) a fighter against a Robot Orb flips manoeuvre and turn key no more than against a Robot Cube', { timeout: 120_000 }, async () => {
    const rows: string[] = [];
    const run = async (robot: string): Promise<DuelStats> => {
      const s = await boot([
        { kind: 'fighter', x: 0, y: 0, angle: 0 },
        { kind: robot, x: 0, y: 900, angle: Math.PI },
      ]);
      harness = s.harness;
      const d = await duelScene(harness, s.room, s.brains[0]!, 20_000);
      rows.push(`${robot}: ${d.seconds.toFixed(1)} s, switches/s ${(d.switches / d.seconds).toFixed(2)}, turn reversals/s ${(d.reversals / d.seconds).toFixed(2)}`);
      await harness.cleanup();
      harness = undefined;
      return d;
    };
    const cube = await run('robot-square');
    const orb = await run('robot-circle');
    console.log(`[orb-duel]\n${rows.join('\n')}`);
    expect(cube.seconds).toBeGreaterThan(15);
    expect(orb.seconds).toBeGreaterThan(15);
    // Bars from the smooth reference duel, this scene against a Robot Cube
    // (4 runs, 2026-11-14): manoeuvre switches 0.20–0.50/s (median ~0.38),
    // turn reversals 0.65–1.00/s (median ~0.78). The Orb duel must be no
    // jerkier than that median. Before the fix it ran 0.50 switches and
    // 0.95–1.00 reversals a second here (0.63 switches filmed); after it,
    // 0.25–0.35 and 0.45–0.70.
    expect(orb.switches / orb.seconds, rows.join('\n')).toBeLessThanOrEqual(0.4);
    expect(orb.reversals / orb.seconds, rows.join('\n')).toBeLessThanOrEqual(0.8);
  });
});
