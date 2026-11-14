/**
 * AI overhaul slice 6b: goal geometry of Orbit, Kite, FallBack and Flee (the
 * interest each writes, its speed, facing mode and boost), plus the utility
 * scores that pick Orbit for turreted roles and Kite for missile boats.
 */
import { beforeEach, describe, it, expect } from 'vitest';
import { Rng } from '../../random/rng.js';
import {
  clearContextMaps,
  createContextMaps,
  makeContextOutput,
  resolveContext,
} from '../contextSteering.js';
import {
  FACE_AIM_LEAD,
  FACE_AUTO,
  FACE_MOVE,
  MANOEUVRE_ATTACK_RUN,
  MANOEUVRE_COUNT,
  MANOEUVRE_FALL_BACK,
  MANOEUVRE_FLEE,
  MANOEUVRE_HOLD,
  MANOEUVRE_KITE,
  MANOEUVRE_ORBIT,
  MANOEUVRE_TAIL,
  makeManoeuvreGoal,
  makeTacticalContext,
  type IManoeuvre,
  type TacticalContext,
} from './manoeuvre.js';
import {
  FallBackManoeuvre,
  FLEE_CLEAR_TICKS,
  FLEE_MAX_TICKS,
  EVADE_BREAK_ANGLE,
  EVADE_BREAK_HITS,
  FleeManoeuvre,
  isPursued,
  KiteManoeuvre,
  OrbitManoeuvre,
  orbitOffAngle,
} from './stanceManoeuvres.js';
import { scoreManoeuvres } from './utility.js';
import { roleProfile } from './roleProfiles.js';

const R = 800;
const CRUISE = 150;
const MAX = 600;

function ctxAt(sx: number, sy: number, tx: number, ty: number, extra: Partial<TacticalContext> = {}): TacticalContext {
  const c = makeTacticalContext();
  c.fireRange = R; c.cruiseSpeed = CRUISE; c.maxSpeed = MAX; c.overshoot = 400;
  c.bandMin = 0.6 * R; c.bandMax = 0.9 * R; c.sensorRange = 3 * R;
  c.x = sx; c.y = sy; c.tx = tx; c.ty = ty;
  Object.assign(c, extra);
  const dx = c.tx - c.x;
  const dy = c.ty - c.y;
  c.dist = Math.hypot(dx, dy);
  c.ux = dx / c.dist; c.uy = dy / c.dist;
  c.aimX = c.tx; c.aimY = c.ty;
  c.fwdX = -Math.sin(c.angle); c.fwdY = Math.cos(c.angle);
  c.threatBearingCos = c.fwdX * c.ux + c.fwdY * c.uy;
  c.closing = -((c.tvx - c.vx) * c.ux + (c.tvy - c.vy) * c.uy);
  return c;
}

const maps = createContextMaps();
const steer = makeContextOutput();
const goal = makeManoeuvreGoal();

function run(m: IManoeuvre, c: TacticalContext): { dirX: number; dirY: number } {
  clearContextMaps(maps);
  m.writeGoal(c, maps, goal);
  const o = resolveContext(maps, steer);
  return { dirX: o.dirX, dirY: o.dirY };
}

/** cos of the angle between the resolved heading and the target bearing. */
function cosToTarget(h: { dirX: number; dirY: number }, c: TacticalContext): number {
  return h.dirX * c.ux + h.dirY * c.uy;
}

