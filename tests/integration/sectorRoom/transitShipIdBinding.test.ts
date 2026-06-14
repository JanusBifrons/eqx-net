/**
 * Phase A coverage lock — TransitOrchestrator × SectorRoom × PlayerShipStore
 * shipId-validation integration.
 *
 * UNCOVERED PRIOR: `TransitOrchestrator.test.ts` covers the shipId
 * validation gate with a MOCKED room + MOCKED store + mocked reserve
 * function. There's no test that the wiring inside `SectorRoom.onCreate`
 * actually passes the right `PlayerShipStore` into the orchestrator
 * constructor and that an `engage_transit` Colyseus message reaches the
 * gate at all.
 *
 * COVERS (Phase A9 of `humble-strolling-coral.md`):
 *   1. engage_transit with a foreign shipId → server replies
 *      transit_state DOCKED with reason 'destination_unavailable'.
 *      Locks the ownership check (the load-bearing anti-hijack).
 *   2. engage_transit with own shipId on a real neighbour → server
 *      replies transit_state SPOOLING. We cancel before the spool
 *      timer fires; this is a wiring test, not a full transit test.
 *   3. engage_transit with an unknown (random UUID) shipId → DOCKED
 *      'destination_unavailable' (same rejection path).
 *   4. engage_transit to a non-neighbour sector → DOCKED 'not_neighbour'
 *      (regression-locks the galaxy-graph check).
 *
 * NOT COVERED: the full source-room-park + destination-room-bind
 * round-trip. That requires two distinct SectorRoom definitions and
 * a multi-room harness. Left out per the plan; the source-side
 * orchestrator path is locked at the unit level (TransitOrchestrator.test.ts)
 * and the destination-side hydrate is locked by the shipId-binding test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';
import type { TransitStateMessage } from '../../../src/shared-types/messages.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRoom = any;

async function waitForTransitState(
  room: AnyRoom,
  predicate: (msg: TransitStateMessage) => boolean,
  timeoutMs = 2000,
): Promise<TransitStateMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('transit_state timeout')), timeoutMs);
    room.onMessage('transit_state', (msg: unknown) => {
      const m = msg as TransitStateMessage;
      if (predicate(m)) {
        clearTimeout(timer);
        resolve(m);
      }
    });
  });
}

describe('SectorRoom × TransitOrchestrator × PlayerShipStore — shipId wiring', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    // Source sector must be a real galaxy key for the neighbour check
    // in TransitOrchestrator.beginTransit to evaluate correctly.
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime',
      droneCount: 0,
      testMode: true,
    });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('foreign shipId → DOCKED destination_unavailable', async () => {
    // Seed a row owned by SOMEONE ELSE.
    const ownerPid = randomUUID();
    const store = getPlayerShipStore();
    const foreignShip = store.create({
      playerId: ownerPid,
      userId: null,
      kind: 'fighter',
      sectorKey: 'vega-reach',
      x: 0,
      y: 0,
      health: 100,
    });

    const attackerPid = randomUUID();
    const room = await harness.connectAs(attackerPid, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === attackerPid });

    // First transit_state arrives unprompted (initial DOCKED on join);
    // we wait for one with reason='destination_unavailable' explicitly.
    const dockedPromise = waitForTransitState(
      room,
      (m) => m.state === 'DOCKED' && m.reason === 'destination_unavailable',
      3000,
    );

    room.send('engage_transit', {
      type: 'engage_transit',
      targetSectorKey: 'vega-reach',
      shipId: foreignShip.shipId,
    });

    const result = await dockedPromise;
    expect(result.state).toBe('DOCKED');
    expect(result.reason).toBe('destination_unavailable');
  });

  it('unknown shipId (random uuid) → DOCKED destination_unavailable', async () => {
    const pid = randomUUID();
    const room = await harness.connectAs(pid, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });

    const dockedPromise = waitForTransitState(
      room,
      (m) => m.state === 'DOCKED' && m.reason === 'destination_unavailable',
      3000,
    );

    room.send('engage_transit', {
      type: 'engage_transit',
      targetSectorKey: 'vega-reach',
      shipId: 'nonexistent-' + randomUUID(),
    });

    const result = await dockedPromise;
    expect(result.reason).toBe('destination_unavailable');
  });

  it('non-neighbour target → DOCKED not_neighbour (regardless of shipId)', async () => {
    const pid = randomUUID();
    const room = await harness.connectAs(pid, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });

    const dockedPromise = waitForTransitState(
      room,
      (m) => m.state === 'DOCKED' && m.reason === 'not_neighbour',
      3000,
    );

    // A fictitious sectorKey is the simplest non-neighbour: the gate calls
    // `isNeighbour('sol-prime', target)`, which returns false for any key not
    // in sol-prime's neighbour list (vega-reach / lyra-fringe / cygnus-arm).
    room.send('engage_transit', {
      type: 'engage_transit',
      targetSectorKey: 'not-a-real-sector',
    });

    const result = await dockedPromise;
    expect(result.reason).toBe('not_neighbour');
  });

  it('own shipId on a real neighbour → SPOOLING (then we cancel)', async () => {
    const pid = randomUUID();
    const room = await harness.connectAs(pid, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });

    // Seed an OWN shipId in the destination sector.
    const store = getPlayerShipStore();
    const own = store.create({
      playerId: pid,
      userId: null,
      kind: 'fighter',
      sectorKey: 'vega-reach',
      x: 0,
      y: 0,
      health: 100,
    });

    const spoolPromise = waitForTransitState(
      room,
      (m) => m.state === 'SPOOLING' && m.targetSectorKey === 'vega-reach',
      3000,
    );

    room.send('engage_transit', {
      type: 'engage_transit',
      targetSectorKey: 'vega-reach',
      shipId: own.shipId,
    });

    const spoolMsg = await spoolPromise;
    expect(spoolMsg.state).toBe('SPOOLING');
    expect(spoolMsg.targetSectorKey).toBe('vega-reach');
    expect(typeof spoolMsg.spoolMs).toBe('number');

    // Cancel so the 3 s timer doesn't fire commitTransit → reserveSeatFor
    // → matchMaker lookup for 'galaxy-vega-reach' which doesn't exist
    // in our single-room harness.
    room.send('cancel_transit', { type: 'cancel_transit' });
    await harness.advance(200);
  });
});
