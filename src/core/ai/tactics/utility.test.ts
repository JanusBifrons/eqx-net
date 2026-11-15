/**
 * AI overhaul slice 4: the utility picker (scores × role weights, +15 %
 * stickiness, minimum commit, attack runs finish, Break overrides, seeded
 * per-ship jitter) and the decision cadence (5 Hz, 2 Hz under AI LOD).
 */
import { describe, it, expect } from 'vitest';
import { Rng } from '../../random/rng.js';
import { roleProfile } from './roleProfiles.js';
import {
  MANOEUVRE_ATTACK_RUN,
  MANOEUVRE_BREAK,
  MANOEUVRE_COUNT,
  MANOEUVRE_HOLD,
  MANOEUVRE_KITE,
  MANOEUVRE_ORBIT,
  MANOEUVRE_TAIL,
  makeTacticalContext,
  PARKED_SPEED_FRAC,
  SLOW_SPEED_FRAC,
  type TacticalContext,
} from './manoeuvre.js';
import {
  BREAK_COOLDOWN_TICKS,
  DECIDE_PERIOD,
  LOD_DECIDE_PERIOD,
  MIN_COMMIT_TICKS,
  ManoeuvrePicker,
  decisionDue,
  isTailed,
  scoreManoeuvres,
} from './utility.js';

const R = 800;
const FIGHTER = roleProfile('fighter');

/** dN = dist / R; aspect = targetAspectCos; bearing = threatBearingCos. The
 *  target flies at 100 u/s (2/3 cruise) unless `extra` says otherwise. */
function ctx(dN: number, aspect = 0, bearing = 1, extra: Partial<TacticalContext> = {}): TacticalContext {
  const c = makeTacticalContext();
  c.fireRange = R;
  c.cruiseSpeed = 150;
  c.tvy = 100;
  c.dist = dN * R;
  c.targetAspectCos = aspect;
  c.threatBearingCos = bearing;
  Object.assign(c, extra);
  return c;
}

function argmax(s: Float32Array): number {
  let b = 0;
  for (let i = 1; i < s.length; i++) if (s[i]! > s[b]!) b = i;
  return b;
}