describe('OrbitManoeuvre', () => {
  it('on the circle a turreted hull flies across the bearing, keeping the target inside its arc', () => {
    const arc = Math.PI / 2;
    const c = ctxAt(0, 0, 0, 0.9 * R, { turretHalfArc: arc });
    const m = new OrbitManoeuvre();
    m.begin(c);
    const h = run(m, c);
    const off = Math.acos(Math.max(-1, Math.min(1, cosToTarget(h, c))));
    expect(off).toBeGreaterThan(Math.PI / 3);
    expect(off).toBeLessThan(arc); // the turret still bears
    expect(goal.facing).toBe(FACE_MOVE);
    expect(goal.speed).toBe(CRUISE);
  });

  it('opens out when inside the circle and closes in when outside it', () => {
    const arc = Math.PI / 2;
    const inside = orbitOffAngle(0.3 * R, 0.9 * R, arc);
    const on = orbitOffAngle(0.9 * R, 0.9 * R, arc);
    const outside = orbitOffAngle(1.6 * R, 0.9 * R, arc);
    expect(inside).toBeGreaterThan(on);
    expect(on).toBeGreaterThan(outside);
    expect(inside).toBeGreaterThan(Math.PI / 2); // heading away from the target
  });

  it('a fixed-forward gun barely leaves the target bearing on the circle', () => {
    expect(orbitOffAngle(0.9 * R, 0.9 * R, 0)).toBe(0);
  });

  it('circles the side it is already sliding to', () => {
    const c = ctxAt(0, 0, 0, 0.9 * R, { turretHalfArc: Math.PI / 2, vx: 100, vy: 0 });
    const m = new OrbitManoeuvre();
    m.begin(c);
    const h = run(m, c);
    expect(h.dirX).toBeGreaterThan(0.3);
  });

  it('boosts back from far out', () => {
    const c = ctxAt(0, 0, 0, 2 * R, { turretHalfArc: Math.PI / 2 });
    const m = new OrbitManoeuvre();
    m.begin(c);
    run(m, c);
    expect(goal.boost).toBe(true);
  });
});

describe('KiteManoeuvre', () => {
  it('backs off nose on when the target is inside the band', () => {
    const c = ctxAt(0, 0, 0, 0.55 * R, { tvy: 0 });
    const m = new KiteManoeuvre();
    m.begin();
    const h = run(m, c);
    expect(m.along).toBeLessThan(0);
    expect(h.dirY).toBeLessThan(-0.9); // moving away along the line
    expect(goal.facing).toBe(FACE_AIM_LEAD);
    expect(goal.speed).toBeGreaterThan(0);
  });

  it('closes when beyond the band and matches a target sitting in the middle', () => {
    const far = ctxAt(0, 0, 0, 1.2 * R);
    const m = new KiteManoeuvre();
    m.begin();
    const h = run(m, far);
    expect(m.along).toBeGreaterThan(0);
    expect(h.dirY).toBeGreaterThan(0.9);
    const mid = ctxAt(0, 0, 0, 0.75 * R, { tvy: 50 });
    run(m, mid);
    expect(m.along).toBeCloseTo(50, 3);
  });

  it('reverses to meet a target that closes on it', () => {
    // Target flying straight at us at 200 u/s from the band's middle.
    const c = ctxAt(0, 0, 0, 0.75 * R, { tvy: -200 });
    const m = new KiteManoeuvre();
    m.begin();
    run(m, c);
    expect(m.along).toBeCloseTo(-200, 3);
    expect(goal.facing).toBe(FACE_AIM_LEAD);
  });

  it('caught deep inside the band by a closing target, turns and runs with boost', () => {
    const c = ctxAt(0, 0, 0, 0.3 * R, { tvy: -200 });
    const m = new KiteManoeuvre();
    m.begin();
    const h = run(m, c);
    expect(m.running).toBe(true);
    expect(goal.facing).toBe(FACE_MOVE);
    expect(goal.boost).toBe(true);
    expect(goal.speed).toBe(MAX);
    expect(h.dirY).toBeLessThan(-0.9);
    // Back at the band: face again.
    run(m, ctxAt(0, 0, 0, 0.65 * R));
    expect(m.running).toBe(false);
    expect(goal.facing).toBe(FACE_AIM_LEAD);
  });
});

