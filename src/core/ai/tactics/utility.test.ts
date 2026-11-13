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

/** dN = dist / R; aspect = targetAspectCos; bearing = threatBearingCos. */
function ctx(dN: number, aspect = 0, bearing = 1, extra: Partial<TacticalContext> = {}): TacticalContext {
  const c = makeTacticalContext();
  c.fireRange = R;
  c.cruiseSpeed = 150;
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
  it('heavy fire from off the bow breaks; from dead ahead it fights back', () => {
    scoreManoeuvres(ctx(0.5, 0, 0, { recentHits: 6 }), FIGHTER, s);
    expect(argmax(s)).toBe(MANOEUVRE_BREAK);
    scoreManoeuvres(ctx(0.5, 0, 1, { recentHits: 6 }), FIGHTER, s);
    expect(argmax(s)).not.toBe(MANOEUVRE_BREAK);
  });
  it('missile boats kite and turreted gunships orbit (slice 6b); a fixed-gun gunship holds', () => {
    for (const dN of [0.5, 1, 2]) {
      scoreManoeuvres(ctx(dN, 0, 1), roleProfile('missileBoat'), s);
      expect(argmax(s), `missileBoat dN=${dN}`).toBe(MANOEUVRE_KITE);
      scoreManoeuvres(ctx(dN, 0, 1, { turretHalfArc: Math.PI / 2 }), roleProfile('gunship'), s);
      expect(argmax(s), `gunship dN=${dN}`).toBe(MANOEUVRE_ORBIT);
      scoreManoeuvres(ctx(dN, 0, 1), roleProfile('gunship'), s);
      expect(argmax(s), `fixed-gun gunship dN=${dN}`).toBe(MANOEUVRE_HOLD);
    }
  });
  it('a pair dogfights, a pack of wingmen holds its ring (keeps its spacing)', () => {
    scoreManoeuvres(ctx(1.4, 0, 1, { allies: 1 }), FIGHTER, s);
    expect(argmax(s)).toBe(MANOEUVRE_ATTACK_RUN);
    scoreManoeuvres(ctx(1.4, 0, 1, { allies: 5 }), FIGHTER, s);
    expect(argmax(s)).toBe(MANOEUVRE_HOLD);
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
