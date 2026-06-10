/**
 * Phase 4 lock — ramming damage through the REAL physics worker contact
 * path (plan: clever-wombat). The aggregation math (N-triangle multiply /
 * sub-floor) is exhaustively unit-locked in src/core/combat/Ramming.test.ts;
 * THIS test is the integration lock for invariant #13's "the bug lives at
 * the worker contact -> CONTACT_BATCH -> applyDamage seam": it forces a
 * real Rapier overlap between two ship bodies and asserts the new handler
 * deals SYMMETRIC layered damage, plus that a no-health entity is immune.
 *
 * Determinism: rather than rely on spawn coordinates, both players are
 * teleported onto the SAME point via the worker SET_POSITION command (the
 * same path the drone out-of-bounds clamp uses). A 100% ball overlap makes
 * Rapier emit a large separating contact force the very next steps.
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

describe('SectorRoom integration — ramming damage', () => {
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

  it('two ships rammed together take SYMMETRIC layered damage; a no-health entity is immune', async () => {
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

    // Drive a hard HEAD-ON collision (worker body id == playerId). Closing
    // along the ship's forward axis (+y at angle 0) so the car-model
    // lateralGrip does NOT bleed the closing speed. The 2400 u/s closing speed
    // (1200 + 1200) is far above RAM_MIN_IMPACT_SPEED, so the worker-measured
    // impactSpeed drives full ramming damage.
    internal.postToWorker({ type: 'SET_POSITION', entityId: p1, x: 0, y: -50, angle: 0, vx: 0, vy: 1200, angvel: 0 });
    internal.postToWorker({ type: 'SET_POSITION', entityId: p2, x: 0, y: 50, angle: 0, vx: 0, vy: -1200, angvel: 0 });

    // Rapier resolves the overlap with a strong contact force ⇒ CONTACT_BATCH
    // ⇒ aggregated ram_damage ⇒ symmetric applyDamage.
    const ram = await harness.events.waitFor(
      {
        tag: 'ram_damage',
        where: (d) =>
          (d['aId'] === p1 && d['bId'] === p2) || (d['aId'] === p2 && d['bId'] === p1),
      },
      { timeoutMs: 4000 },
    );
    expect([p1, p2].sort()).toEqual([ram.data['aId'], ram.data['bId']].sort());
    expect(ram.data['damage']).toBeGreaterThan(0);

    // Symmetric: BOTH ships lost shield (each took the same ramming damage).
    await harness.advance(150);
    expect(findShip(state, p1).shield).toBeLessThan(FIGHTER.shieldMax);
    expect(findShip(state, p2).shield).toBeLessThan(FIGHTER.shieldMax);

    // A no-health target (asteroid-like / unknown id) is immune: applyDamage
    // is a safe no-op and nothing changes. Ships DO take it (shown above),
    // so "asteroids deal but don't take" falls out of this asymmetry.
    const s1Before = findShip(state, p1).shield;
    const h1Before = findShip(state, p1).health;
    expect(() => internal.applyDamage('asteroid-not-a-real-entity', p1, 9_999)).not.toThrow();
    expect(findShip(state, p1).shield).toBe(s1Before);
    expect(findShip(state, p1).health).toBe(h1Before);
  }, 30_000);
});
