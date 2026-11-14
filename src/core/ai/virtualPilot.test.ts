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
  facingOf,
  makePilotHandling,
  makePilotState,
  pilotInputs,
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
    expect(pilotInputs(h, st, p, 0, 0, 0, 0, -1, 0, 0, false) & AI_INPUT_TURN_RIGHT).toBeTruthy();
  });
});
