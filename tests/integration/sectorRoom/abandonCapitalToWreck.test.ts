/**
 * Player capitals stream (owner, 2026-11-17: "Break into a wreck"): an
 * abandoned CAPITAL breaks into a wreck where it sat, the same break-up as its
 * death, instead of vanishing (a capital has no scrap groups, so the scrap-only
 * abandon left nothing at all). Small hulls still shatter to scrap
 * (`abandonToScrap.test.ts`, `abandonLingeringToScrap.test.ts`).
 *
 * COVERS (through the real 30-tick abandon poll):
 *   1. Active destroyer → store.delete → hull leaves state.ships, wreck pieces
 *      (swarm kind 4) appear, the session is told.
 *   2. Lingering destroyer (owner flying another hull) → store.delete → wreck
 *      pieces appear; the owner's active hull is untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';
import { SWARM_KIND_WRECK } from '../../../src/shared-types/swarmWireFormat.js';

function getRoomById(roomId: string): SectorRoom {
  return matchMaker.getLocalRoomById(roomId) as unknown as SectorRoom;
}

function wreckCount(internal: SectorRoom['_internals']): number {
  return [...internal.swarmRegistry.all()].filter((r) => r.kind === SWARM_KIND_WRECK).length;
}

function activeShipOf(state: SectorState, pid: string): string {
  for (const [, ship] of state.ships) if (ship.playerId === pid && ship.isActive) return ship.shipInstanceId;
  return '';
}

describe('SectorRoom integration — an abandoned capital breaks into a wreck', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, capitalWrecks: true, asteroidConfig: [],
    });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  async function waitGone(state: SectorState, shipId: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && state.ships.get(shipId) !== undefined) await harness.advance(50);
  }

  it('an active destroyer, abandoned, leaves wreck pieces where it sat', async () => {
    const pid = randomUUID();
    // Direct joinOrCreate (not connectActive): abandon calls client.leave(1000)
    // on the owner, which would hang the afterEach leave ack.
    const client = await harness.client.joinOrCreate('test-sector', {
      playerId: pid, shipKind: 'destroyer', spawnX: 900, spawnY: -400,
    });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });
    client.send('client_ready', { type: 'client_ready' });
    await harness.advance(800);

    const room = getRoomById(client.roomId);
    const state = room.state as SectorState;
    const internal = room._internals;
    const shipId = activeShipOf(state, pid);
    expect(shipId).not.toBe('');
    expect(state.ships.get(shipId)!.kind).toBe('destroyer');
    expect(wreckCount(internal)).toBe(0);

    let abandoned: string | null = null;
    client.onMessage('ship_abandoned', (msg: unknown) => { abandoned = (msg as { shipInstanceId: string }).shipInstanceId; });

    getPlayerShipStore().delete(shipId);
    await waitGone(state, shipId);

    expect(state.ships.get(shipId), 'abandoned hull leaves state.ships').toBeUndefined();
    expect(wreckCount(internal), 'the capital broke into wreck pieces').toBeGreaterThan(0);
    expect(getPlayerShipStore().get(shipId)).toBeNull();
    expect(abandoned).toBe(shipId);
  }, 20_000);

  it('a lingering destroyer, abandoned, breaks into a wreck and the active hull is untouched', async () => {
    const pid = randomUUID();
    const cr1 = await harness.connectActive(pid, { shipKind: 'destroyer', spawnX: 700, spawnY: -500 });
    const state = getRoomById(cr1.roomId).state as SectorState;
    const origId = activeShipOf(state, pid);
    expect(origId).not.toBe('');

    await harness.disconnectClient(cr1);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === pid });

    const cr2 = await harness.connectActive(pid, { isNewShip: true, shipKind: 'scout', spawnX: -3000, spawnY: 2000 });
    const internal = getRoomById(cr2.roomId)._internals;
    const activeId = activeShipOf(state, pid);
    expect(activeId).not.toBe(origId);
    expect(state.ships.get(origId)!.isActive).toBe(false);
    expect(wreckCount(internal)).toBe(0);

    getPlayerShipStore().delete(origId);
    await waitGone(state, origId);

    expect(state.ships.get(origId), 'abandoned lingering hull leaves state.ships').toBeUndefined();
    expect(wreckCount(internal), 'the capital broke into wreck pieces').toBeGreaterThan(0);
    const active = state.ships.get(activeId);
    expect(active?.isActive).toBe(true);
    expect(active?.alive).toBe(true);

    await harness.disconnectClient(cr2);
  }, 25_000);
});
