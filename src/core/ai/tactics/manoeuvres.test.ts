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
  runOpenDist,
  runPullDist,
  STRAFE_EXTEND_OVERSHOOTS,
  STRAFE_MISS_OVERSHOOTS,
  TAIL_BEHIND,
  TAIL_BEHIND_CLOSE,
  TAIL_CLOSE_MIN_RADII,
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
  it('the close station is never formation range: max(0.3 × fire range, 6 own radii) behind', () => {
    // Before: 0.1 × fire range (~3 radii), reached at matched speed: a fighter
    // sat at 92–94 u behind a pilot at 93 u/s (filmed melee, 2026-11-14).
    for (const radius of [10, 60]) {
      const station = Math.max(TAIL_BEHIND_CLOSE * R, TAIL_CLOSE_MIN_RADII * radius);
      // Matched speed on the target's six: closer than the station drops
      // back, farther closes, on it holds the target's speed.
      for (const [gap, sign] of [[0.6 * station, -1], [station, 0], [1.4 * station, 1]] as const) {
        const t = new TailManoeuvre();
        run(t, ctxAt(0, -gap, 0, 0, { tvx: 0, tvy: 130, vx: 0, vy: 130, radius, angle: 0 }));
        if (sign === 0) expect(Math.abs(t.wantVy - 130)).toBeLessThan(1);
        else expect(Math.sign(t.wantVy - 130)).toBe(sign);
      }
    }
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
  it('a Tail whose target stops circles it at fighting speed: no nose-on hold (owner 2026-11-14)', () => {
    // The replaced rule held the nose on a parked target looking elsewhere:
    // the filmed Robot Orb hovered nose-on at ~380 u, creeping, for 20 s.
    // Whatever the target faces, a Tail on a parked ship keeps flying the
    // circle at 0.8 × cruise, nose along the course while it runs across the
    // target line.
    for (const targetBowCos of [-1, 0.4, 1]) {
      for (const dist of [0.2 * TAIL_BEHIND * R, TAIL_BEHIND * R, 0.95 * R]) {
        const t = new TailManoeuvre();
        t.begin();
        const d = run(t, ctxAt(0, 0, 0, dist, { vx: 10, vy: 0, targetBowCos }));
        expect(goal.speed).toBeCloseTo(0.8 * CRUISE, 5);
        // The course runs round the target, not at it (the nose follows it
        // unless it runs within 60° of the target line).
        expect(d.dirY).toBeLessThan(0.75);
      }
    }
  });
});

/** A target flying away along +y at 130 u/s (over the slow line, 0.5 ×
 *  cruise): the duel run, not a strafe. */
const MOVING = { tvx: 0, tvy: 130 };

