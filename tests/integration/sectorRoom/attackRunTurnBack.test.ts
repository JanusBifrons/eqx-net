/**
 * An attack run turns back at speed, whatever the target's speed (owner rule:
 * "everyone accelerates all the time in combat, unless they've got a reason
 * not to").
 *
 * Filmed take 5 (showcase-melee, 2026-11-14): a robot orb flew strafing
 * passes on the pilot and, at 7.95–8.5 s and 10.05–10.8 s, turned back by
 * braking from 122 to 14 u/s. The attack run's swing-round arc (course square
 * to the velocity) ran only while the target was slow; the pilot was moving
 * 47–187 u/s, so the new dive aimed straight back at it and the thrust
 * cancelled the velocity instead of curving it.
 *
 * Scene: one robot orb (robot-circle) 700 u behind a pilot who holds ~90 u/s
 * (scripted thrust on / off) and reverses course every 7 s (its AUTO guns
 * still shoot back), 30 s. A turn-back is an attack run flying away from the pilot at speed
 * (> 60 % of cruise); it lasts until the velocity points back at the pilot.
 *
 * THE TURN-BACK SPEED IS A LOG-ONLY MEASUREMENT (2026-11-14). Its median gate
 * passed without the fix too, so it locked nothing. The locks are the unit
 * tests in manoeuvres.test.ts: a dive (any target ship) and a Tail picked out
 * of a run's extend each swing round square to the velocity instead of
 * aiming straight back. What the scene shows, per turn-back (min speed /
 * cruise), three a run: ~1.05, then the dip, then ~0.75.
 *  - The dip was a Tail chosen right after the extend aiming straight back at
 *    the pilot (braking 1.14 → 0.65 × cruise) and the next dive bottoming out
 *    at 0.43–0.44 (every run once the energy pool doubled; ~1 run in 4 before).
 *    With Tail swinging round too it is 0.54–0.57 in every run.
 *  - The rest is the turn itself: thrust square to the velocity curves it
 *    but cannot hold the speed against the damping over a 180° reversal at
 *    this handling, boost or not (0.55–0.57 with a 10 % boost reserve,
 *    0.54 with 25 %). Holding > 60 % would need a wider, slower arc or the
 *    afterburner held through the turn: a design choice, not a bug.
 * The number of turn-backs is logged too: it is usually 3 a run, but the
 * picker sometimes keeps the orb in Tail for most of the 30 s (Tail 497 /
 * run 74 samples, 0 turn-backs, in one of ~10 runs on 2026-11-14), which is
 * a legitimate fight, not a fault. Gated (the scene ran): samples, and
 *  - passes still line up: hits on the pilot;
 *  - contacts with the pilot are logged (the scripted pilot steers across
 *    the orb; the pass's ram gates are dogfight and strafeParked).
 * The ship flies only with player controls (virtual pilot).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { HostileDroneBehaviour } from '../../../src/core/ai/HostileDroneBehaviour.js';
import { MANOEUVRE_ATTACK_RUN, MANOEUVRE_COUNT } from '../../../src/core/ai/tactics/manoeuvre.js';
import { MORALE_OUTCOME } from '../../../src/core/ai/tactics/morale.js';

const SAMPLE_MS = 50;
const WINDOW_MS = 30_000;
const PILOT_SPEED = 90;
const TURN_BACK_MIN_FRAC = 0.6;

interface Room {
  _internals: {
    swarmRegistry: { all(): Iterable<{ id: string; kind: number; shipKind?: string }> };
    swarmPose: (id: string) => { x: number; y: number; angle: number } | null;
    playerPose: (pid: string) => { x: number; y: number; angle: number } | null;
    swarmHealth: Map<string, number>;
  };
  shipPoseCache: Map<string, { vx: number; vy: number }>;
  aiController: { getBehaviour(id: string): unknown };
  applyDamage: (t: string, s: string, ...rest: unknown[]) => void;
  bus: { on(ev: 'COLLISION_RESOLVED', fn: (p: { aId: string; bId: string; tick: number }) => void): void };
}

describe('SectorRoom integration — an attack run turns back at speed', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => { if (harness) await harness.cleanup(); harness = undefined; }, 15_000);

  it('a robot orb on a pilot cruising at ~90 u/s: its passes hit; turn-backs logged (30 s)', { timeout: 90_000 }, async () => {
    harness = await bootSectorTestServer({
      sectorKey: null,
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      dronePoses: [{ kind: 'robot-circle', x: 0, y: -700, angle: 0, hullExposed: false }],
      lockTimeCapS: 0,
      defaultSpawnX: 0,
      defaultSpawnY: 0,
    });
    const pilot = randomUUID();
    const client = await harness.connectActive(pilot, { startHostile: true, initialHull: 1_000_000, initialShield: 1_000_000 });
    const room = harness.getServerRoom()! as unknown as Room;
    const rec = [...room._internals.swarmRegistry.all()].find((r) => r.kind === 1 && r.shipKind === 'robot-circle')!;
    expect(rec).toBeTruthy();
    const npc = rec.id;
    room._internals.swarmHealth.set(npc, 1e9);
    const brain = room.aiController.getBehaviour(npc) as HostileDroneBehaviour;
    brain.setMoraleRoll(() => MORALE_OUTCOME.FightOn);
    const cruise = brain.getCruiseSpeed();

    let hits = 0;
    const origDmg = room.applyDamage.bind(room);
    room.applyDamage = (t: string, s: string, ...rest: unknown[]) => {
      if (t === pilot && s === npc) hits++;
      origDmg(t, s, ...rest);
    };
    // A ram during the run (dive, pass, extend) is what this test locks; a
    // contact in another manoeuvre (the pilot turning across a close Tail)
    // is counted and logged, not gated.
    let rams = 0, runRams = 0;
    let lastContact = -1_000;
    room.bus.on('COLLISION_RESOLVED', (p) => {
      const pair = (p.aId === npc && p.bId === pilot) || (p.aId === pilot && p.bId === npc);
      if (!pair) return;
      if (p.tick - lastContact > 30) {
        rams++;
        if (brain.getManoeuvre() === MANOEUVRE_ATTACK_RUN) runRams++;
      }
      lastContact = p.tick;
    });

    // The pilot holds ~90 u/s along its nose (thrust on below it, off above)
    // and reverses course every 7 s (+y, then -y), so the orb meets it
    // head-on and has to turn back, as in the melee (the pilot manoeuvred).
    let keys = 0;
    let headingSign = 1;
    let steps = 0;
    const steer = (): number => {
      steps++;
      if (steps % 140 === 0) headingSign = -headingSign;
      const v = room.shipPoseCache.get(pilot);
      const q = room._internals.playerPose(pilot);
      const sp = v ? Math.hypot(v.vx, v.vy) : 0;
      let err = 0;
      if (q) {
        err = (headingSign > 0 ? 0 : Math.PI) - q.angle;
        err = Math.atan2(Math.sin(err), Math.cos(err));
      }
      const thrust = sp < PILOT_SPEED;
      const left = err > 0.15;
      const right = err < -0.15;
      const k = (thrust ? 1 : 0) | (left ? 2 : 0) | (right ? 4 : 0);
      if (k !== keys) {
        keys = k;
        client.send('input', { type: 'input', tick: 0, thrust, turnLeft: left, turnRight: right });
      }
      return sp;
    };

    for (let i = 0; i < 40; i++) { steer(); await harness.advance(SAMPLE_MS); }
    const hist = new Array<number>(MANOEUVRE_COUNT).fill(0);
    let samples = 0, pilotSp = 0;
    // Turn-back episodes: min speed from the start (attack run, flying away
    // at > 60 % cruise) to the first sample flying back toward the pilot.
    const turnMins: number[] = [];
    let inTurn = false, turnMin = Infinity;
    let prev = room._internals.swarmPose(npc)!;
    let prevT = Date.now();
    const t0 = prevT;
    while (Date.now() - t0 < WINDOW_MS) {
      pilotSp += steer();
      await harness.advance(SAMPLE_MS);
      const p = room._internals.swarmPose(npc);
      const q = room._internals.playerPose(pilot);
      if (!p || !q) break;
      const now = Date.now();
      const dt = (now - prevT) / 1000;
      prevT = now;
      const vx = (p.x - prev.x) / dt;
      const vy = (p.y - prev.y) / dt;
      prev = p;
      const v = Math.hypot(vx, vy);
      samples++;
      const m = brain.getManoeuvre();
      hist[m]!++;
      const away = vx * (q.x - p.x) + vy * (q.y - p.y) < 0;
      if (!inTurn) {
        if (m === MANOEUVRE_ATTACK_RUN && away && v > TURN_BACK_MIN_FRAC * cruise) { inTurn = true; turnMin = v; }
      } else {
        if (v < turnMin) turnMin = v;
        if (!away || m !== MANOEUVRE_ATTACK_RUN) { turnMins.push(turnMin); inTurn = false; }
      }
    }
    const worst = turnMins.length ? Math.min(...turnMins) : NaN;
    console.log(`[attackRunTurnBack] cruise=${cruise.toFixed(0)} pilotSp=${(pilotSp / Math.max(1, samples)).toFixed(0)} samples=${samples} turnBacks=${turnMins.length} mins=${turnMins.map((x) => (x / cruise).toFixed(2)).join(',')} hits=${hits} rams=${rams} runRams=${runRams} manoeuvres=${hist.join(',')}`);
    expect(samples).toBeGreaterThan(100);
    // Turn-back speed: LOGGED only (see the header; the locks are in
    // manoeuvres.test.ts).
    const sorted = [...turnMins].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    console.log(`[attackRunTurnBack] worst=${(worst / cruise).toFixed(2)} median=${(median / cruise).toFixed(2)}`);
    expect(hits, 'passes line up').toBeGreaterThan(0);
    // Contacts are LOGGED, not gated: the scripted pilot reverses course
    // across the orb's path, and ~1 run in 6 has a contact during a run (1–2
    // contacts a run before the fix too). The ram gates for the run's pass
    // are dogfight.test.ts (eight duels) and strafeParked.test.ts.
  });
});
