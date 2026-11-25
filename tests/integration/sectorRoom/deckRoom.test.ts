/**
 * `?room=deck` (base-platforms prototype): boots the EXACT options the server
 * registers. The room's synced `deck` flag is on (and reaches the joining
 * client in its state, invariant 16), and the first joiner owns a Capital and
 * a Connector at the world origin. A room without the option keeps it off.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { matchMaker } from 'colyseus';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { BASE_BUILD_TEST_OPTS, DECK_TEST_OPTS } from '../../../src/server/rooms/testRooms/engineeringRooms.js';
import { deckHexCentreInto } from '../../../src/core/hex/plates.js';

function roomOf(roomId: string): SectorRoom {
  return matchMaker.getLocalRoomById(roomId) as unknown as SectorRoom;
}

describe('deck room flag', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it('the deck room has deck on, and the joiner owns a Capital + origin Connector', { timeout: 30_000 }, async () => {
    harness = await bootSectorTestServer(structuredClone(DECK_TEST_OPTS) as Record<string, unknown>);
    const pilot = randomUUID();
    const cr = await harness.connectActive(pilot);
    const room = roomOf(cr.roomId);
    expect(room.state.deck).toBe(true);
    expect((cr.state as unknown as { deck?: boolean }).deck, 'client state carries the flag').toBe(true);
    const mine = [...room._internals.structureRegistry.all()].filter((s) => s.owner === pilot);
    const cap = mine.filter((s) => s.kind === 'capital' && s.isConstructed);
    expect(cap.length).toBe(1);
    const conn = mine.filter((s) => s.kind === 'connector');
    expect(conn.length).toBe(1);
    expect(conn[0]!.x).toBe(0);
    expect(conn[0]!.y).toBe(0);
    // The Capital sits in its slot: the centre of the plate's lower-right outer
    // hex (not straddling seams), and the plate-connector rule cables it.
    const slot = deckHexCentreInto(1, -1, { x: 0, y: 0 });
    expect(Math.hypot(cap[0]!.x - slot.x, cap[0]!.y - slot.y)).toBeLessThan(1e-6);
    expect(Math.hypot(cap[0]!.x, cap[0]!.y)).toBeCloseTo(1300, 0);
    const links = room._internals.structureRegistry.adjacencyMap().get(conn[0]!.id) ?? [];
    expect(links.some((c) => c.getOtherNode(conn[0]!.id) === cap[0]!.id), 'connector cabled to the Capital').toBe(true);
  });

  it('a room without the option keeps deck off', { timeout: 30_000 }, async () => {
    harness = await bootSectorTestServer(structuredClone(BASE_BUILD_TEST_OPTS) as Record<string, unknown>);
    const cr = await harness.connectActive(randomUUID());
    expect(roomOf(cr.roomId).state.deck).toBe(false);
    expect((cr.state as unknown as { deck?: boolean }).deck).toBe(false);
  });

  it('deck is ignored outside testMode (create options are client-suppliable)', { timeout: 30_000 }, async () => {
    harness = await bootSectorTestServer({ deck: true, testMode: false, asteroidConfig: [], droneCount: 0 });
    const cr = await harness.connectActive(randomUUID());
    expect(roomOf(cr.roomId).state.deck).toBe(false);
  });
});
