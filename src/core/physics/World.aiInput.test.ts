/**
 * Pilot layer (AI flies with player controls), slice 1a: an AI body driven by
 * control keys (`applyAiInput`, the worker's AI_INPUTS path) moves EXACTLY like
 * a pilot's ship of the same kind under the same keys: same `applyShipInput`,
 * so the same lateral grip, maxSpeed clamp, maxAngvel and capital torque turn.
 */
import { describe, expect, it } from 'vitest';
import { PhysicsWorld } from './World.js';
import { SHIP_KINDS_LIST, getShipKind, type ShipKind } from '../../shared-types/shipKinds.js';
import { shipBodyMass } from '../../shared-types/shipScale/tuning.js';
import { decodeAiInputBits, packAiInputBits } from '../contracts/IAiBehaviour.js';

const KEYS = { thrust: false, reverse: false, turnLeft: false, turnRight: false, boost: false };

/** A pilot ship and an AI drone body of `kind`, far apart, in one world. The
 *  drone is spawned the way `SwarmSpawner` spawns one (kind mass, radius,
 *  linear damping, shield collider) plus its pilot kind. */
async function pair(kind: ShipKind): Promise<PhysicsWorld> {
  const w = await PhysicsWorld.create();
  w.spawnShip('pilot', -100_000, 0, kind.id);
  w.spawnObstacle('npc', 100_000, 0, kind.radius, shipBodyMass(kind), undefined, kind.linearDamping, undefined, undefined, kind);
  w.setPilotKind('npc', kind);
  return w;
}

/** One tick of the same keys on both bodies (pilot via INPUT, NPC via AI bits). */
function step(w: PhysicsWorld, thrust: boolean, reverse: boolean, left: boolean, right: boolean, boost: boolean): void {
  w.applyInput('pilot', { thrust, reverse, turnLeft: left, turnRight: right, boost });
  decodeAiInputBits(packAiInputBits(thrust, reverse, left, right, boost), KEYS);
  w.applyAiInput('npc', KEYS);
  w.tick(1 / 60);
}

function expectSameMotion(w: PhysicsWorld): void {
  const p = w.getShipState('pilot')!;
  const n = w.getShipState('npc')!;
  expect(n.vx).toBeCloseTo(p.vx, 4);
  expect(n.vy).toBeCloseTo(p.vy, 4);
  expect(n.angle).toBeCloseTo(p.angle, 5);
  expect(n.angvel ?? 0).toBeCloseTo(p.angvel ?? 0, 5);
  expect(n.x - p.x).toBeCloseTo(200_000, 2);
  expect(n.y).toBeCloseTo(p.y, 2);
}

describe('World.applyAiInput — AI flies with player controls', () => {
  const fighter = getShipKind('fighter');

  it('mirrors a pilot under a thrust / boost / turn / release / reverse sequence', async () => {
    const w = await pair(fighter);
    for (let i = 0; i < 120; i++) step(w, true, false, false, false, i % 3 === 0);
    expectSameMotion(w);
    for (let i = 0; i < 40; i++) step(w, true, false, true, false, false);
    expectSameMotion(w);
    for (let i = 0; i < 30; i++) step(w, false, false, false, false, false); // released: angvel decays by damping
    expectSameMotion(w);
    for (let i = 0; i < 30; i++) step(w, false, true, false, true, false);
    expectSameMotion(w);
  });

  it('obeys the kind maxSpeed clamp, lateral grip and maxAngvel', async () => {
    const w = await pair(fighter);
    for (let i = 0; i < 600; i++) step(w, true, false, false, false, true);
    const s = w.getShipState('npc')!;
    expect(Math.hypot(s.vx, s.vy)).toBeLessThanOrEqual(fighter.maxSpeed * (1 + 1e-4));
    expect(Math.hypot(s.vx, s.vy)).toBeGreaterThan(fighter.maxSpeed * 0.5);

    // Turning hard at speed: the nose swings at maxAngvel and grip bleeds the
    // sideways velocity, so speed stays (mostly) along the nose.
    for (let i = 0; i < 20; i++) step(w, true, false, true, false, false);
    const t = w.getShipState('npc')!;
    expect(Math.abs(t.angvel ?? 0)).toBeCloseTo(fighter.maxAngvel, 3);
    const fx = -Math.sin(t.angle), fy = Math.cos(t.angle);
    const along = t.vx * fx + t.vy * fy;
    const lateral = Math.abs(t.vx * fy - t.vy * fx);
    expect(lateral).toBeLessThan(Math.abs(along));
    expectSameMotion(w);
  });

  it('turns a capital by torque, exactly like a pilot capital', async () => {
    const capital = SHIP_KINDS_LIST.find((k) => (k.turnTorque ?? 0) > 0) as ShipKind | undefined;
    expect(capital).toBeDefined();
    const w = await pair(capital!);
    for (let i = 0; i < 90; i++) step(w, true, false, false, true, false);
    expectSameMotion(w);
    const n = w.getShipState('npc')!;
    expect(Math.abs(n.angvel ?? 0)).toBeLessThanOrEqual(capital!.maxAngvel * (1 + 1e-6));
    expect(Math.abs(n.angvel ?? 0)).toBeGreaterThan(0);
  });

  it('unknown id is a no-op', async () => {
    const w = await PhysicsWorld.create();
    expect(() => w.applyAiInput('nobody', KEYS)).not.toThrow();
  });
});
