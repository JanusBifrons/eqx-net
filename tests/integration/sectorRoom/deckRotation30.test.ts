/**
 * Base platforms slice 15: a player's `place_structure` turns by the room rule.
 * On the deck room a 30° rot lands as rot 30 in the registry with a body turned
 * π/6 (the pose the swarm wire sends); with deck off the same message snaps to
 * the quarter grid (0°), as before. The restore path (`place()` from a saved
 * row) keeps a 30° turn whatever the room's flag, so a save loads facing the
 * same way.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { matchMaker } from 'colyseus';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { StructurePlacementSubsystem } from '../../../src/server/structures/StructurePlacementSubsystem.js';
import { DECK_TEST_OPTS } from '../../../src/server/rooms/testRooms/engineeringRooms.js';

function roomOf(roomId: string): SectorRoom {
  return matchMaker.getLocalRoomById(roomId) as unknown as SectorRoom;
}

describe('structure rotation in 30° steps (base platforms 15)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  async function placeSolarAt30(deck: boolean) {
    harness = await bootSectorTestServer({ ...structuredClone(DECK_TEST_OPTS), deck } as Record<string, unknown>);
    const pilot = randomUUID();
    const cr = await harness.connectActive(pilot);
    const room = roomOf(cr.roomId);
    expect(room.state.deck).toBe(deck);
    cr.send('place_structure', { type: 'place_structure', kind: 'solar', x: 2600, y: 1500, rot: 30 });
    await harness.advance(400);
    const internals = room._internals;
    const rec = [...internals.structureRegistry.all()].find((s) => s.owner === pilot && s.kind === 'solar');
    expect(rec, 'the solar landed').toBeDefined();
    return { room, internals, rec: rec! };
  }

  it('deck on: rot 30 is kept and the body (wire pose) turns π/6', { timeout: 30_000 }, async () => {
    const { internals, rec } = await placeSolarAt30(true);
    expect(rec.rot).toBe(30);
    expect(internals.swarmPose(rec.id)!.angle).toBeCloseTo(Math.PI / 6, 4);
  });

  it('deck off: the same message snaps to a quarter turn (0°)', { timeout: 30_000 }, async () => {
    const { internals, rec } = await placeSolarAt30(false);
    expect(rec.rot ?? 0).toBe(0);
    expect(internals.swarmPose(rec.id)!.angle).toBeCloseTo(0, 4);
  });

  it('the restore path (place() with a saved rot) keeps 30° even with deck off', { timeout: 30_000 }, async () => {
    const { room, internals } = await placeSolarAt30(false);
    const placement = (room as unknown as { structurePlacement: StructurePlacementSubsystem }).structurePlacement;
    const id = placement.place('restored-owner', 'solar', -3000, -3000, { rot: 30 });
    expect(id, 'restored solar placed').not.toBeNull();
    expect(internals.structureRegistry.get(id!)!.rot).toBe(30);
    expect(internals.swarmPose(id!)!.angle).toBeCloseTo(Math.PI / 6, 4);
  });
});