describe('FallBackManoeuvre', () => {
  it('heads for the anchor with the nose on the course, boosting from far', () => {
    const c = ctxAt(0, 0, 0, 500, { hasAnchor: true, anchorX: -3 * R, anchorY: 0 });
    const m = new FallBackManoeuvre();
    m.begin();
    const h = run(m, c);
    expect(h.dirX).toBeLessThan(-0.9);
    expect(goal.facing).toBe(FACE_MOVE);
    expect(goal.boost).toBe(true);
    expect(m.arrived).toBe(false);
  });

  it('settles at the anchor and fights from there (AUTO facing, slowing)', () => {
    const c = ctxAt(0, 0, 0, 500, { hasAnchor: true, anchorX: -0.2 * R, anchorY: 0 });
    const m = new FallBackManoeuvre();
    m.begin();
    run(m, c);
    expect(m.arrived).toBe(true);
    expect(goal.facing).toBe(FACE_AUTO);
    expect(goal.speed).toBeLessThan(CRUISE * 0.5);
    expect(goal.boost).toBe(false);
  });

  it('with nobody to fall back on, opens the range from the threat', () => {
    const c = ctxAt(0, 0, 0, 500, { hasAnchor: false, sensorEnemies: 2, threatX: 0, threatY: 600 });
    const m = new FallBackManoeuvre();
    m.begin();
    const h = run(m, c);
    expect(h.dirY).toBeLessThan(-0.9);
  });
});

describe('FleeManoeuvre', () => {
  it('runs straight away from the threat centroid at full speed with boost', () => {
    const c = ctxAt(0, 0, 0, 500, { sensorEnemies: 3, threatX: 400, threatY: 400 });
    const m = new FleeManoeuvre();
    m.begin(c);
    const h = run(m, c);
    expect(h.dirX).toBeLessThan(-0.6);
    expect(h.dirY).toBeLessThan(-0.6);
    expect(m.dirX).toBeCloseTo(-Math.SQRT1_2, 3);
    expect(goal.speed).toBe(MAX);
    expect(goal.boost).toBe(true);
    expect(goal.facing).toBe(FACE_MOVE);
  });

  it('wants to warp out once clear of enemies for 2 s', () => {
    const c = ctxAt(0, 0, 0, 500, { sensorEnemies: 1, threatX: 0, threatY: 500, tick: 100 });
    const m = new FleeManoeuvre();
    m.begin(c);
    run(m, c);
    expect(m.wantsWarpOut(100)).toBe(false);
    c.sensorEnemies = 0; c.tick = 200;
    run(m, c);
    expect(m.wantsWarpOut(200 + FLEE_CLEAR_TICKS - 1)).toBe(false);
    expect(m.wantsWarpOut(200 + FLEE_CLEAR_TICKS)).toBe(true);
    // Seen again: the clock restarts.
    c.sensorEnemies = 2; c.tick = 210;
    run(m, c);
    expect(m.wantsWarpOut(200 + FLEE_CLEAR_TICKS)).toBe(false);
  });

  it('warps out anyway after FLEE_MAX_TICKS', () => {
    const c = ctxAt(0, 0, 0, 500, { sensorEnemies: 3, threatX: 0, threatY: 500, tick: 0 });
    const m = new FleeManoeuvre();
    m.begin(c);
    run(m, c);
    expect(m.wantsWarpOut(FLEE_MAX_TICKS - 1)).toBe(false);
    expect(m.wantsWarpOut(FLEE_MAX_TICKS)).toBe(true);
  });
});

