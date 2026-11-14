/**
 * Virtual pilot (AI pilot layer, slice 1b): the pilot only presses player keys,
 * and those keys drive a real Rapier body through `World.applyAiInput` →
 * `applyShipInput` exactly as the worker does. These tests fly a spawned NPC
 * body (SwarmSpawner's mass + damping) to a heading and to a point and check it
 * settles there without oscillating.
 */
import { describe, expect, it } from 'vitest';
import { PhysicsWorld } from '../physics/World.js';
import { SHIP_KINDS_LIST, getShipKind, type ShipKind } from '../../shared-types/shipKinds.js';
import { massOf, NPC_MASS_FALLBACK } from '../../shared-types/shipScale/tuning.js';
import { AI_INPUT_BOOST, AI_INPUT_REVERSE, AI_INPUT_THRUST, AI_INPUT_TURN_LEFT, AI_INPUT_TURN_RIGHT, decodeAiInputBits } from '../contracts/IAiBehaviour.js';
import {
  brakingSpeed,
  DEFAULT_PILOT_PARAMS,
  easedSnapTurn,
  facingOf,
  makePilotHandling,
  makePilotState,
  makeSnapTurnState,
  pilotInputs,
  SNAP_TURN_EASE,
  wrapAngle,
  type PilotParams,
} from './virtualPilot.js';

const KEYS = { thrust: false, reverse: false, turnLeft: false, turnRight: false, boost: false };
/** The in-process loop has no worker latency: the pose read is current. */
const SYNC: PilotParams = { ...DEFAULT_PILOT_PARAMS, leadTicks: 0 };

async function npcWorld(kind: ShipKind, angle = 0): Promise<PhysicsWorld> {
  const w = await PhysicsWorld.create();
  const mass = massOf(kind, NPC_MASS_FALLBACK);
  w.spawnObstacle('npc', 0, 0, kind.radius, mass, undefined, kind.linearDamping, undefined, undefined, kind);
  w.setShipState('npc', { x: 0, y: 0, angle, vx: 0, vy: 0, angvel: 0 });
  w.setPilotKind('npc', kind);
  return w;
}

type Goal = (s: { x: number; y: number; vx: number; vy: number; angle: number }) => { facing: number; vx: number; vy: number; boost: boolean };

/** Fly `ticks` steps; returns the per-tick angle trace and the last bits.
 *  `delay` ticks of lag between deciding and the keys reaching the body
 *  model the server, where the brain reads the last physics step and its keys
 *  land on the worker's next one. */
function fly(w: PhysicsWorld, kind: ShipKind, ticks: number, goal: Goal, params = SYNC, delay = 0): { angles: number[]; turnFlips: number; last: number } {
  const queue: number[] = [];
  for (let i = 0; i < delay; i++) queue.push(0);
  const h = makePilotHandling(kind, massOf(kind, NPC_MASS_FALLBACK));
  const st = makePilotState();
  const angles: number[] = [];
  let lastTurn = 0;
  let turnFlips = 0;
  let last = 0;
  for (let i = 0; i < ticks; i++) {
    const s = w.getShipState('npc')!;
    const g = goal(s);
    const bits = pilotInputs(h, st, params, s.angle, s.angvel ?? 0, s.vx, s.vy, g.facing, g.vx, g.vy, g.boost);
    const turn = (bits & AI_INPUT_TURN_LEFT ? 1 : 0) - (bits & AI_INPUT_TURN_RIGHT ? 1 : 0);
    if (turn !== 0 && lastTurn !== 0 && turn !== lastTurn) turnFlips++;
    if (turn !== 0) lastTurn = turn;
    queue.push(bits);
    decodeAiInputBits(queue.shift()!, KEYS);
    w.applyAiInput('npc', KEYS);
    w.tick(1 / 60);
    angles.push(w.getShipState('npc')!.angle);
    last = bits;
  }
  return { angles, turnFlips, last };
}

