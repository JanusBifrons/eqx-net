/**
 * AI slice 4 follow-up: the dogfight must happen in the fights the game
 * actually has, not only in a markHostile duel.
 *
 * Filmed symptom (2026-11-13, npc-dogfight 3v3 + showcase fleet-melee, hostile
 * review): "drones fly dead straight in parallel lines and trade head-on until
 * someone dies — no tailing, overshoot or break when hit; robots barely move,
 * drift slowly, keep facing the drones, never turn/chase/break even under
 * fire." The slice-4 integration test (`dogfight.test.ts`) passed because it
 * staged a 1v1 between two `fighter`-role ships made hostile with
 * `markHostile`. Real fights are allegiance fights: drones vs robots engaging
 * ON SIGHT, several ships a side, filmed from spectator mode (no pilot near,
 * so the AI runs its LOD decision cadence).
 *
 * This boots the filmed room shape (a `sceneScript` room: drone `fighter`s vs
 * `robot-square`s 1500 u apart, nothing marked hostile, the only pilot far
 * away) and over ~20 s of fight requires the dogfight signatures:
 *  (a) Tail, AttackRun and Break are each flown, and Hold is < 60 % of
 *      combat ship-samples;
 *  (b) the ships turn: mean |angular velocity| while in combat > 0.35 rad/s
 *      (before the fix: 0.21–0.28; nose-on trades and straight jousts);
 *  (c) toe-to-toe (ship and its target both inside 0.7 × fire range and both
 *      slower than 0.25 × cruise) < 20 % of combat ship-samples;
 *  (d) time on a tail (inside fire range, in the target's rear 120° cone, own
 *      nose within ~37° of it) is LOGGED, not asserted: it ranges 0–3.5 s per
 *      20 s run (before the fix the 3v3 scored high only because drones sat
 *      behind parked robots). Sustained tailing is the open follow-up;
 *  (e) the afterburner is lit on > 15 % of combat ship-samples (the energy
 *      pool caps a sustained burn near regen / cost = 25 %).
 * Hulls are endless so the fight lasts the window. Ships fly only with player
 * controls (virtual pilot); nothing here pushes them.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { HostileDroneBehaviour } from '../../../src/core/ai/HostileDroneBehaviour.js';
import {
  MANOEUVRE_ATTACK_RUN,
  MANOEUVRE_BREAK,
  MANOEUVRE_COUNT,
  MANOEUVRE_HOLD,
  MANOEUVRE_TAIL,
} from '../../../src/core/ai/tactics/manoeuvre.js';
import { MORALE_OUTCOME } from '../../../src/core/ai/tactics/morale.js';

const SAMPLE_MS = 50;
const FIGHT_MS = 20_000;
/** A robot that turns slower than a drone `fighter` (0.8 vs 1.0 rad/s at the 2× default; it cruises a little faster), for the tail test. A `robot-square` turns 1.1 rad/s: nothing slower-turning can keep its nose off it, so its six is not holdable. */
const ROBOT_SLOW = 'robot-hexagon';

interface Room {
  _internals: {
    swarmRegistry: { all(): Iterable<{ id: string; kind: number; shipKind?: string }> };
    swarmPose: (id: string) => { x: number; y: number; angle: number } | null;
    swarmHealth: Map<string, number>;
  };
  aiController: { getBehaviour(id: string): unknown };
}

interface FightStats {
  combatSamples: number;
  hist: number[];
  holdFrac: number;
  meanAngvel: number;
  toeFrac: number;
  longestBehindS: number;
  totalBehindS: number;
  /** Share of combat ship-samples with the afterburner lit since the last sample. */
  boostFrac: number;
  minDist: number;
}

