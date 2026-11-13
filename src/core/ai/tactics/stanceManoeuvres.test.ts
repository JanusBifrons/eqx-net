/**
 * AI overhaul slice 6b: goal geometry of Orbit, Kite, FallBack and Flee (the
 * interest each writes, its speed, facing mode and boost), plus the utility
 * scores that pick Orbit for turreted roles and Kite for missile boats.
 */
import { describe, it, expect } from 'vitest';
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
  FleeManoeuvre,
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
