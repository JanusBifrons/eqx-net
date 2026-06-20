/**
 * Ship stat upgrade — integration lock for WS-B2 (Phase 4, plan:
 * effervescent-umbrella, invariant #13 "the behaviour lives at the
 * message → roster → echo seam").
 *
 * The pure budget/derivation is unit-locked in `src/core/leveling/shipStats.test.ts`;
 * the server==client physics multiplier in `applyShipInput.levelMultiplier.test.ts`;
 * the per-instance persistence in `PlayerShipStore.test.ts`. THIS test drives the
 * FULL server chain through a REAL galaxy room + a real colyseus.js client:
 *
 *   apply_ship_upgrade { shipId, alloc } → SectorRoom handler → ownership +
 *     isAllocValid(budget) gate → PlayerShipStore.setProgress(statAlloc) →
 *     live ShipState.statAlloc mirror + SET_STAT_MUL worker post → echo
 *     ship_upgrade_applied
 *
 * Asserts the locked decisions:
 *  - a valid allocation persists on the roster + echoes back (free allocation);
 *  - the point budget CANNOT be exceeded (over-budget is silently dropped);
 *  - a respec refunds every point (empty alloc round-trips);
 *  - a FOREIGN ship id is dropped (no cross-player upgrade).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';
import type { ShipUpgradeAppliedEvent } from '../../../src/shared-types/messages.js';

function getRoomById(roomId: string): SectorRoom {
  return matchMaker.getLocalRoomById(roomId) as unknown as SectorRoom;
}

/** Resolve the active hull's shipInstanceId for a player in this room. */
function shipInstanceFor(room: SectorRoom, playerId: string): string {
  const state = (room as unknown as { state: SectorState }).state;
  for (const [shipInstanceId, ship] of state.ships) {
    if (ship.playerId === playerId && ship.isActive) return shipInstanceId;
  }
  throw new Error(`no active hull for ${playerId}`);
}

/** Await the next `ship_upgrade_applied` echo for a given ship, or time out. */
function nextEcho(
  room: { onMessage: (t: string, cb: (m: ShipUpgradeAppliedEvent) => void) => void },
  shipId: string,
  timeoutMs = 2000,
): Promise<ShipUpgradeAppliedEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no ship_upgrade_applied echo')), timeoutMs);
    room.onMessage('ship_upgrade_applied', (m: ShipUpgradeAppliedEvent) => {
      if (m.shipInstanceId !== shipId) return;
      clearTimeout(timer);
      resolve(m);
    });
  });
}

describe('SectorRoom integration — ship stat upgrade (Phase 4 WS-B2)', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('a valid allocation persists on the roster + echoes back (free allocation)', async () => {
    const player = randomUUID();
    const cr = await harness.connectActive(player, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === player });
    const room = getRoomById(cr.roomId);
    const shipId = shipInstanceFor(room, player);

    // Grant a budget: level 6 ⇒ 5 points to spend.
    getPlayerShipStore().setProgress(shipId, { level: 6 });

    const echoP = nextEcho(cr, shipId);
    cr.send('apply_ship_upgrade', { type: 'apply_ship_upgrade', shipId, alloc: { topSpeed: 3, hull: 2 } });
    const echo = await echoP;

    expect(echo.alloc).toEqual({ topSpeed: 3, hull: 2 });
    expect(echo.spent).toBe(5);
    expect(echo.budget).toBe(5);
    // Persisted on the roster + mirrored on the live ShipState.
    expect(getPlayerShipStore().get(shipId)!.statAlloc).toEqual({ topSpeed: 3, hull: 2 });
    const state = (room as unknown as { state: SectorState }).state;
    expect(state.ships.get(shipId)!.statAlloc).toEqual({ topSpeed: 3, hull: 2 });
  });

  it('the point budget CANNOT be exceeded (over-budget is dropped, no persist)', async () => {
    const player = randomUUID();
    const cr = await harness.connectActive(player, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === player });
    const room = getRoomById(cr.roomId);
    const shipId = shipInstanceFor(room, player);

    // Level 3 ⇒ budget 2. Try to spend 4.
    getPlayerShipStore().setProgress(shipId, { level: 3, statAlloc: {} });

    let echoed = false;
    cr.onMessage('ship_upgrade_applied', (m: ShipUpgradeAppliedEvent) => {
      if (m.shipInstanceId === shipId) echoed = true;
    });
    cr.send('apply_ship_upgrade', { type: 'apply_ship_upgrade', shipId, alloc: { hull: 2, topSpeed: 2 } });
    // Give the server a beat to process (no echo expected).
    await new Promise((r) => setTimeout(r, 400));

    expect(echoed).toBe(false);
    expect(getPlayerShipStore().get(shipId)!.statAlloc).toEqual({}); // unchanged
  });

  it('a respec refunds every point (empty alloc round-trips)', async () => {
    const player = randomUUID();
    const cr = await harness.connectActive(player, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === player });
    const room = getRoomById(cr.roomId);
    const shipId = shipInstanceFor(room, player);

    getPlayerShipStore().setProgress(shipId, { level: 6, statAlloc: { damage: 4 } });

    const echoP = nextEcho(cr, shipId);
    cr.send('respec_ship', { type: 'respec_ship', shipId });
    const echo = await echoP;

    expect(echo.alloc).toEqual({});
    expect(echo.spent).toBe(0);
    expect(echo.budget).toBe(5);
    expect(getPlayerShipStore().get(shipId)!.statAlloc).toEqual({});
  });

  it('a FOREIGN ship id is dropped (no cross-player upgrade)', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const crA = await harness.connectActive(a, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === a });
    // B's connection activates its roster ship (the foreign target); the client
    // handle itself is unused after that.
    await harness.connectActive(b, { shipKind: 'scout' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === b });
    const room = getRoomById(crA.roomId);
    const shipB = shipInstanceFor(room, b);

    getPlayerShipStore().setProgress(shipB, { level: 6, statAlloc: {} });

    // Player A tries to upgrade player B's ship.
    let echoed = false;
    crA.onMessage('ship_upgrade_applied', (m: ShipUpgradeAppliedEvent) => {
      if (m.shipInstanceId === shipB) echoed = true;
    });
    crA.send('apply_ship_upgrade', { type: 'apply_ship_upgrade', shipId: shipB, alloc: { hull: 1 } });
    await new Promise((r) => setTimeout(r, 400));

    expect(echoed).toBe(false);
    expect(getPlayerShipStore().get(shipB)!.statAlloc).toEqual({}); // B's ship untouched
  });
});