describe('virtualPilot — turning', () => {
  const fighter = getShipKind('fighter');

  it('turns a snap-turn fighter to a heading and holds it (no oscillation)', async () => {
    const w = await npcWorld(fighter);
    const target = 2.0;
    const r = fly(w, fighter, 240, () => ({ facing: target, vx: 0, vy: 0, boost: false }));
    const end = r.angles[r.angles.length - 1]!;
    expect(Math.abs(wrapAngle(end - target))).toBeLessThanOrEqual(DEFAULT_PILOT_PARAMS.deadzone + 1e-3);
    // Once there it stays: the last second never leaves the deadzone.
    for (const a of r.angles.slice(-60)) expect(Math.abs(wrapAngle(a - target))).toBeLessThan(0.03);
    expect(r.turnFlips).toBe(0);
  });

  it('with a tick of command lag (the server worker), the default lead still settles without hunting', async () => {
    const lagged = { ...DEFAULT_PILOT_PARAMS }; // leadTicks: 1
    const w = await npcWorld(fighter);
    const r = fly(w, fighter, 240, () => ({ facing: 2.0, vx: 0, vy: 0, boost: false }), lagged, 1);
    // With lag it may stop one tick of turn short (a snap turn moves maxAngvel/60
    // per tick, 0.033 rad at 1× scale); it must still hold still, not hunt.
    const lagTol = DEFAULT_PILOT_PARAMS.deadzone + fighter.maxAngvel / 60 + 1e-3;
    const settled = r.angles.slice(-60);
    for (const a of settled) expect(Math.abs(wrapAngle(a - 2.0))).toBeLessThan(lagTol);
    expect(Math.abs(settled[0]! - settled[settled.length - 1]!)).toBeLessThan(1e-6);
    expect(r.turnFlips).toBe(0);
    const capital = SHIP_KINDS_LIST.find((k) => (k.turnTorque ?? 0) > 0)!;
    const wc = await npcWorld(capital);
    const rc = fly(wc, capital, 60 * 90, () => ({ facing: 0.6, vx: 0, vy: 0, boost: false }), lagged, 1);
    expect(Math.abs(wrapAngle(rc.angles[rc.angles.length - 1]! - 0.6))).toBeLessThan(0.03);
    expect(Math.abs(wc.getShipState('npc')!.angvel ?? 0)).toBeLessThan(capital.maxAngvel * 0.05);
  });

  it('turns the short way round', async () => {
    const w = await npcWorld(fighter, 3.0);
    const r = fly(w, fighter, 5, () => ({ facing: -3.0, vx: 0, vy: 0, boost: false }));
    // -3.0 is 0.28 rad counter-clockwise of 3.0 across ±π: angle must grow.
    expect(wrapAngle(r.angles[4]! - 3.0)).toBeGreaterThan(0);
  });

  it('turns a torque-turning capital and stops on the heading within tolerance', async () => {
    const capital = SHIP_KINDS_LIST.find((k) => (k.turnTorque ?? 0) > 0)!;
    const w = await npcWorld(capital);
    const target = 0.6; // ~34°: tens of seconds of capital turn
    const r = fly(w, capital, 60 * 90, () => ({ facing: target, vx: 0, vy: 0, boost: false }));
    const end = r.angles[r.angles.length - 1]!;
    expect(Math.abs(wrapAngle(end - target))).toBeLessThan(0.03);
    // It stopped turning (no slow pendulum about the heading).
    expect(Math.abs(w.getShipState('npc')!.angvel ?? 0)).toBeLessThan(capital.maxAngvel * 0.05);
    // Never overshot by more than the tolerance on the way in.
    let maxPast = 0;
    for (const a of r.angles) maxPast = Math.max(maxPast, wrapAngle(a - target));
    expect(maxPast).toBeLessThan(0.03);
  });
});