describe('utility: Orbit / Kite by role', () => {
  const s = new Float32Array(MANOEUVRE_COUNT);
  function best(c: TacticalContext, role: Parameters<typeof roleProfile>[0]): number {
    scoreManoeuvres(c, roleProfile(role), s);
    let b = 0;
    for (let i = 1; i < MANOEUVRE_COUNT; i++) if (s[i]! > s[b]!) b = i;
    return b;
  }

  it('a turreted gunship prefers Orbit', () => {
    expect(best(ctxAt(0, 0, 0, 0.8 * R, { turretHalfArc: Math.PI / 2 }), 'gunship')).toBe(MANOEUVRE_ORBIT);
  });

  it('a missile boat prefers Kite', () => {
    expect(best(ctxAt(0, 0, 0, 0.8 * R), 'missileBoat')).toBe(MANOEUVRE_KITE);
  });

  it('a fixed-gun fighter neither orbits nor kites', () => {
    const b = best(ctxAt(0, 0, 0, 0.8 * R, { tvy: 100 }), 'fighter');
    expect(b).not.toBe(MANOEUVRE_ORBIT);
    expect(b).not.toBe(MANOEUVRE_KITE);
    expect([MANOEUVRE_TAIL, MANOEUVRE_HOLD, MANOEUVRE_ATTACK_RUN]).toContain(b);
  });

  it('never scores the morale outcomes', () => {
    scoreManoeuvres(ctxAt(0, 0, 0, 0.8 * R), roleProfile('civilian'), s);
    expect(s[MANOEUVRE_FALL_BACK]).toBe(0);
    expect(s[MANOEUVRE_FLEE]).toBe(0);
  });

  it('a structure target is still held', () => {
    expect(best(ctxAt(0, 0, 0, 0.8 * R, { targetIsShip: false, turretHalfArc: Math.PI / 2 }), 'gunship')).toBe(MANOEUVRE_HOLD);
  });
});

