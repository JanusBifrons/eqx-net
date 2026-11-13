/**
 * AI overhaul slice 4 (plan composed-harbor §3): the dogfight.
 *
 * Owner complaint (2026-11-13): "Ships don't chase each other or dogfight.
 * They just slug it out toe to toe." Before this slice every NPC fighter flew
 * one stand-off rule: close to 0.6 × fire range, stop, and trade fire nose to
 * nose. This drives two NPC fighters of opposing sides (a drone `fighter` and
 * a Traders `patrol-fighter`, both role `fighter`, marked hostile to each
 * other) in a real room and requires a dogfight:
 *  - merges: the gap closes, the ships pass, open out and come back round
 *    (≥ 2 separate close passes over the 20 s duel: inside 0.15 × fire range,
 *    out past 0.25 ×, in again. Until 2026-11-13 a pass had to open past the
 *    whole fire range, which only a straight-line joust does; the filmed fights
 *    showed that joust as "dead straight lines, trading head-on", and a
 *    turning fight re-merges inside gun range; at the 2× ship
 *    scale a fighter cruises at ~140 u/s, so the first merge from 1500 u alone
 *    takes ~6 s and one run → extend → re-attack cycle ~11 s);
 *  - their speeds vary (stddev > 0.15 × cruise) and both land hits;
 *  - the toe-to-toe regression: both inside 0.7 × fire range AND both nearly
 *    stationary (< 0.25 × cruise speed: the kind's `maxSpeed` is the boost
 *    clamp, ~4× cruise, so a share of it would count a cruising ship as
 *    stopped) less than 20 % of the time;
 *  - a ship with a hostile sitting on its tail breaks within 1 s.
 * Ships fly only with player controls (virtual pilot); nothing here pushes them.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { HostileDroneBehaviour } from '../../../src/core/ai/HostileDroneBehaviour.js';
import {
  MANOEUVRE_ATTACK_RUN,
  MANOEUVRE_BREAK,
} from '../../../src/core/ai/tactics/manoeuvre.js';

const KIND_A = 'fighter';
const KIND_B = 'patrol-fighter';
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
}

async function boot(poses: Array<{ kind: string; x: number; y: number; angle: number }>) {
  const harness = await bootSectorTestServer({
    sectorKey: null,
    droneCount: 0,
    testMode: true,
    asteroidConfig: [],
    dronePoses: poses.map((p) => ({ ...p, hullExposed: false })),
    defaultSpawnX: 0,
    defaultSpawnY: 6000,
  });
  // A PENDING observer creates the room; the AI only targets ACTIVE hulls,
  // so the only fight is A vs B.
  await harness.connectAs(randomUUID());
  const room = harness.getServerRoom() as unknown as Room;
  const recs = [...room._internals.swarmRegistry.all()].filter((r) => r.kind === 1);
  const a = recs.find((r) => r.shipKind === KIND_A)!.id;
  const b = recs.find((r) => r.shipKind === KIND_B)!.id;
  // Endless hull: the duel must last the whole window.
  room._internals.swarmHealth.set(a, 1e9);
  room._internals.swarmHealth.set(b, 1e9);
  room.aiController.markHostile(a, b, room.serverTick);
  room.aiController.markHostile(b, a, room.serverTick);
  const brainA = room.aiController.getBehaviour(a) as HostileDroneBehaviour;
  const brainB = room.aiController.getBehaviour(b) as HostileDroneBehaviour;
  return { harness, room, a, b, brainA, brainB };
}

function stddev(xs: number[]): number {
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / xs.length);
}

describe('SectorRoom integration — NPC dogfight (AI slice 4)', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => { if (harness) await harness.cleanup(); harness = undefined; }, 15_000);

  it('two hostile fighters dogfight: attack runs, varied speed, hits, no toe-to-toe', { timeout: 90_000 }, async () => {
    // 1500 u apart, noses toward each other.
    const s = await boot([
      { kind: KIND_A, x: -750, y: 0, angle: -Math.PI / 2 },
      { kind: KIND_B, x: 750, y: 0, angle: Math.PI / 2 },
    ]);
    harness = s.harness;
    const { room, a, b, brainA, brainB } = s;
    const fireRange = brainA.getFireRange();
    const cruiseA = brainA.getCruiseSpeed();
    const cruiseB = brainB.getCruiseSpeed();
    const hits = { a: 0, b: 0 };
    const orig = room.applyDamage.bind(room);
    room.applyDamage = (t: string, src: string, ...rest: unknown[]) => {
      if (t === b && src === a) hits.a++;
      if (t === a && src === b) hits.b++;
      orig(t, src, ...rest);
    };

    const dists: number[] = [];
    const speedA: number[] = [];
    const speedB: number[] = [];
    const seen = new Set<number>();
    let toeToToe = 0;
    let samples = 0;
    let prevA = room._internals.swarmPose(a)!;
    let prevB = room._internals.swarmPose(b)!;
    let prevT = Date.now();
    const t0 = prevT;
    while (Date.now() - t0 < 20_000) {
      await harness.advance(SAMPLE_MS);
      const pa = room._internals.swarmPose(a);
      const pb = room._internals.swarmPose(b);
      if (!pa || !pb) break;
      const now = Date.now();
      const dt = (now - prevT) / 1000;
      const va = Math.hypot(pa.x - prevA.x, pa.y - prevA.y) / dt;
      const vb = Math.hypot(pb.x - prevB.x, pb.y - prevB.y) / dt;
      prevA = pa; prevB = pb; prevT = now;
      const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
      dists.push(d);
      speedA.push(va);
      speedB.push(vb);
      seen.add(brainA.getManoeuvre());
      seen.add(brainB.getManoeuvre());
      samples++;
      if (d < 0.7 * fireRange && va < 0.25 * cruiseA && vb < 0.25 * cruiseB) toeToToe++;
    }

    // Close passes: dip inside 0.15 × fire range, open past 0.25 ×, dip again.
    let passes = 0;
    let armed = true;
    for (let i = 0; i < dists.length; i++) {
      if (armed && dists[i]! < 0.15 * fireRange) { passes++; armed = false; }
      else if (!armed && dists[i]! > 0.25 * fireRange) armed = true;
    }
    const sdA = stddev(speedA);
    const sdB = stddev(speedB);
    const toeFrac = toeToToe / Math.max(1, samples);
    console.log(`[dogfight] R=${fireRange.toFixed(0)} samples=${samples} passes=${passes} sdA=${sdA.toFixed(0)} sdB=${sdB.toFixed(0)} (cruise ${cruiseA.toFixed(0)}) hits=${JSON.stringify(hits)} toeFrac=${toeFrac.toFixed(3)} minD=${Math.min(...dists).toFixed(0)} maxD=${Math.max(...dists).toFixed(0)} manoeuvres=${[...seen].join(',')} decisions=${brainA.getDecisionCount()}`);

    expect(samples).toBeGreaterThan(100);
    expect(seen.has(MANOEUVRE_ATTACK_RUN), 'an attack run was flown').toBe(true);
    expect(passes, 'pass → open out → re-merge: ≥ 2 separate close passes').toBeGreaterThanOrEqual(2);
    expect(sdA, 'A is not hovering').toBeGreaterThan(0.15 * cruiseA);
    expect(sdB, 'B is not hovering').toBeGreaterThan(0.15 * cruiseB);
    expect(hits.a, 'A lands hits').toBeGreaterThan(0);
    expect(hits.b, 'B lands hits').toBeGreaterThan(0);
    expect(toeFrac, 'not toe to toe').toBeLessThan(0.2);
  });

  it('a ship with a hostile on its tail breaks within 1 s', { timeout: 60_000 }, async () => {
    // B ahead, nose +y (angle 0); A 300 u behind it, nose on B's six.
    const s = await boot([
      { kind: KIND_A, x: 0, y: -300, angle: 0 },
      { kind: KIND_B, x: 0, y: 0, angle: 0 },
    ]);
    harness = s.harness;
    const { brainB } = s;
    const t0 = Date.now();
    let brokeAt = -1;
    while (Date.now() - t0 < 3000) {
      await harness.advance(20);
      if (brainB.getManoeuvre() === MANOEUVRE_BREAK) { brokeAt = Date.now() - t0; break; }
    }
    console.log(`[dogfight] tailed ship broke at ${brokeAt} ms (manoeuvre now ${brainB.getManoeuvre()})`);
    expect(brokeAt, 'B breaks').toBeGreaterThanOrEqual(0);
    expect(brokeAt, 'within 1 s').toBeLessThan(1000);
    // The tailer is not breaking: it has the advantage.
    expect(s.brainA.getManoeuvre()).not.toBe(MANOEUVRE_BREAK);
  });
});
