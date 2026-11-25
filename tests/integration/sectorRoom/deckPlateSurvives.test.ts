/**
 * Base platforms slice 9: a plate survives damage. On the deck room, the
 * (0,0) plate's anchor Connector destroyed in combat leaves a blueprint
 * Connector of the same owner on the same spot (the ordinary placement flow),
 * the plate stays in the derived set, and the blueprint is dark (an unbuilt
 * grid node, unpowered). With deck off, destruction removes it as before.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { matchMaker } from 'colyseus';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { DECK_TEST_OPTS } from '../../../src/server/rooms/testRooms/engineeringRooms.js';

function roomOf(roomId: string): SectorRoom {
  return matchMaker.getLocalRoomById(roomId) as unknown as SectorRoom;
}

describe('deck plate survives its connector', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  async function bootAndKill(deck: boolean) {
    harness = await bootSectorTestServer({ ...structuredClone(DECK_TEST_OPTS), deck } as Record<string, unknown>);
    const pilot = randomUUID();
    const cr = await harness.connectActive(pilot);
    const room = roomOf(cr.roomId);
    const internals = room._internals;
    const reg = internals.structureRegistry;
    const conn = [...reg.all()].find((s) => s.owner === pilot && s.kind === 'connector' && s.x === 0 && s.y === 0);
    expect(conn, 'origin connector').toBeDefined();
    expect(room.state.deck).toBe(deck);
    expect(reg.plates.hasPlate(pilot, 0, 0), 'the origin connector anchors plate (0,0)').toBe(true);
    internals.applyDamage(conn!.id, 'swarm-99', 999_999);
    expect(reg.get(conn!.id), 'the destroyed connector is gone').toBeUndefined();
    const left = [...reg.all()].filter((s) => s.kind === 'connector' && s.x === 0 && s.y === 0);
    return { pilot, room, internals, reg, left };
  }

  it('deck on: a blueprint connector of the same owner holds the plate, dark', { timeout: 30_000 }, async () => {
    const { pilot, internals, reg, left } = await bootAndKill(true);
    expect(left.length).toBe(1);
    const bp = left[0]!;
    expect(bp.owner).toBe(pilot);
    expect(bp.isConstructed, 'a blueprint, not a built connector').toBe(false);
    expect(bp.ghostBody, 'a non-colliding hologram').toBe(true);
    expect(reg.plates.hasPlate(pilot, 0, 0), 'the plate stays').toBe(true);
    // The grid pulse runs; the blueprint stays an unpowered, unbuilt node.
    internals.pulseStructureGrid();
    internals.rebuildStructuresSlice();
    const entityId = internals.swarmRegistry.get(bp.id)!.entityId;
    const row = internals.getStructuresSlice()!.find((r) => r.id === entityId);
    expect(row, 'blueprint row on the wire').toBeDefined();
    expect(row!.built).toBe(false);
    expect(row!.powered, 'the plate goes dark').toBe(false);
  });

  it('deck off: destruction removes the connector as before', { timeout: 30_000 }, async () => {
    const { pilot, reg, left } = await bootAndKill(false);
    expect(left.length).toBe(0);
    expect(reg.plates.hasPlate(pilot, 0, 0)).toBe(false);
  });
});
