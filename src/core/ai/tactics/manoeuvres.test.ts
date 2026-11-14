/**
 * AI overhaul slice 4: goal geometry of each dogfight manoeuvre (the
 * interest it writes, its speed, facing mode and boost, and its phases).
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
  makeManoeuvreGoal,
  makeTacticalContext,
  type IManoeuvre,
  type TacticalContext,
} from './manoeuvre.js';
import {
  AttackRunManoeuvre,
  BreakManoeuvre,
  HoldManoeuvre,
  TAIL_BEHIND,
  TAIL_EXTEND_ENTER,
  TAIL_EXTEND_EXIT,
  TailManoeuvre,
} from './manoeuvres.js';

const R = 800;
const CRUISE = 150;
const MAX = 600;
const OVER = 400;

/** A context with self at (sx, sy) and the target at (tx, ty), derived
 *  fields filled the way the brain fills them. */
function ctxAt(sx: number, sy: number, tx: number, ty: number, extra: Partial<TacticalContext> = {}): TacticalContext {
  const c = makeTacticalContext();
  c.fireRange = R; c.cruiseSpeed = CRUISE; c.maxSpeed = MAX; c.overshoot = OVER;
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

/** Run one goal and return the resolved heading. */
function run(m: IManoeuvre, c: TacticalContext): { dirX: number; dirY: number } {
  clearContextMaps(maps);
  m.writeGoal(c, maps, goal);
  const o = resolveContext(maps, steer);
  return { dirX: o.dirX, dirY: o.dirY };
}

describe('HoldManoeuvre (pre-slice-4 stand-off)', () => {
  it('closes along the target line at |along|, AUTO facing', () => {
    const c = ctxAt(0, 0, 0, 1000, { holdAlong: 120, holdBoost: true });
    const d = run(new HoldManoeuvre(), c);
    expect(d.dirY).toBeGreaterThan(0.99);
    expect(goal.speed).toBe(120);
    expect(goal.facing).toBe(FACE_AUTO);
    expect(goal.boost).toBe(true);
  });
  it('backs off (interest away) when along is negative', () => {
    const d = run(new HoldManoeuvre(), ctxAt(0, 0, 0, 300, { holdAlong: -80 }));
    expect(d.dirY).toBeLessThan(-0.99);
    expect(goal.speed).toBe(80);
  });
});

describe('TailManoeuvre', () => {
  it('pursues a point behind the target velocity (its six), led', () => {
    // Target at the origin flying +x; we are far off to the north-west.
    const c = ctxAt(-2000, 1000, 0, 0, { tvx: 100, tvy: 0 });
    const t = new TailManoeuvre();
    run(t, c);
    // Station = target − v̂·0.6R, led by min(2 s, d/cruise) of target motion.
    const sx = -TAIL_BEHIND * R + 100 * 2;
    const want = Math.atan2(0 - 1000, sx + 2000);
    const got = Math.atan2(t.wantVy - 0, t.wantVx - 100);
    expect(Math.abs(got - want)).toBeLessThan(0.05);
    expect(goal.boost).toBe(true); // far: > 1.5 R
    expect(goal.facing).toBe(FACE_MOVE); // out of range
  });
  it('never hovers: at a slow target it circles at a fighting speed', () => {
    // Stationary target 0.6 R north: we sit on its station.
    const c = ctxAt(0, 0, 0, TAIL_BEHIND * R, { vx: 10, vy: 0 });
    const t = new TailManoeuvre();
    const d = run(t, c);
    expect(goal.speed).toBeCloseTo(0.8 * CRUISE, 5);
    // Tangent to the target line (moving across it, not toward / away).
    expect(Math.abs(d.dirY)).toBeLessThan(0.3);
  });
  it('keeps the nose on the lead on the six, flies the course to get there', () => {
    // Target dead ahead in range, flying away along the same line: on its six.
    const c = ctxAt(0, 0, 0, 500, { tvx: 0, tvy: 140 });
    run(new TailManoeuvre(), c);
    expect(goal.facing).toBe(FACE_AIM_LEAD);
    // Out of range: the course.
    const c2 = ctxAt(0, 0, 0, 1.2 * R, { tvx: 140, tvy: 0 });
    run(new TailManoeuvre(), c2);
    expect(goal.facing).toBe(FACE_MOVE);
  });
  it('a parked target looking elsewhere: guns on it in range, not the circle nose-out', () => {
    // A parked pilot has no six; circling it with the nose along the course
    // never fired at it (npcFireLanes, 2026-11-14). Its bow is off me (I sit
    // behind it): nose on the lead in range.
    const t = new TailManoeuvre();
    run(t, ctxAt(0, 0, 0, TAIL_BEHIND * R, { vx: 10, vy: 0, targetBowCos: -1 }));
    expect(goal.facing).toBe(FACE_AIM_LEAD);
    run(t, ctxAt(0, 0, 0, 0.95 * R, { vx: 10, vy: 0, targetBowCos: 0.4 }));
    expect(goal.facing).toBe(FACE_AIM_LEAD);
    // Out of range it still flies its course in.
    run(t, ctxAt(0, 0, 0, 1.2 * R, { vx: 10, vy: 0, targetBowCos: -1 }));
    expect(goal.facing).toBe(FACE_MOVE);
  });
  it('too close to a parked target looking elsewhere: opens out first, then turns the guns on it', () => {
    // After a collision both ships sit nearly stopped and nose-off; turning in
    // place to aim kept them toe to toe for seconds (dogfight 1v1, 2026-11-14).
    const ring = TAIL_BEHIND * R;
    const t = new TailManoeuvre();
    t.begin();
    const d = run(t, ctxAt(0, 0, 0, 0.3 * ring, { vx: 10, vy: 0, targetBowCos: -1 }));
    expect(goal.facing).toBe(FACE_MOVE);
    expect(d.dirY).toBeLessThan(0); // the course opens the range (target is +y)
    expect(goal.speed).toBeCloseTo(0.8 * CRUISE, 5);
    // Still opening between ENTER and EXIT (hysteresis)…
    run(t, ctxAt(0, 0, 0, 0.5 * (TAIL_EXTEND_ENTER + TAIL_EXTEND_EXIT) * ring, { vx: 10, vy: 0, targetBowCos: -1 }));
    expect(goal.facing).toBe(FACE_MOVE);
    // …guns on once past EXIT, and they stay on back inside it.
    run(t, ctxAt(0, 0, 0, 1.05 * TAIL_EXTEND_EXIT * ring, { vx: 10, vy: 0, targetBowCos: -1 }));
    expect(goal.facing).toBe(FACE_AIM_LEAD);
    run(t, ctxAt(0, 0, 0, 0.5 * (TAIL_EXTEND_ENTER + TAIL_EXTEND_EXIT) * ring, { vx: 10, vy: 0, targetBowCos: -1 }));
    expect(goal.facing).toBe(FACE_AIM_LEAD);
  });
  it('a parked target aimed at me: keeps circling (no nose-to-nose stand-off)', () => {
    // Two stopped ships facing each other must not both sit still and trade
    // fire (the toe to toe #565 removed; dogfight 1v1 lost every Break and
    // all but one pass with it, 2026-11-14). Bow on me: fly the circle.
    const t = new TailManoeuvre();
    const d = run(t, ctxAt(0, 0, 0, TAIL_BEHIND * R, { vx: 10, vy: 0, targetBowCos: 1 }));
    expect(goal.facing).toBe(FACE_MOVE);
    expect(Math.abs(d.dirY)).toBeLessThan(0.3);
    // Just inside its arc (~60°) counts; unknown facing (default) counts too.
    run(t, ctxAt(0, 0, 0, TAIL_BEHIND * R, { vx: 10, vy: 0, targetBowCos: 0.55 }));
    expect(goal.facing).toBe(FACE_MOVE);
    run(t, ctxAt(0, 0, 0, TAIL_BEHIND * R, { vx: 10, vy: 0 }));
    expect(goal.facing).toBe(FACE_MOVE);
  });
});

describe('AttackRunManoeuvre (boom-and-zoom)', () => {
  it('dives at the lead with boost, passes beside the target, overshoots, extends, then is done', () => {
    const m = new AttackRunManoeuvre();
    const c = ctxAt(0, -1500, 0, 0, { tick: 100 });
    m.begin(c);
    const d = run(m, c);
    expect(d.dirY).toBeGreaterThan(0.99);
    expect(goal.speed).toBe(MAX);
    expect(goal.boost).toBe(true);
    expect(goal.facing).toBe(FACE_AIM_LEAD);
    expect(m.isDone(c)).toBe(false);

    // Inside the overshoot: pull off for a point half an overshoot to the
    // right of the target line (fixed side with no lateral motion).
    const c2 = ctxAt(0, -OVER + 10, 0, 0, { tick: 200, vx: 0, vy: 300 });
    const p = run(m, c2);
    expect(goal.facing).toBe(FACE_MOVE);
    expect(p.dirX).toBeGreaterThan(0.3); // right of a +y line is +x
    expect(p.dirY).toBeGreaterThan(0);

    // Carried on past the target by more than the overshoot: extend (boost).
    const c3 = ctxAt(OVER * 0.5, OVER * 1.3, 0, 0, { tick: 260 });
    run(m, c3);
    expect(goal.boost).toBe(true);
    expect(m.isDone(c3)).toBe(false);

    // The gap opens past 1.3 × fire range: done.
    const c4 = ctxAt(0, 1.4 * R, 0, 0, { tick: 280 });
    expect(m.isDone(c4)).toBe(true);
  });
  it('gives up a dive that never arrives', () => {
    const m = new AttackRunManoeuvre();
    const c = ctxAt(0, -1500, 0, 0, { tick: 0 });
    m.begin(c);
    expect(m.isDone(ctxAt(0, -1400, 0, 0, { tick: 5 * 60 + 1 }))).toBe(true);
  });
  it('a head-on pair offsets apart, not into each other', () => {
    const a = new AttackRunManoeuvre();
    const b = new AttackRunManoeuvre();
    const ca = ctxAt(-1000, 0, 1000, 0);
    const cb = ctxAt(1000, 0, -1000, 0);
    a.begin(ca);
    b.begin(cb);
    // At pull-off each turns for its miss point; the two y offsets differ in sign.
    const pa = run(a, ctxAt(-150, 0, 150, 0, { tick: 1 }));
    const pb = run(b, ctxAt(150, 0, -150, 0, { tick: 1 }));
    expect(Math.sign(pa.dirY)).not.toBe(0);
    expect(Math.sign(pa.dirY)).toBe(-Math.sign(pb.dirY));
  });
});

describe('BreakManoeuvre', () => {
  it('turns hard across the threat line with boost for a seeded 0.6–1.5 s', () => {
    for (let seed = 1; seed < 20; seed++) {
      const m = new BreakManoeuvre();
      // Threat right behind (−y), we fly +y.
      const c = ctxAt(0, 0, 0, -300, { tick: 1000, angle: 0, vx: 0, vy: 140 });
      c.rng.reseed(seed);
      m.begin(c);
      const d = run(m, c);
      expect(Math.abs(d.dirY)).toBeLessThan(0.1);
      expect(goal.boost).toBe(true);
      expect(goal.facing).toBe(FACE_MOVE);
      expect(goal.speed).toBe(MAX);
      let end = 0;
      for (let t = 1000; t < 1200; t++) {
        c.tick = t;
        if (m.isDone(c)) { end = t - 1000; break; }
      }
      expect(end).toBeGreaterThanOrEqual(36);
      expect(end).toBeLessThanOrEqual(90);
    }
  });
});