describe('virtualPilot — flying to a point', () => {
  const goalAt = (gx: number, gy: number, kind: ShipKind): Goal => (s) => {
    const h = makePilotHandling(kind, massOf(kind, NPC_MASS_FALLBACK));
    const dx = gx - s.x, dy = gy - s.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) return { facing: s.angle, vx: 0, vy: 0, boost: false };
    const speed = Math.min(h.maxSpeed, brakingSpeed(h, d));
    const facing = d > kind.radius * 3 ? facingOf(dx, dy) : s.angle;
    return { facing, vx: (dx / d) * speed, vy: (dy / d) * speed, boost: d > 600 };
  };

  for (const id of ['fighter', 'scout', 'heavy', 'missile-frigate']) {
    it(`${id}: arrives at a point 2000 u away and stops there`, async () => {
      const kind = getShipKind(id);
      const w = await npcWorld(kind, 1.2);
      // 60 s: a missile frigate brakes gently (reverse 0.3, light damping).
      fly(w, kind, 60 * 60, goalAt(1200, 1600, kind));
      const s = w.getShipState('npc')!;
      expect(Math.hypot(s.x - 1200, s.y - 1600)).toBeLessThan(kind.radius * 2);
      expect(Math.hypot(s.vx, s.vy)).toBeLessThan(10);
    });
  }

  it('never overshoots the goal by more than a hull length on the way in', async () => {
    const kind = getShipKind('fighter');
    const w = await npcWorld(kind, 0);
    const h = makePilotHandling(kind, massOf(kind, NPC_MASS_FALLBACK));
    const st = makePilotState();
    let maxPast = -Infinity;
    for (let i = 0; i < 60 * 20; i++) {
      const s = w.getShipState('npc')!;
      const g = goalAt(0, 2000, kind)(s);
      const bits = pilotInputs(h, st, SYNC, s.angle, s.angvel ?? 0, s.vx, s.vy, g.facing, g.vx, g.vy, g.boost);
      decodeAiInputBits(bits, KEYS);
      w.applyAiInput('npc', KEYS);
      w.tick(1 / 60);
      maxPast = Math.max(maxPast, w.getShipState('npc')!.y - 2000);
    }
    expect(maxPast).toBeLessThan(kind.radius * 2);
  });

  it('boosts only when allowed and on course; brakes with reverse', () => {
    const kind = getShipKind('fighter');
    const h = makePilotHandling(kind, massOf(kind, NPC_MASS_FALLBACK));
    const st = makePilotState();
    // At rest, nose on course (+y), wants full speed: thrust + boost.
    const go = pilotInputs(h, st, SYNC, 0, 0, 0, 0, 0, 0, h.maxSpeed, true);
    expect(go & AI_INPUT_THRUST).toBeTruthy();
    expect(go & AI_INPUT_BOOST).toBeTruthy();
    // Same but boost not allowed.
    expect(pilotInputs(h, st, SYNC, 0, 0, 0, 0, 0, 0, h.maxSpeed, false) & AI_INPUT_BOOST).toBe(0);
    // Nose 90° off course: no thrust (it turns first), no boost.
    const off = pilotInputs(h, st, SYNC, Math.PI / 2 + 0.2, 0, 0, 0, 0, 0, h.maxSpeed, true);
    expect(off & (AI_INPUT_THRUST | AI_INPUT_BOOST)).toBe(0);
    // Moving along the nose faster than wanted: reverse.
    expect(pilotInputs(h, st, SYNC, 0, 0, 0, 200, 0, 0, 0, false) & AI_INPUT_REVERSE).toBeTruthy();
  });

  it('a reaction latch holds the decision for N ticks', () => {
    const kind = getShipKind('fighter');
    const h = makePilotHandling(kind, massOf(kind, NPC_MASS_FALLBACK));
    const st = makePilotState();
    const p: PilotParams = { ...SYNC, reactionTicks: 3 };
    const first = pilotInputs(h, st, p, 0, 0, 0, 0, 1, 0, 0, false);
    expect(first & AI_INPUT_TURN_LEFT).toBeTruthy();
    for (let i = 0; i < 3; i++) expect(pilotInputs(h, st, p, 0, 0, 0, 0, -1, 0, 0, false)).toBe(first);
    // The next decision lets go of left (it never reverses at once: no
    // left / right hunting), then turns right.
    expect(pilotInputs(h, st, p, 0, 0, 0, 0, -1, 0, 0, false) & AI_INPUT_TURN_LEFT).toBe(0);
    let right = false;
    for (let i = 0; i < 40 && !right; i++) right = (pilotInputs(h, st, p, 0, 0, 0, 0, -1, 0, 0, false) & AI_INPUT_TURN_RIGHT) !== 0;
    expect(right).toBe(true);
  });
});