describe('AttackRunManoeuvre (boom-and-zoom)', () => {
  it('dives beside the lead with boost, passes beside the target, overshoots, extends, then is done', () => {
    const m = new AttackRunManoeuvre();
    const c = ctxAt(0, -1500, 0, 0, { tick: 100, ...MOVING });
    m.begin(c);
    const d = run(m, c);
    expect(d.dirY).toBeGreaterThan(0.99);
    expect(goal.speed).toBe(MAX);
    expect(goal.boost).toBe(true);
    // Nose along the course to the miss point (a nose on the lead flies the
    // dive into the target: a ship thrusts only along its nose).
    expect(goal.facing).toBe(FACE_MOVE);
    expect(m.isDone(c)).toBe(false);

    // Inside the overshoot: pull off for a point 2.5 hull radii (here half an overshoot) to the
    // right of the target line (fixed side with no lateral motion).
    const c2 = ctxAt(0, -OVER + 10, 0, 0, { tick: 200, vx: 0, vy: 300, radius: 80, ...MOVING });
    const p = run(m, c2);
    expect(goal.facing).toBe(FACE_MOVE);
    expect(p.dirX).toBeGreaterThan(0.3); // right of a +y line is +x
    expect(p.dirY).toBeGreaterThan(0);

    // Carried on past the target by more than the overshoot: extend (boost).
    const c3 = ctxAt(OVER * 0.5, OVER * 1.3, 0, 0, { tick: 260, ...MOVING });
    run(m, c3);
    expect(goal.boost).toBe(true);
    expect(m.isDone(c3)).toBe(false);

    // The gap opens past 1.3 × fire range: done.
    const c4 = ctxAt(0, 1.4 * R, 0, 0, { tick: 280, ...MOVING });
    expect(m.isDone(c4)).toBe(true);
  });
  it('gives up a dive that never arrives (1.1 × the time to cover the gap at cruise, at least 5 s)', () => {
    const m = new AttackRunManoeuvre();
    const c = ctxAt(0, -1500, 0, 0, { tick: 0 });
    m.begin(c);
    const limit = Math.round(((1.1 * 1500) / CRUISE) * 60);
    expect(m.isDone(ctxAt(0, -1400, 0, 0, { tick: limit - 1 }))).toBe(false);
    expect(m.isDone(ctxAt(0, -1400, 0, 0, { tick: limit + 1 }))).toBe(true);
    // Just outside the pass distance (here the overshoot): a dive at once.
    const near = new AttackRunManoeuvre();
    near.begin(ctxAt(0, -(OVER + 50), 0, 0, { tick: 0 }));
    expect(near.diving).toBe(true);
    expect(near.isDone(ctxAt(0, -1400, 0, 0, { tick: 5 * 60 + 1 }))).toBe(true);
  });
  it('pulls off earlier the faster it closes and the slower it turns (the kind handling)', () => {
    const base = ctxAt(0, -1500, 0, 0, { vy: 200, maxAngvel: 1, radius: 24 });
    const fast = ctxAt(0, -1500, 0, 0, { vy: 930, maxAngvel: 1, radius: 24, ...MOVING });
    const agile = ctxAt(0, -1500, 0, 0, { vy: 930, maxAngvel: 3, radius: 24, ...MOVING });
    // Never later than the overshoot.
    expect(runPullDist(base)).toBe(OVER);
    // 800 u/s × (π/4 rad / 1 rad/s) + 2.5 radii ≈ 688 u.
    expect(runPullDist(fast)).toBeCloseTo(800 * (Math.PI / 4) + 60, 3);
    expect(runPullDist(agile)).toBeLessThan(runPullDist(fast));
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

describe('AttackRunManoeuvre started inside its pass distance: open the range first (2026-11-14)', () => {
  // Filmed: a Robot Orb picked a run ~100 u off a heavy at 3–95 u/s and went
  // straight into its pass from a standstill, nose to nose. A pilot first
  // extends away, boosting, off the target's nose, then turns back.
  it('extends away with boost, off the target nose, out to the open distance, then dives', () => {
    // Target 100 u north (+y), its nose pointing east (+x): open to the west.
    const m = new AttackRunManoeuvre();
    const c = ctxAt(0, 0, 0, 100, { tick: 10, vy: 10, tvx: 30, tFwdX: 1, tFwdY: 0, radius: 30 });
    expect(c.dist).toBeLessThan(runPullDist(c));
    m.begin(c);
    expect(m.diving).toBe(false);
    const d = run(m, c);
    expect(d.dirY).toBeLessThan(-0.3); // away from the target
    expect(d.dirX).toBeLessThan(-0.6); // off its nose (it points +x)
    expect(goal.boost).toBe(true);
    expect(goal.spendReserve).toBe(true);
    // Commits at once: the pilot drops its throttle hold (eased pilot, 2026-11-14).
    expect(goal.throttleNow).toBe(true);
    expect(goal.speed).toBe(MAX);
    expect(goal.facing).toBe(FACE_MOVE);
    expect(m.isDone(c)).toBe(false);
    // The nose the other way picks the other side.
    const m2 = new AttackRunManoeuvre();
    const c2 = ctxAt(0, 0, 0, 100, { tick: 10, tFwdX: -1, tFwdY: 0 });
    m2.begin(c2);
    expect(run(m2, c2).dirX).toBeGreaterThan(0.6);
    // The side is latched: the target swinging its nose mid-open changes nothing.
    const c3 = ctxAt(0, -200, 0, 100, { tick: 40, tFwdX: -1, tFwdY: 0 });
    expect(run(m, c3).dirX).toBeLessThan(-0.6);
    // Still inside the open distance: still opening, not diving.
    const open = runOpenDist(c);
    expect(open).toBeGreaterThanOrEqual(1.5 * OVER);
    const c4 = ctxAt(0, 100 - (open - 10), 0, 100, { tick: 100 });
    run(m, c4);
    expect(m.diving).toBe(false);
    // Out at the open distance: turn back for the dive (toward the target,
    // here one at fighting speed: a slow one gets the strafing swing-round).
    const c5 = ctxAt(0, 100 - (open + 10), 0, 100, { tick: 101, vy: -200, ...MOVING });
    const back = run(m, c5);
    expect(m.diving).toBe(true);
    expect(back.dirY).toBeGreaterThan(0.9);
    expect(m.isDone(c5)).toBe(false);
  });
  it('a ship already flying at speed (half its cruise or more) flies the pass: no open', () => {
    const m = new AttackRunManoeuvre();
    m.begin(ctxAt(0, 0, 0, 300, { tick: 0, vy: 0.5 * CRUISE, tvy: 0.5 * CRUISE }));
    expect(m.diving).toBe(true);
  });
  it('a target running away from me opens the range itself: the open ends and the dive chases', () => {
    const m = new AttackRunManoeuvre();
    m.begin(ctxAt(0, 0, 0, 250, { tick: 0 }));
    expect(m.diving).toBe(false);
    run(m, ctxAt(0, 0, 0, 250, { tick: 5, tvy: 0.4 * CRUISE }));
    expect(m.diving).toBe(false);
    run(m, ctxAt(0, 0, 0, 250, { tick: 6, tvy: 0.6 * CRUISE }));
    expect(m.diving).toBe(true);
  });
  it('an open that never gets the range ends the run (5 s)', () => {
    const m = new AttackRunManoeuvre();
    m.begin(ctxAt(0, 0, 0, 100, { tick: 0 }));
    expect(m.isDone(ctxAt(0, 0, 0, 100, { tick: 5 * 60 - 1 }))).toBe(false);
    expect(m.isDone(ctxAt(0, 0, 0, 100, { tick: 5 * 60 }))).toBe(true);
  });
});

describe('AttackRunManoeuvre on a parked ship: strafing runs (owner 2026-11-14)', () => {
  // "Dive in firing, pass, swing round and come again, like a fighter on a
  // ground target. Always moving."
  it('passes a quarter overshoot beside it, never closer than the duel miss', () => {
    // Pull-off point (inside the overshoot), fixed side (+x of a +y line).
    const m = new AttackRunManoeuvre();
    m.begin(ctxAt(0, -1500, 0, 0, { tick: 0, radius: 10 }));
    run(m, ctxAt(0, -OVER + 10, 0, 0, { tick: 1, vy: 300, radius: 10 }));
    // The locked pass heading points at the miss point beside the target.
    const want = STRAFE_MISS_OVERSHOOTS * OVER;
    const p = run(m, ctxAt(0, -OVER + 10, 0, 0, { tick: 2, vy: 300, radius: 10 }));
    expect(p.dirX / p.dirY).toBeCloseTo(want / (OVER - 10), 1);
    // The duel miss (2.5 radii) wins when it is wider.
    const big = new AttackRunManoeuvre();
    big.begin(ctxAt(0, -1500, 0, 0, { tick: 0, radius: 80 }));
    const q = run(big, ctxAt(0, -OVER + 10, 0, 0, { tick: 1, vy: 300, radius: 80 }));
    expect(q.dirX / q.dirY).toBeCloseTo((2.5 * 80) / (OVER - 10), 1);
  });
  it('extends to the swing-round distance (overshoots, from shipTuning), not the seeded timer, then is done', () => {
    const m = new AttackRunManoeuvre();
    m.begin(ctxAt(0, -1500, 0, 0, { tick: 0 }));
    run(m, ctxAt(0, -OVER + 10, 0, 0, { tick: 1, vy: 300 }));
    // Carried an overshoot and a half past the target: the extend starts…
    const past = ctxAt(0, 1.5 * OVER, 0, 0, { tick: 2, vy: 300 });
    expect(m.isDone(past)).toBe(false);
    // …and, already past STRAFE_EXTEND_OVERSHOOTS × overshoot, ends on the
    // next tick (a duel extend runs at least 1.5 s or to 1.3 × fire range).
    expect(STRAFE_EXTEND_OVERSHOOTS * OVER).toBeLessThan(1.5 * OVER);
    past.tick = 3;
    expect(m.isDone(past)).toBe(true);
    const duel = new AttackRunManoeuvre();
    duel.begin(ctxAt(0, -1500, 0, 0, { tick: 0, ...MOVING }));
    run(duel, ctxAt(0, -OVER + 10, 0, 0, { tick: 1, vy: 300, ...MOVING }));
    expect(duel.isDone(ctxAt(0, 1.5 * OVER, 0, 0, { tick: 2, vy: 300, ...MOVING }))).toBe(false);
    expect(duel.isDone(ctxAt(0, 1.5 * OVER, 0, 0, { tick: 3, vy: 300, ...MOVING }))).toBe(false);
  });
  it('a new run that starts flying away swings round in an arc (course square to the velocity), then dives', () => {
    // Just after an extend: 500 u past the target (target at the origin,
    // ship at +y), still flying away (+y) at cruise.
    const m = new AttackRunManoeuvre();
    const c = ctxAt(0, 500, 0, 0, { tick: 0, vx: 0, vy: CRUISE });
    m.begin(c);
    const d = run(m, c);
    expect(Math.abs(d.dirY)).toBeLessThan(0.2); // square to the velocity, not back at the target
    expect(goal.speed).toBe(MAX);
    expect(goal.facing).toBe(FACE_MOVE);
    // Velocity turned across the target line: the dive (toward it).
    const d2 = run(m, ctxAt(0, 500, 0, 0, { tick: 1, vx: CRUISE, vy: -10 }));
    expect(d2.dirY).toBeLessThan(-0.9);
    // A target at fighting speed gets the plain dive at once (no arc).
    const n = new AttackRunManoeuvre();
    const c3 = ctxAt(0, 500, 0, 0, { tick: 0, vx: 0, vy: CRUISE, tvx: 0, tvy: -130 });
    n.begin(c3);
    expect(run(n, c3).dirY).toBeLessThan(-0.9);
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