describe('scoreManoeuvres', () => {
  const s = new Float32Array(MANOEUVRE_COUNT);
  it('a fighter far off dives in (attack run)', () => {
    scoreManoeuvres(ctx(2, 1, 1), FIGHTER, s);
    expect(argmax(s)).toBe(MANOEUVRE_ATTACK_RUN);
  });
  it('a fighter close behind its target tails it', () => {
    scoreManoeuvres(ctx(0.5, -1, 1), FIGHTER, s);
    expect(argmax(s)).toBe(MANOEUVRE_TAIL);
  });
  it('a fighter with a hostile on its six breaks', () => {
    const c = ctx(0.4, 0.8, -0.9);
    expect(isTailed(c)).toBe(true);
    scoreManoeuvres(c, FIGHTER, s);
    expect(argmax(s)).toBe(MANOEUVRE_BREAK);
  });
  it('a ship just passed and flying away is not "tailing" me', () => {
    expect(isTailed(ctx(0.4, -0.9, -0.9))).toBe(false);
  });
  it('a parked ship in my rear cone is not "tailing" me: no Break from circling it', () => {
    // A Tail circling a stopped pilot puts it behind me on every lap; with it
    // counted as tailing, fighters flipped Tail / Break every 0.5–1 s and
    // never fired (npcFireLanes, 2026-11-14). The brain reports aspect 0 for
    // a target under PARKED_SPEED_FRAC × cruise.
    const parked = ctx(0.4, 0, -0.9, { tvx: 0, tvy: 0.5 * PARKED_SPEED_FRAC * 150 });
    expect(isTailed(parked)).toBe(false);
    scoreManoeuvres(parked, FIGHTER, s);
    expect(s[MANOEUVRE_BREAK]).toBe(0);
    // Moving just above the threshold, the same geometry is a threat.
    expect(isTailed(ctx(0.4, 0, -0.9, { tvx: 0, tvy: 1.5 * PARKED_SPEED_FRAC * 150 }))).toBe(true);
    // A parked ship hitting me from behind does not break me either: the
    // strafing run's extend flies out from under its guns (owner 2026-11-14;
    // a heavy-fire Break cut every extend short, strafeParked).
    scoreManoeuvres(ctx(0.4, 0, -0.9, { tvx: 0, tvy: 0, recentHits: 6 }), FIGHTER, s);
    expect(argmax(s)).toBe(MANOEUVRE_ATTACK_RUN);
  });
  it('a parked ship gets strafing runs at any range: no Tail, no Hold (owner 2026-11-14)', () => {
    // "Dive in firing, pass, swing round and come again, like a fighter on a
    // ground target. Always moving." The replaced rule tailed it and held
    // the nose on it: the filmed Robot Orb hovered nose-on at ~380 u.
    for (const role of [FIGHTER, roleProfile('interceptor'), roleProfile('scout')]) {
      for (const dN of [0.1, 0.3, 0.6, 1, 2]) {
        for (const allies of [0, 3]) {
          scoreManoeuvres(ctx(dN, 0, 1, { tvx: 0, tvy: 0, allies }), role, s);
          expect(argmax(s)).toBe(MANOEUVRE_ATTACK_RUN);
          expect(s[MANOEUVRE_TAIL]).toBe(0);
          expect(s[MANOEUVRE_HOLD]).toBe(0);
        }
      }
    }
    // A turreted robot may circle it instead (turrets bear while it circles
    // at cruise): Orbit or a run, never a hold or a tail.
    scoreManoeuvres(ctx(0.4, 0, 1, { tvx: 0, tvy: 0, turretHalfArc: Math.PI / 2 }), roleProfile('robot'), s);
    expect([MANOEUVRE_ORBIT, MANOEUVRE_ATTACK_RUN]).toContain(argmax(s));
    expect(s[MANOEUVRE_TAIL]).toBe(0);
    expect(s[MANOEUVRE_HOLD]).toBe(0);
  });
  it('a slow ship (under SLOW_SPEED_FRAC × my cruise) gets strafing passes, not a tail (2026-11-14)', () => {
    // Close behind a slow target: a run, no Tail, no Hold (as on a parked one).
    const slow = { tvx: 0, tvy: 0.6 * SLOW_SPEED_FRAC * 150 };
    for (const dN of [0.1, 0.3, 0.6, 1, 2]) {
      scoreManoeuvres(ctx(dN, -1, 1, { ...slow, targetBowCos: -1 }), FIGHTER, s);
      expect(argmax(s)).toBe(MANOEUVRE_ATTACK_RUN);
      expect(s[MANOEUVRE_TAIL]).toBe(0);
      expect(s[MANOEUVRE_HOLD]).toBe(0);
    }
    // It can still chase me: tailed by a slow ship still breaks.
    scoreManoeuvres(ctx(0.4, 0.5, -0.9, slow), FIGHTER, s);
    expect(argmax(s)).toBe(MANOEUVRE_BREAK);
    // Just over the line: the duel scoring (a close six is a Tail).
    scoreManoeuvres(ctx(0.3, -1, 1, { tvx: 0, tvy: 1.05 * SLOW_SPEED_FRAC * 150, targetBowCos: -1 }), FIGHTER, s);
    expect(argmax(s)).toBe(MANOEUVRE_TAIL);
  });
  it('a face-off (close, both ships\' guns on each other: a mutual tail) hands off to a pass', () => {
    // Two ships each in Tail on the other end up nose to nose (head-on or
    // side by side), neither on a six: filmed 3v3, 258 → 130 u at half cruise.
    scoreManoeuvres(ctx(0.3, 0, 1, { targetBowCos: 1 }), FIGHTER, s);
    expect(argmax(s)).toBe(MANOEUVRE_ATTACK_RUN);
    expect(s[MANOEUVRE_TAIL]).toBe(0);
    // On its six (its nose points away): Tail.
    scoreManoeuvres(ctx(0.3, -1, 1, { targetBowCos: -1 }), FIGHTER, s);
    expect(argmax(s)).toBe(MANOEUVRE_TAIL);
    // Its guns on me but mine off it (I am turning away): no face-off.
    scoreManoeuvres(ctx(0.3, 0, 0, { targetBowCos: 1 }), FIGHTER, s);
    expect(s[MANOEUVRE_TAIL]).toBeGreaterThan(0);
  });
  it('heavy fire from off the bow breaks; from dead ahead it fights back', () => {
    scoreManoeuvres(ctx(0.5, 0, 0, { recentHits: 6 }), FIGHTER, s);
    expect(argmax(s)).toBe(MANOEUVRE_BREAK);
    scoreManoeuvres(ctx(0.5, 0, 1, { recentHits: 6 }), FIGHTER, s);
    expect(argmax(s)).not.toBe(MANOEUVRE_BREAK);
  });
  it('missile boats kite and turreted gunships orbit (slice 6b); a fixed-gun gunship stands off nose on', () => {
    for (const dN of [0.5, 1, 2]) {
      scoreManoeuvres(ctx(dN, 0, 1), roleProfile('missileBoat'), s);
      expect(argmax(s), `missileBoat dN=${dN}`).toBe(MANOEUVRE_KITE);
      scoreManoeuvres(ctx(dN, 0, 1, { turretHalfArc: Math.PI / 2 }), roleProfile('gunship'), s);
      expect(argmax(s), `gunship dN=${dN}`).toBe(MANOEUVRE_ORBIT);
      // A fixed gun can't bear while it circles, so it keeps its nose on from
      // its band: Hold, or Kite since Hold's stand-off share is scaled by
      // (1 − aggression) (on-sight group fights, 2026-11-13).
      scoreManoeuvres(ctx(dN, 0, 1), roleProfile('gunship'), s);
      expect([MANOEUVRE_HOLD, MANOEUVRE_KITE], `fixed-gun gunship dN=${dN}`).toContain(argmax(s));
    }
  });
  it('a pair dogfights, a pack of wingmen holds its ring (keeps its spacing)', () => {
    scoreManoeuvres(ctx(1.4, 0, 1, { allies: 1 }), FIGHTER, s);
    expect(argmax(s)).toBe(MANOEUVRE_ATTACK_RUN);
    scoreManoeuvres(ctx(1.4, 0, 1, { allies: 5 }), FIGHTER, s);
    expect(argmax(s)).toBe(MANOEUVRE_HOLD);
  });
  it('an even group fight breaks into duels; only surplus wingmen hold', () => {
    // 3v3 on sight (the filmed scene): two wingmen and three enemies near me.
    scoreManoeuvres(ctx(1.4, 0, 1, { allies: 2, enemies: 3 }), FIGHTER, s);
    expect(argmax(s)).toBe(MANOEUVRE_ATTACK_RUN);
    // Six on one pilot: five surplus wingmen hold the ring.
    scoreManoeuvres(ctx(1.4, 0, 1, { allies: 5, enemies: 1 }), FIGHTER, s);
    expect(argmax(s)).toBe(MANOEUVRE_HOLD);
  });
  it('a robot (orbit-weighted, reckless) does not park in a stand-off', () => {
    const ROBOT = roleProfile('robot');
    for (const dN of [0.4, 0.8, 1.2, 2]) {
      scoreManoeuvres(ctx(dN, 0, 1, { allies: 2, enemies: 3 }), ROBOT, s);
      expect(argmax(s), `dN=${dN}`).not.toBe(MANOEUVRE_HOLD);
    }
  });
  it('a fighter in a close turning fight tails even a target facing it', () => {
    scoreManoeuvres(ctx(0.8, 1, 1), FIGHTER, s);
    expect(argmax(s)).toBe(MANOEUVRE_TAIL);
  });
  it('against a structure everyone holds', () => {
    scoreManoeuvres(ctx(2, 0, 1, { targetIsShip: false }), FIGHTER, s);
    expect(argmax(s)).toBe(MANOEUVRE_HOLD);
    expect(s[MANOEUVRE_ATTACK_RUN]).toBe(0);
  });
});