/**
 * Key discipline (owner 2026-11-14: the NPC turn was "sort of jerky and abrupt
 * rather than a smooth turn"; measured on the 1v1 on-sight duel: median turn
 * press 1–2 ticks, left / right swapped every tick for ~50-tick bursts).
 * A snap turner is flown kinematically here (a held key turns maxAngvel·dt a
 * tick, release stops it), exactly as `applyShipInput` does.
 */
describe('virtualPilot — key discipline (no flicking)', () => {
  const fighter = getShipKind('fighter');
  const h = makePilotHandling(fighter, massOf(fighter, NPC_MASS_FALLBACK));
  const step = h.maxAngvel / 60;

  interface Trace { presses: number[]; swapsWithin6: number; tapsInBand: number; maxErr: number }
  /** Fly `ticks` ticks after `desired(t)`; collect press lengths, quick
   *  reversals (a press the other way within 6 ticks of letting go) and presses
   *  started with the error inside the dead-band. */
  function track(ticks: number, desired: (t: number) => number, settle = 60): Trace {
    const st = makePilotState();
    let angle = 0;
    let angvel = 0;
    const presses: number[] = [];
    let cur = 0, len = 0, lastDir = 0, sinceEnd = 1e9, swapsWithin6 = 0, tapsInBand = 0, maxErr = 0;
    const band = SNAP_TURN_EASE.deadbandSteps * step;
    for (let t = 0; t < ticks; t++) {
      const want = desired(t);
      const err = wrapAngle(want - angle);
      const bits = pilotInputs(h, st, SYNC, angle, angvel, 0, 0, want, 0, 0, false);
      const k = bits & AI_INPUT_TURN_LEFT ? 1 : bits & AI_INPUT_TURN_RIGHT ? -1 : 0;
      if (k !== cur) {
        if (cur !== 0) { presses.push(len); lastDir = cur; sinceEnd = 0; }
        if (k !== 0) {
          // sinceEnd = idle ticks before this one.
          if (lastDir !== 0 && k !== lastDir && sinceEnd < 6) swapsWithin6++;
          if (Math.abs(err) < band - 1e-6) tapsInBand++;
        }
        cur = k; len = 0;
      }
      if (k !== 0) len++; else sinceEnd++;
      angvel = k * h.maxAngvel;
      angle += k * step;
      if (t >= settle) maxErr = Math.max(maxErr, Math.abs(wrapAngle(want - angle)));
    }
    return { presses, swapsWithin6, tapsInBand, maxErr };
  }
  const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

  it('tracking a target that crosses at half the turn rate: presses of ≥ 4 ticks, no taps, no quick reversals', () => {
    const r = track(720, (t) => 0.3 + 0.5 * h.maxAngvel * (t / 60));
    expect(r.presses.length).toBeGreaterThan(5);
    expect(median(r.presses)).toBeGreaterThanOrEqual(4);
    expect(r.tapsInBand).toBe(0);
    expect(r.swapsWithin6).toBe(0);
    // Still on the target: inside a dead-band (+ a tick) all along.
    expect(r.maxErr).toBeLessThan((SNAP_TURN_EASE.deadbandSteps + 1) * step);
  });

  it('a heading that jitters ±4° every tick (the measured hunt) never sets up a left / right swap', () => {
    const r = track(720, (t) => 0.4 * Math.sin(t / 90) + (t % 2 === 0 ? 1 : -1) * 0.07);
    expect(r.swapsWithin6).toBe(0);
    expect(r.tapsInBand).toBe(0);
  });

  it('a big turn still lands on the heading (released about a tick early, not past it)', () => {
    const r = track(240, () => 1.5, 200);
    expect(r.presses.length).toBe(1);
    expect(r.maxErr).toBeLessThanOrEqual(0.5 * step + 1e-9);
  });

  it('easedSnapTurn is usable on its own (exported for other pilots)', () => {
    const st = makeSnapTurnState();
    // Inside the dead-band: left alone however long it lasts.
    for (let i = 0; i < 10; i++) expect(easedSnapTurn(st, 2 * step, step)).toBe(0);
    // Just past it: a press starts within a couple of ticks (smoothed error).
    let started = false;
    for (let i = 0; i < 4 && !started; i++) started = easedSnapTurn(st, 3 * step, step) === 1;
    expect(started).toBe(true);
    // A short correction is one deliberate press, not a tap.
    let held = 1;
    let err = 2 * step;
    while (easedSnapTurn(st, err, step) === 1) { held++; err -= step; }
    expect(held).toBeGreaterThanOrEqual(4);
  });
});

