/**
 * Ramming damage through the REAL physics worker contact path (worker
 * contact -> CONTACT_BATCH -> aggregateRamming -> applyDamage). The shape
 * math is unit-locked in src/core/combat/Ramming.test.ts; THIS is the
 * integration lock for the seam (invariant #13).
 *
 * Model: IMPACT-BASED, ramming as a weapon (owner decision 2026-11-13,
 * replacing the 2026-06-12 mass-differential model, under which these same
 * two fighters head-on took NOTHING and angle was ignored). Damage comes from
 * the closing speed ALONG THE CONTACT NORMAL, shared by weight:
 *
 *   - two fighters head-on at both ships' full speed → BOTH lose a big chunk;
 *   - the same pair passing so they only clip edges (glancing) → small;
 *   - a fighter into a heavier crossguard → the fighter takes more;
 *   - a slow drift → no ram_damage at all (round-before-emit, P3.3);
 *   - a no-health entity is immune.
 *
 * Determinism: bodies are placed with the worker SET_POSITION command and fly
 * along their forward axis (+y at angle 0) so lateralGrip does not bleed the
 * closing speed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState, ShipState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { shieldBubbleRadius } from '../../../src/shared-types/shipScale/tuning.js';

function getRoomById(roomId: string): SectorRoom {
  return matchMaker.getLocalRoomById(roomId) as unknown as SectorRoom;
}
const FIGHTER = getShipKind('fighter');
const CROSSGUARD = getShipKind('crossguard');
const FIGHTER_POOL = FIGHTER.shieldMax + FIGHTER.maxHealth;
/** Full speed (the kind's max-speed clamp, which boost does not raise). */
const FULL = FIGHTER.maxSpeed;
/** Ships are posed just short of contact: since the arcade handling tune
 *  (owner 2026-11-13: "make it more like micro machines") a coasting fighter
 *  sheds its speed within ~150 u, so a long run-up no longer arrives at speed.
 *  A few ticks of flight are still needed: the impact speed is read from the
 *  previous tick's velocity, which is 0 on the tick a ship is posed. */
const NEAR = 25;

