/**
 * Integration lock (plan squishy-canyon, D4) — testMode JoinOption overrides
 * must be IGNORED on a non-testMode room.
 *
 * The testMode primitives (`initialHull`, `initialShield`, `testTimeScale`,
 * `dronePoses`, `startHostile`, …) are gated on `this.testMode` in SectorRoom so
 * a production client cannot use them to spawn a 1-HP ship, accelerate physics,
 * or force-aggro a sector. This is the SectorRoom-internal half of the S6
 * room-gating story (A6 keeps the test ROOMS out of production; this proves the
 * overrides are inert even if a join reaches a non-testMode room). Locked at the
 * integration layer because the gate lives in onJoin, past the wire schema.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import type { Room as ServerRoom } from 'colyseus';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';

function getRoomById(roomId: string): ServerRoom<SectorState> {
  return matchMaker.getLocalRoomById(roomId) as unknown as ServerRoom<SectorState>;
}
const FIGHTER = getShipKind('fighter');

describe('SectorRoom integration — testMode override gating (D4 / S6)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  function findShip(state: SectorState, pid: string) {
    for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) return s;
    throw new Error('ship not found after join');
  }

  it('IGNORES initialHull/initialShield on a non-testMode room (spawns full HP)', async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: false });
    const pid = randomUUID();
    const cr = (await harness.connectActive(pid, {
      shipKind: 'fighter',
      initialHull: 10, // testMode-only; must be ignored here
      initialShield: 0, // testMode-only; must be ignored here
    })) as ClientRoom<SectorState>;
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });

    const state = getRoomById(cr.roomId).state as SectorState;
    const ship = findShip(state, pid);
    // Overrides ignored → spawned at full hull (== maxHealth, whatever the
    // current tuning makes it) and full shield, NOT the requested 10 / 0.
    expect(ship.health).not.toBe(10);
    expect(ship.health).toBe(ship.maxHealth);
    expect(ship.health).toBeGreaterThan(10);
    expect(ship.shield).toBeGreaterThan(0);
  }, 15_000);

  it('HONOURS initialHull on a testMode room (proves the gate is the only difference)', async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
    const pid = randomUUID();
    const cr = (await harness.connectActive(pid, {
      shipKind: 'fighter',
      initialHull: 10,
    })) as ClientRoom<SectorState>;
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });

    const ship = findShip(getRoomById(cr.roomId).state as SectorState, pid);
    expect(ship.health).toBe(10); // override honoured in testMode
    expect(ship.health).toBeLessThan(FIGHTER.maxHealth);
  }, 15_000);
});