describe('virtualPilot — combat throttle (thrust held by default)', () => {
  const fighter = getShipKind('fighter');
  const h = makePilotHandling(fighter, massOf(fighter, NPC_MASS_FALLBACK));
  const COMBAT: PilotParams = { ...SYNC, combatThrust: true, throttleHoldTicks: 8 };

  it('keeps thrust held when the wanted speed is a little under the actual (speed is managed by turning)', () => {
    const st = makePilotState();
    const v = h.cruiseSpeed;
    const want = v * 0.95; // within the slack
    const bits = pilotInputs(h, st, COMBAT, 0, 0, 0, v, 0, 0, want, false);
    expect(bits & AI_INPUT_THRUST).toBeTruthy();
    // The pre-combat rule would have let go here (wanted < actual along the nose).
    expect(pilotInputs(h, makePilotState(), SYNC, 0, 0, 0, v, 0, 0, want, false) & AI_INPUT_THRUST).toBe(0);
  });

  it('a course well off a nose held on the target does not brake a slow ship (the Tail-slow robot)', () => {
    // Measured 2026-11-14: a robot in Tail, nose on the target, wingman fire
    // lanes resolving its course ~80° off the nose at 158 u/s, flying 40 u/s:
    // the along-the-nose rule read "too fast along the nose" and REVERSED it
    // down to 22 u/s for ~3 s.
    const off = 1.4;
    const want = 158;
    const fwdX = 0, fwdY = 40; // angle 0: nose +y
    const wvx = -Math.sin(off) * want, wvy = Math.cos(off) * want;
    const old = pilotInputs(h, makePilotState(), SYNC, 0, 0, fwdX, fwdY, 0, wvx, wvy, false);
    expect(old & AI_INPUT_REVERSE).toBeTruthy();
    const now = pilotInputs(h, makePilotState(), COMBAT, 0, 0, fwdX, fwdY, 0, wvx, wvy, false);
    expect(now & AI_INPUT_REVERSE).toBe(0);
    expect(now & AI_INPUT_THRUST).toBeTruthy();
  });

  it('lets go, then reverses, only when the wanted speed is clearly below the actual', () => {
    const v = h.cruiseSpeed;
    expect(pilotInputs(h, makePilotState(), COMBAT, 0, 0, 0, v, 0, 0, v * 0.85, false) & (AI_INPUT_THRUST | AI_INPUT_REVERSE)).toBe(0);
    expect(pilotInputs(h, makePilotState(), COMBAT, 0, 0, 0, v, 0, 0, v * 0.5, false) & AI_INPUT_REVERSE).toBeTruthy();
  });

  it('no on/off chatter: a wanted speed that flickers about the actual changes the throttle at most once per hold', () => {
    const st = makePilotState();
    const v = h.cruiseSpeed;
    let prev = -1, changes = 0, run = 0, minRun = Infinity;
    for (let t = 0; t < 240; t++) {
      const want = t % 2 === 0 ? v * 1.2 : v * 0.5;
      const bits = pilotInputs(h, st, COMBAT, 0, 0, 0, v, 0, 0, want, false);
      const k = bits & AI_INPUT_THRUST ? 1 : bits & AI_INPUT_REVERSE ? -1 : 0;
      if (k !== prev) {
        if (prev !== -1) { changes++; minRun = Math.min(minRun, run); }
        prev = k; run = 0;
      }
      run++;
    }
    expect(changes).toBeGreaterThan(0);
    expect(minRun).toBeGreaterThanOrEqual(8);
  });
});
