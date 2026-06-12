/**
 * Phase 4 lock + WS-1 / R2.31 mass-differential model — ramming damage
 * through the REAL physics worker contact path (plan: clever-wombat;
 * Equinox Round 2 roadmap WS-1).
 *
 * The aggregation math (N-triangle multiply / sub-floor) is exhaustively
 * unit-locked in src/core/combat/Ramming.test.ts; THIS test is the
 * integration lock for invariant #13's "the bug lives at the worker
 * contact -> CONTACT_BATCH -> applyDamage seam".
 *
 * WS-1 reshapes the damage curve per the user's spec (R2.31 "ram damage
 * too high"): a ram only hurts when there is BOTH a huge closing speed
 * AND a large mass differential, and the damage is ASYMMETRIC — the
 * LIGHTER body (the one that flew into the heavier object) takes the
 * damage; the heavier body takes ~0. Two equal-mass ships colliding at
 * any speed take NOTHING (no mass differential). This file proves that
 * end-to-end through the real worker:
 *
 *   - two EQUAL-mass fighters head-on at 2400 u/s closing → NO damage;
 *   - a LIGHT fighter into a HEAVY crossguard (mass 30) at 2400 u/s →
 *     the fighter loses shield, the crossguard is untouched;
 *   - a no-health entity is immune (applyDamage is a safe no-op).
 *
 * Determinism: rather than rely on spawn coordinates, both players are
 * teleported onto the SAME point via the worker SET_POSITION command (the
 * same path the drone out-of-bounds clamp uses). A 100% ball overlap makes
 * Rapier emit a large separating contact force the very next steps. The
 * 2400 u/s closing speed (1200 + 1200) is far above RAM_MIN_IMPACT_SPEED,
 * so the worker-measured impactSpeed saturates the speed term.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState, ShipState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';

function getRoomById(roomId: string): SectorRoom {
  return matchMaker.getLocalRoomById(roomId) as unknown as SectorRoom;
}
const FIGHTER = getShipKind('fighter');
const CROSSGUARD = getShipKind('crossguard');

describe('SectorRoom integration — ramming damage (mass-differential model, WS-1/R2.31)', () => {
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

  /** Drive a deterministic head-on between two active players' worker
   *  bodies. Closing along the ship's forward axis (+y at angle 0) so the
   *  car-model lateralGrip does NOT bleed the closing speed. */
  function ramHeadOn(internal: SectorRoom['_internals'], p1: string, p2: string): void {
    internal.postToWorker({ type: 'SET_POSITION', entityId: p1, x: 0, y: -50, angle: 0, vx: 0, vy: 1200, angvel: 0 });
    internal.postToWorker({ type: 'SET_POSITION', entityId: p2, x: 0, y: 50, angle: 0, vx: 0, vy: -1200, angvel: 0 });
  }

  it('two EQUAL-mass fighters head-on at 2400 u/s closing take NO ramming damage (no mass differential)', async () => {
    const p1 = randomUUID();
    const p2 = randomUUID();
    const cr = await harness.connectActive(p1, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === p1 });
    await harness.connectActive(p2, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === p2 });

    const room = getRoomById(cr.roomId);
    const state = room.state as SectorState;
    const internal = room._internals;

    expect(findShip(state, p1).shield).toBe(FIGHTER.shieldMax);
    expect(findShip(state, p2).shield).toBe(FIGHTER.shieldMax);

    ramHeadOn(internal, p1, p2);

    // Let the collision resolve over several ticks. A `collision_resolved`
    // proves the contact fired through the worker; the equal-mass model must
    // deal ZERO ramming damage, so NO `ram_damage` event should appear and
    // both shields must stay full.
    await harness.events.waitFor({
      tag: 'collision_resolved',
      where: (d) =>
        (d['aId'] === p1 && d['bId'] === p2) || (d['aId'] === p2 && d['bId'] === p1),
    }, { timeoutMs: 4000 });
    await harness.advance(150);

    expect(findShip(state, p1).shield).toBe(FIGHTER.shieldMax);
    expect(findShip(state, p2).shield).toBe(FIGHTER.shieldMax);
  }, 30_000);

  it('a LIGHT fighter into a HEAVY crossguard: the LIGHT ship takes damage, the HEAVY ship takes ~0 (asymmetric)', async () => {
    const light = randomUUID(); // fighter, mass 1
    const heavy = randomUUID(); // crossguard, mass 30
    const cr = await harness.connectActive(light, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === light });
    await harness.connectActive(heavy, { shipKind: 'crossguard' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === heavy });

    const room = getRoomById(cr.roomId);
    const state = room.state as SectorState;
    const internal = room._internals;

    expect(findShip(state, light).shield).toBe(FIGHTER.shieldMax);
    expect(findShip(state, heavy).shield).toBe(CROSSGUARD.shieldMax);

    // The crossguard ball collider is ~213 u; place the bodies far enough
    // apart that they are NOT pre-overlapping at spawn (a pre-overlap emits no
    // fresh contact-force spike) and let the light fighter fly INTO the
    // stationary heavy ship along +y at 1200 u/s (>> the speed-saturation
    // point), so the worker measures a high closing speed.
    internal.postToWorker({ type: 'SET_POSITION', entityId: heavy, x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0 });
    internal.postToWorker({ type: 'SET_POSITION', entityId: light, x: 0, y: -400, angle: 0, vx: 0, vy: 1200, angvel: 0 });

    // A ram_damage event must fire (the light ship takes damage>0).
    await harness.events.waitFor({
      tag: 'ram_damage',
      where: (d) =>
        (d['aId'] === light && d['bId'] === heavy) || (d['aId'] === heavy && d['bId'] === light),
    }, { timeoutMs: 4000 });
    await harness.advance(150);

    // ASYMMETRIC: the light fighter lost shield; the heavy crossguard did NOT.
    expect(findShip(state, light).shield).toBeLessThan(FIGHTER.shieldMax);
    expect(findShip(state, heavy).shield).toBe(CROSSGUARD.shieldMax);
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