describe('ManoeuvrePicker', () => {
  /** A picker with no jitter (every factor 1). */
  function flat(): ManoeuvrePicker {
    return new ManoeuvrePicker();
  }

  it('sticks with the running manoeuvre unless another is > 15 % better', () => {
    const p = flat();
    p.switchTo(MANOEUVRE_TAIL, 0);
    // Tail ≈ 0.3 + 0.7·0.85 = 0.895; run at dN 1.0 = 0.6·0.75·1.04 = 0.468: tail stays.
    expect(p.decide(ctx(1, -0.85, 1, { tick: 1000 }), FIGHTER, false)).toBe(MANOEUVRE_TAIL);
    // Far off and head-on: run 0.62 vs tail 0.3 (×1.15 = 0.345): switch.
    expect(p.decide(ctx(2, 1, 1, { tick: 1000 }), FIGHTER, false)).toBe(MANOEUVRE_ATTACK_RUN);
  });

  it('honours the minimum commit time, except for a Break', () => {
    const p = flat();
    p.switchTo(MANOEUVRE_TAIL, 1000);
    const early = 1000 + MIN_COMMIT_TICKS - 1;
    expect(p.decide(ctx(2, 1, 1, { tick: early }), FIGHTER, false)).toBe(MANOEUVRE_TAIL);
    expect(p.decide(ctx(2, 1, 1, { tick: 1000 + MIN_COMMIT_TICKS }), FIGHTER, false)).toBe(MANOEUVRE_ATTACK_RUN);
    // Tailed during the commit window: Break wins anyway.
    expect(p.decide(ctx(0.4, 0.8, -0.9, { tick: early }), FIGHTER, false)).toBe(MANOEUVRE_BREAK);
  });

  it('never cuts an attack run short except to break; a finished run may restart', () => {
    const p = flat();
    p.switchTo(MANOEUVRE_ATTACK_RUN, 0);
    // Close behind the target: Tail scores higher, but the run continues.
    expect(p.decide(ctx(0.5, -1, 1, { tick: 5000 }), FIGHTER, false)).toBe(MANOEUVRE_ATTACK_RUN);
    expect(p.decide(ctx(0.4, 0.8, -0.9, { tick: 5000 }), FIGHTER, false)).toBe(MANOEUVRE_BREAK);
    // Done, still far off: another run.
    expect(p.decide(ctx(2, 1, 1, { tick: 5000 }), FIGHTER, true)).toBe(MANOEUVRE_ATTACK_RUN);
  });

  it('strafing a parked ship: each finished run is followed by another, a running Tail gives way', () => {
    const p = flat();
    p.switchTo(MANOEUVRE_ATTACK_RUN, 0);
    // The extend ended close by (0.5 × fire range): another run, not a Tail.
    expect(p.decide(ctx(0.5, 0, -1, { tick: 5000, tvx: 0, tvy: 0 }), FIGHTER, true)).toBe(MANOEUVRE_ATTACK_RUN);
    // A Tail running when its target stops is replaced after the commit time.
    const q = flat();
    q.switchTo(MANOEUVRE_TAIL, 1000);
    expect(q.decide(ctx(0.5, 0, 1, { tick: 1000 + MIN_COMMIT_TICKS, tvx: 0, tvy: 0 }), FIGHTER, false)).toBe(MANOEUVRE_ATTACK_RUN);
  });

  it('no Break straight after one (cooldown), so a tailed ship fights back in between', () => {
    const p = flat();
    p.switchTo(MANOEUVRE_BREAK, 0);
    const tailed = (tick: number): TacticalContext => ctx(0.4, 0.8, -0.9, { tick });
    expect(p.decide(tailed(80), FIGHTER, true)).not.toBe(MANOEUVRE_BREAK);
    p.switchTo(MANOEUVRE_TAIL, 80);
    expect(p.decide(tailed(80 + BREAK_COOLDOWN_TICKS - 1), FIGHTER, false)).not.toBe(MANOEUVRE_BREAK);
    expect(p.decide(tailed(80 + BREAK_COOLDOWN_TICKS), FIGHTER, false)).toBe(MANOEUVRE_BREAK);
  });

  it('per-ship jitter is deterministic per seed and differs between ships', () => {
    const run = (seed: number): number[] => {
      const p = new ManoeuvrePicker();
      p.seed(new Rng(seed));
      p.decide(ctx(1.2, 0.2, 1, { tick: 0 }), FIGHTER, true);
      return [...p.scores];
    };
    expect(run(7)).toEqual(run(7));
    expect(run(7)).not.toEqual(run(8));
    for (const v of run(9)) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('decision cadence', () => {
  it('re-scores at 5 Hz, or 2 Hz under AI LOD, staggered by slot', () => {
    let near = 0;
    let lod = 0;
    for (let t = 0; t < 600; t++) {
      if (decisionDue(t, 7, false)) near++;
      if (decisionDue(t, 7, true)) lod++;
    }
    expect(near).toBe(600 / DECIDE_PERIOD);
    expect(lod).toBe(600 / LOD_DECIDE_PERIOD);
    expect(decisionDue(5, 7, false)).toBe(true);
    expect(decisionDue(0, 7, false)).toBe(false);
  });
});