describe('SectorRoom integration — ramming damage (impact-based model)', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  function findShip(state: SectorState, pid: string): ShipState {
    for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) return s;
    throw new Error('ship gone: ' + pid);
  }
  function lost(state: SectorState, pid: string, pool: number): number {
    const s = findShip(state, pid);
    return pool - (s.shield + s.health);
  }

  async function twoPilots(kindA: string, kindB: string): Promise<{ a: string; b: string; room: SectorRoom }> {
    const a = randomUUID();
    const b = randomUUID();
    const cr = await harness.connectActive(a, { shipKind: kindA });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === a });
    await harness.connectActive(b, { shipKind: kindB });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === b });
    return { a, b, room: getRoomById(cr.roomId) };
  }

  /** Two fighters flying at each other at full speed along y, offset in x by
   *  `dx`. dx 0 = head-on; dx near the combined shield radius = a glancing
   *  clip of the edges. Returns each ship's combined shield + hull loss. */
  async function fighterPass(dx: number): Promise<{ lossA: number; lossB: number }> {
    const { a, b, room } = await twoPilots('fighter', 'fighter');
    const state = room.state as SectorState;
    const internal = room._internals;
    const y0 = shieldBubbleRadius(FIGHTER) + NEAR;
    internal.postToWorker({ type: 'SET_POSITION', entityId: a, x: 0, y: -y0, angle: 0, vx: 0, vy: FULL, angvel: 0 });
    internal.postToWorker({ type: 'SET_POSITION', entityId: b, x: dx, y: y0, angle: 0, vx: 0, vy: -FULL, angvel: 0 });
    await harness.events.waitFor({
      tag: 'collision_resolved',
      where: (d) => (d['aId'] === a && d['bId'] === b) || (d['aId'] === b && d['bId'] === a),
    }, { timeoutMs: 4000 });
    await harness.advance(150);
    return { lossA: lost(state, a, FIGHTER_POOL), lossB: lost(state, b, FIGHTER_POOL) };
  }

  it('two fighters head-on at full speed BOTH lose a big chunk, about equally (ramming is a weapon)', async () => {
    const { lossA, lossB } = await fighterPass(0);
    // Unit calibration: ~55 % of the pool each. Allow the contact's tick
    // discretisation some room, but it must be a real attack, not a nudge.
    expect(lossA).toBeGreaterThan(0.3 * FIGHTER_POOL);
    expect(lossB).toBeGreaterThan(0.3 * FIGHTER_POOL);
    expect(Math.abs(lossA - lossB)).toBeLessThan(0.2 * Math.max(lossA, lossB));
  }, 30_000);

  it('the same pair only clipping edges (glancing) takes a SMALL hit, far below head-on', async () => {
    // Combined shield radius is 2R; an x-offset of 0.95 · 2R clips the edges,
    // so the contact normal is mostly sideways to the motion.
    const r = shieldBubbleRadius(FIGHTER);
    const { lossA, lossB } = await fighterPass(0.95 * 2 * r);
    expect(lossA).toBeLessThan(0.15 * FIGHTER_POOL);
    expect(lossB).toBeLessThan(0.15 * FIGHTER_POOL);
  }, 30_000);

  it('a fighter into a heavier crossguard: BOTH are hurt, the lighter fighter far more', async () => {
    const { a: light, b: heavy, room } = await twoPilots('fighter', 'crossguard');
    const state = room.state as SectorState;
    const internal = room._internals;
    internal.postToWorker({ type: 'SET_POSITION', entityId: heavy, x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0 });
    internal.postToWorker({ type: 'SET_POSITION', entityId: light, x: 0, y: -(shieldBubbleRadius(FIGHTER) + shieldBubbleRadius(CROSSGUARD) + 2 * NEAR), angle: 0, vx: 0, vy: FULL, angvel: 0 });
    await harness.events.waitFor({
      tag: 'ram_damage',
      where: (d) => (d['aId'] === light && d['bId'] === heavy) || (d['aId'] === heavy && d['bId'] === light),
    }, { timeoutMs: 4000 });
    await harness.advance(150);
    const lossLight = lost(state, light, FIGHTER_POOL);
    const lossHeavy = lost(state, heavy, CROSSGUARD.shieldMax + CROSSGUARD.maxHealth);
    expect(lossLight).toBeGreaterThan(0);
    expect(lossLight).toBeGreaterThan(2 * lossHeavy);
  }, 30_000);

  it('a SLOW drift (just over the floor) emits NO ram_damage — the pipeline aborts (P3.3)', async () => {
    // P3.3: damage is ROUNDED before the emit guard, so a fractional hit sends
    // no DamageEvent (no sparks, no "0" number). A fighter drifting into a
    // parked crossguard at 70 u/s is above RAM_MIN_IMPACT_SPEED (50) but its
    // impact energy rounds to 0. The CONTACT still fires.
    const { a: light, b: heavy, room } = await twoPilots('fighter', 'crossguard');
    const state = room.state as SectorState;
    const internal = room._internals;
    const pair = (d: Record<string, unknown>): boolean =>
      (d['aId'] === light && d['bId'] === heavy) || (d['aId'] === heavy && d['bId'] === light);
    internal.postToWorker({ type: 'SET_POSITION', entityId: heavy, x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0 });
    const yDrift = shieldBubbleRadius(FIGHTER) + shieldBubbleRadius(CROSSGUARD) + 5;
    internal.postToWorker({ type: 'SET_POSITION', entityId: light, x: 0, y: -yDrift, angle: 0, vx: 0, vy: 70, angvel: 0 });
    await harness.events.waitFor({ tag: 'collision_resolved', where: pair }, { timeoutMs: 4000 });
    await harness.advance(80);
    expect(harness.events.count({ tag: 'ram_damage', where: pair }), 'a sub-0.5 collision must NOT emit ram_damage').toBe(0);
    expect(findShip(state, light).shield).toBe(FIGHTER.shieldMax);
  }, 30_000);


  it('a no-health target is immune: applyDamage is a safe no-op', async () => {
    const p1 = randomUUID();
    const cr = await harness.connectActive(p1, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === p1 });
    const room = getRoomById(cr.roomId);
    const state = room.state as SectorState;
    const internal = room._internals;

    const sBefore = findShip(state, p1).shield;
    const hBefore = findShip(state, p1).health;
    expect(() => internal.applyDamage('asteroid-not-a-real-entity', p1, 9_999)).not.toThrow();
    expect(findShip(state, p1).shield).toBe(sBefore);
    expect(findShip(state, p1).health).toBe(hBefore);
  }, 30_000);
});