describe('evasive running (Flee / FallBack with a pursuer on the tail)', () => {
  /** One seeded stream across a run's ticks, as the brain's context keeps. */
  let stream = new Rng(42);
  beforeEach(() => { stream = new Rng(42); });
  /** Me at the origin running south (nose (0,-1)), a pursuer `gap` north of
   *  me chasing (its velocity toward me), the threat centroid on it. */
  function chased(tick: number, gap = 300, extra: Partial<TacticalContext> = {}): TacticalContext {
    const c = ctxAt(0, 0, 0, gap, {
      angle: Math.PI, vx: 0, vy: -400, tvx: 0, tvy: -450,
      sensorEnemies: 1, threatX: 0, threatY: gap, tick, ...extra,
    });
    c.targetAspectCos = 1; // flying straight at me
    (c as { rng: Rng }).rng = stream;
    return c;
  }

  it('isPursued: a chaser in my rear cone within reach, not one ahead, far, or parked', () => {
    expect(isPursued(chased(0))).toBe(true);
    expect(isPursued(chased(0, 2 * R))).toBe(false);
    const ahead = chased(0, 300, { angle: 0 });
    expect(isPursued(ahead)).toBe(false);
    const parked = chased(0, 300, { tvx: 0, tvy: 0 });
    expect(isPursued(parked)).toBe(false);
  });

  it('Flee weaves off the escape line (both sides, irregular legs) and burns the reserve', () => {
    const m = new FleeManoeuvre();
    m.begin(chased(0));
    let minOff = 0, maxOff = 0, switches = 0, prevSide = 0;
    const legs: number[] = [];
    let legStart = 0;
    for (let t = 0; t < 600; t++) {
      const c = chased(t);
      const h = run(m, c);
      // Heading angle off straight south, signed.
      const off = Math.atan2(h.dirX, -h.dirY);
      minOff = Math.min(minOff, off); maxOff = Math.max(maxOff, off);
      const side = Math.sign(m.evade.offset);
      if (prevSide !== 0 && side !== prevSide) { switches++; legs.push(t - legStart); legStart = t; }
      prevSide = side;
      expect(goal.boost).toBe(true);
      expect(goal.spendReserve).toBe(true);
      expect(goal.speed).toBe(MAX);
      // Still running away: never more than ~52° off the escape line.
      expect(-h.dirY).toBeGreaterThan(0.55);
    }
    expect(maxOff - minOff, 'weave spread (rad)').toBeGreaterThan(0.8);
    expect(minOff).toBeLessThan(-0.4);
    expect(maxOff).toBeGreaterThan(0.4);
    expect(switches, 'many legs in 10 s').toBeGreaterThan(8);
    expect(new Set(legs).size, 'irregular leg lengths').toBeGreaterThan(3);
    // The escape line (warp-out heading) stays straight away.
    expect(m.dirY).toBeCloseTo(-1, 5);
  });

  it('hit hard from behind, breaks across the line briefly, then resumes the weave', () => {
    const m = new FleeManoeuvre();
    m.begin(chased(0));
    run(m, chased(0));
    expect(m.evade.breaking).toBe(false);
    const hit = chased(1, 300, { recentHits: EVADE_BREAK_HITS + 1 });
    const h = run(m, hit);
    expect(m.evade.breaking).toBe(true);
    expect(Math.abs(m.evade.offset)).toBeCloseTo(EVADE_BREAK_ANGLE, 5);
    expect(Math.abs(h.dirX), 'across the pursuer line').toBeGreaterThan(0.9);
    let t = 2;
    while (m.evade.breaking && t < 200) run(m, chased(t++, 300, { recentHits: EVADE_BREAK_HITS + 1 }));
    expect(t, 'the break is brief (< 1 s)').toBeLessThan(62);
    // Cooldown: still being hit, it weaves rather than breaking again at once.
    run(m, chased(t, 300, { recentHits: EVADE_BREAK_HITS + 1 }));
    expect(m.evade.breaking).toBe(false);
    expect(Math.abs(m.evade.offset)).toBeLessThan(1);
  });

  it('not pursued, Flee runs straight and keeps the combat reserve', () => {
    const m = new FleeManoeuvre();
    const c = ctxAt(0, 0, 0, 500, { sensorEnemies: 3, threatX: 0, threatY: 500 });
    m.begin(c);
    const h = run(m, c);
    expect(h.dirY).toBeLessThan(-0.99);
    expect(goal.spendReserve).toBe(false);
    expect(m.evade.pursued).toBe(false);
  });

  it('warp-out still fires while weaving', () => {
    const m = new FleeManoeuvre();
    m.begin(chased(0));
    for (let t = 0; t < FLEE_MAX_TICKS; t++) run(m, chased(t));
    expect(m.wantsWarpOut(FLEE_MAX_TICKS)).toBe(true);
  });

  it('FallBack weaves toward its friends while pursued, and fights normally once there', () => {
    const m = new FallBackManoeuvre();
    m.begin(chased(0));
    let minOff = 0, maxOff = 0;
    for (let t = 0; t < 300; t++) {
      const c = chased(t, 300, { hasAnchor: true, anchorX: 0, anchorY: -5 * R });
      const h = run(m, c);
      const off = Math.atan2(h.dirX, -h.dirY);
      minOff = Math.min(minOff, off); maxOff = Math.max(maxOff, off);
      expect(goal.boost).toBe(true);
      expect(goal.spendReserve).toBe(true);
      expect(-h.dirY).toBeGreaterThan(0.55);
    }
    expect(maxOff - minOff).toBeGreaterThan(0.8);
    // At the anchor: no weave, AUTO facing.
    const c = chased(400, 300, { hasAnchor: true, anchorX: 0, anchorY: -0.2 * R });
    run(m, c);
    expect(m.arrived).toBe(true);
    expect(goal.spendReserve).toBe(false);
    expect(goal.facing).toBe(FACE_AUTO);
  });

  it('is deterministic per seed', () => {
    const offs = (seed: number): number[] => {
      stream = new Rng(seed);
      const m = new FleeManoeuvre();
      const out: number[] = [];
      m.begin(chased(0));
      for (let t = 0; t < 200; t++) {
        run(m, chased(t));
        out.push(m.evade.offset);
      }
      return out;
    };
    expect(offs(7)).toEqual(offs(7));
    expect(offs(7)).not.toEqual(offs(8));
  });
});