function wrap(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

async function fight(harness: SectorTestHarness, perSide: number, label: string): Promise<FightStats> {
  const room = harness.getServerRoom() as unknown as Room;
  // The scene spawns once the pilot is in.
  let ids: string[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 10_000) {
    ids = [...room._internals.swarmRegistry.all()].filter((r) => r.kind === 1).map((r) => r.id);
    if (ids.length >= 2 * perSide) break;
    await harness.advance(50);
  }
  expect(ids.length).toBe(2 * perSide);
  for (const id of ids) room._internals.swarmHealth.set(id, 1e9);
  const brains = new Map(ids.map((id) => [id, room.aiController.getBehaviour(id) as HostileDroneBehaviour]));
  // Endless nerve too (as in dogfight.test.ts): this suite is about the
  // dogfight, and a burst of hits would roll the morale die and a fleeing ship
  // would warp out of it. Morale has its own suite (moraleManoeuvres.test.ts).
  for (const b of brains.values()) b.setMoraleRoll(() => MORALE_OUTCOME.FightOn);

  const hist = new Array<number>(MANOEUVRE_COUNT).fill(0);
  const prev = new Map<string, { x: number; y: number; angle: number }>();
  for (const id of ids) prev.set(id, room._internals.swarmPose(id)!);
  const speed = new Map<string, number>();
  const behindRun = new Map<string, number>();
  let longestBehind = 0;
  let totalBehind = 0;
  let boosting = 0;
  const boostPrev = new Map(ids.map((id) => [id, brains.get(id)!.getBoostTicks()]));
  let combatSamples = 0;
  let angSum = 0;
  let toe = 0;
  let minDist = Infinity;
  let prevT = Date.now();
  const start = prevT;
  while (Date.now() - start < FIGHT_MS) {
    await harness.advance(SAMPLE_MS);
    const now = Date.now();
    const dt = (now - prevT) / 1000;
    prevT = now;
    const pose = new Map<string, { x: number; y: number; angle: number }>();
    const angvel = new Map<string, number>();
    for (const id of ids) {
      const p = room._internals.swarmPose(id);
      if (!p) continue;
      const q = prev.get(id)!;
      pose.set(id, p);
      speed.set(id, Math.hypot(p.x - q.x, p.y - q.y) / dt);
      angvel.set(id, Math.abs(wrap(p.angle - q.angle)) / dt);
      prev.set(id, p);
    }
    for (const id of ids) {
      const brain = brains.get(id)!;
      const tid = brain.getTargetId();
      const p = pose.get(id);
      const tp = tid !== null ? pose.get(tid) : undefined;
      if (!p || !tp || tid === null) { behindRun.set(id, 0); continue; }
      combatSamples++;
      hist[brain.getManoeuvre()]!++;
      const bt = brain.getBoostTicks();
      if (bt > boostPrev.get(id)!) boosting++;
      boostPrev.set(id, bt);
      angSum += angvel.get(id)!;
      const R = brain.getFireRange();
      const cruise = brain.getCruiseSpeed();
      const d = Math.hypot(tp.x - p.x, tp.y - p.y);
      if (d < minDist) minDist = d;
      const tBrain = brains.get(tid);
      const tCruise = tBrain ? tBrain.getCruiseSpeed() : cruise;
      if (d < 0.7 * R && speed.get(id)! < 0.25 * cruise && speed.get(tid)! < 0.25 * tCruise) toe++;
      // On its tail: I am in the target's rear 120° cone, inside fire range,
      // with my nose on it (two ships extending away from each other after
      // a pass are each in the other's rear cone too; they don't count).
      const tfx = -Math.sin(tp.angle);
      const tfy = Math.cos(tp.angle);
      const fx = -Math.sin(p.angle);
      const fy = Math.cos(p.angle);
      const behind = d < R && d > 1
        && (tfx * (p.x - tp.x) + tfy * (p.y - tp.y)) / d < -0.5
        && (fx * (tp.x - p.x) + fy * (tp.y - p.y)) / d > 0.8;
      const run = behind ? (behindRun.get(id) ?? 0) + dt : 0;
      behindRun.set(id, run);
      if (run > longestBehind) longestBehind = run;
      if (behind) totalBehind += dt;
    }
  }
  const stats: FightStats = {
    combatSamples,
    hist,
    holdFrac: hist[MANOEUVRE_HOLD]! / Math.max(1, combatSamples),
    meanAngvel: angSum / Math.max(1, combatSamples),
    toeFrac: toe / Math.max(1, combatSamples),
    longestBehindS: longestBehind,
    totalBehindS: totalBehind,
    boostFrac: boosting / Math.max(1, combatSamples),
    minDist,
  };
  console.log(`[dogfight-on-sight ${label}] R=${[...brains.values()][0]!.getFireRange().toFixed(0)} cruise=${[...brains.values()].map((b) => b.getCruiseSpeed().toFixed(0)).join("/")} samples=${combatSamples} hist(hold,tail,run,break)=${hist.join(',')} holdFrac=${stats.holdFrac.toFixed(2)} meanAngvel=${stats.meanAngvel.toFixed(2)} toeFrac=${stats.toeFrac.toFixed(2)} onTail(longest/total)=${stats.longestBehindS.toFixed(2)}/${stats.totalBehindS.toFixed(2)}s boostFrac=${stats.boostFrac.toFixed(2)} minDist=${minDist.toFixed(0)}`);
  return stats;
}

async function bootScene(perSide: number): Promise<SectorTestHarness> {
  const harness = await bootSectorTestServer({
    sectorKey: null,
    droneCount: 0,
    asteroidConfig: [],
    // The filmed shot spectates: no pilot anywhere near the fight.
    defaultSpawnX: 0,
    defaultSpawnY: -20_000,
    sceneScript: [
      { atMs: 0, action: 'spawn', tag: 'blue', kind: 'fighter', count: perSide, x: -750, y: 0, spread: 150 },
      { atMs: 0, action: 'spawn', tag: 'red', kind: 'robot-square', count: perSide, x: 750, y: 0, spread: 150 },
      { atMs: 120_000, action: 'end' },
    ],
  });
  await harness.connectActive(randomUUID());
  return harness;
}

function expectDogfight(s: FightStats): void {
  expect(s.combatSamples).toBeGreaterThan(200);
  expect(s.hist[MANOEUVRE_TAIL], 'Tail flown').toBeGreaterThan(0);
  expect(s.hist[MANOEUVRE_ATTACK_RUN], 'AttackRun flown').toBeGreaterThan(0);
  expect(s.hist[MANOEUVRE_BREAK], 'Break flown').toBeGreaterThan(0);
  expect(s.holdFrac, 'Hold < 60 % of combat').toBeLessThan(0.6);
  expect(s.meanAngvel, 'ships turn (mean |angvel|, rad/s)').toBeGreaterThan(0.35);
  expect(s.toeFrac, 'not toe to toe').toBeLessThan(0.2);
  expect(s.boostFrac, 'the afterburner is used in the fight').toBeGreaterThan(0.15);
}

describe('SectorRoom integration — on-sight allegiance dogfight (drones vs robots)', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => { if (harness) await harness.cleanup(); harness = undefined; }, 15_000);

  it('1v1 drone fighter vs robot, engaging on sight, dogfights', { timeout: 90_000 }, async () => {
    harness = await bootScene(1);
    expectDogfight(await fight(harness, 1, '1v1'));
  });

  it('a turnier fighter set on a robot\'s six holds the tail', { timeout: 90_000 }, async () => {
    // Six independent pairs, far apart (beyond any sensor range): a drone
    // `fighter` 300 u behind a `robot-hexagon` (turns 0.8 rad/s to the
    // fighter's 1.0), both noses the same way, hostile. The robot breaks and
    // turns; the fighter must stay on its six (within ±45° of the robot's
    // tail, inside 1.2 × fire range). Counted in samples and pooled over the
    // six pairs, so one unlucky pair or a slow host does not decide it (one
    // pair over 20 s ran 3.5–8.4 s on a tail with the fix, 0.95 s without).
    // Before the fix two ships each chasing a station 0.6 × fire range behind
    // the other's velocity flew a circle opposite each other (a Lufbery
    // circle) and never reached a six.
    const PAIRS = 6;
    const poses: Array<{ kind: string; x: number; y: number; angle: number; hullExposed: boolean }> = [];
    for (let k = 0; k < PAIRS; k++) {
      const cx = -25_000 + k * 10_000;
      const cy = 10_000;
      const a = (k * Math.PI) / 3;
      // Nose direction (−sin a, cos a); the fighter sits 300 u behind it.
      poses.push({ kind: 'fighter', x: cx + 300 * Math.sin(a), y: cy - 300 * Math.cos(a), angle: a, hullExposed: false });
      poses.push({ kind: ROBOT_SLOW, x: cx, y: cy, angle: a, hullExposed: false });
    }
    harness = await bootSectorTestServer({
      sectorKey: null,
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      dronePoses: poses,
      defaultSpawnX: 0,
      defaultSpawnY: -20_000,
    });
    await harness.connectAs(randomUUID());
    const room = harness.getServerRoom() as unknown as Room & {
      aiController: { markHostile(id: string, other: string, tick: number): void };
      serverTick: number;
    };
    const recs = [...room._internals.swarmRegistry.all()].filter((x) => x.kind === 1);
    expect(recs.length).toBe(2 * PAIRS);
    const pairs: Array<{ f: string; r: string }> = [];
    for (let k = 0; k < PAIRS; k++) pairs.push({ f: '', r: '' });
    for (const rec of recs) {
      const p = room._internals.swarmPose(rec.id)!;
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < poses.length; i++) {
        if (poses[i]!.kind !== rec.shipKind) continue;
        const d = Math.hypot(poses[i]!.x - p.x, poses[i]!.y - p.y);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (rec.shipKind === 'fighter') pairs[best >> 1]!.f = rec.id; else pairs[best >> 1]!.r = rec.id;
    }
    for (const { f, r } of pairs) {
      expect(f && r).toBeTruthy();
      room._internals.swarmHealth.set(f, 1e9);
      room._internals.swarmHealth.set(r, 1e9);
      room.aiController.markHostile(f, r, room.serverTick);
      room.aiController.markHostile(r, f, room.serverTick);
    }
    const R = (room.aiController.getBehaviour(pairs[0]!.f) as HostileDroneBehaviour).getFireRange();
    const onTail = new Array<number>(PAIRS).fill(0);
    const hist = new Array<number>(MANOEUVRE_COUNT).fill(0);
    let samples = 0;
    const start = Date.now();
    while (Date.now() - start < FIGHT_MS) {
      await harness.advance(SAMPLE_MS);
      samples++;
      for (let k = 0; k < PAIRS; k++) {
        const { f, r } = pairs[k]!;
        const pf = room._internals.swarmPose(f);
        const pr = room._internals.swarmPose(r);
        if (!pf || !pr) continue;
        hist[(room.aiController.getBehaviour(f) as HostileDroneBehaviour).getManoeuvre()]!++;
        const d = Math.hypot(pf.x - pr.x, pf.y - pr.y);
        // cos(robot's tail axis, robot → fighter) ≥ cos 45°.
        const tailX = Math.sin(pr.angle);
        const tailY = -Math.cos(pr.angle);
        if (d > 1 && d < 1.2 * R && (tailX * (pf.x - pr.x) + tailY * (pf.y - pr.y)) / d >= Math.SQRT1_2) onTail[k]!++;
      }
    }
    const frac = onTail.reduce((s, x) => s + x, 0) / Math.max(1, PAIRS * samples);
    console.log(`[dogfight-on-sight tail x${PAIRS}] R=${R.toFixed(0)} samples=${samples} onTailFrac=${frac.toFixed(3)} perPair=${onTail.map((x) => (x / Math.max(1, samples)).toFixed(2)).join(',')} fighter hist(hold,tail,run,break)=${hist.join(',')}`);
    expect(samples).toBeGreaterThan(100);
    expect(frac, 'fighters hold the robots\' six (share of samples, 6 pairs pooled)').toBeGreaterThanOrEqual(0.1);
  });

  it('3v3 drone fighters vs robots (the filmed scene) dogfight', { timeout: 90_000 }, async () => {
    harness = await bootScene(3);
    expectDogfight(await fight(harness, 3, '3v3'));
  });
});
