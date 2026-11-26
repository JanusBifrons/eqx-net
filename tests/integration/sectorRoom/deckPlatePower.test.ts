/**
 * Base platforms slice 10: on the deck room, a Solar placed on an outer hex
 * of the (0,0) plate (~1300 u from its connector, past `CONNECTION_MAX_RANGE`)
 * cables to the plate's connector, fills in from the Capital through it and
 * powers up (`canConnect`'s deck rule, fed `StructureRegistry.deck`).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { matchMaker } from 'colyseus';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { DECK_TEST_OPTS } from '../../../src/server/rooms/testRooms/engineeringRooms.js';
import { HEX_DIRS } from '../../../src/core/hex/hex.js';
import { deckHexCentreInto } from '../../../src/core/hex/plates.js';
import { CONNECTION_MAX_RANGE } from '../../../src/core/structures/structureGridConstants.js';

function roomOf(roomId: string): SectorRoom {
  return matchMaker.getLocalRoomById(roomId) as unknown as SectorRoom;
}

/** The (0,0) plate's outer hex furthest north (clear of the Capital). */
function northHex(): { x: number; y: number } {
  let best = { x: 0, y: -Infinity };
  for (const d of HEX_DIRS) {
    const p = deckHexCentreInto(d.q, d.r, { x: 0, y: 0 });
    if (p.y > best.y) best = p;
  }
  return best;
}

describe('deck plate power', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it('a Solar on the plate’s outer hex cables to the plate connector and powers up', { timeout: 45_000 }, async () => {
    harness = await bootSectorTestServer(structuredClone(DECK_TEST_OPTS) as Record<string, unknown>);
    const pilot = randomUUID();
    const cr = await harness.connectActive(pilot);
    const internals = roomOf(cr.roomId)._internals;
    const reg = internals.structureRegistry;
    const conn = [...reg.all()].find((s) => s.owner === pilot && s.kind === 'connector' && s.x === 0 && s.y === 0)!;
    const cap = [...reg.all()].find((s) => s.owner === pilot && s.kind === 'capital')!;
    expect(conn && cap).toBeTruthy();
    const before = new Set([...reg.all()].map((s) => s.id));
    const at = northHex();
    expect(Math.hypot(at.x, at.y)).toBeGreaterThan(CONNECTION_MAX_RANGE * 2);
    cr.send('place_structure', { type: 'place_structure', kind: 'solar', x: at.x, y: at.y });
    let id: string | undefined;
    for (let i = 0; i < 75 && id === undefined; i++) {
      await harness.advance(40);
      id = [...reg.all()].find((s) => !before.has(s.id))?.id;
    }
    expect(id, 'solar placed').toBeDefined();
    const solar = reg.get(id!)!;
    expect(Math.hypot(solar.x - at.x, solar.y - at.y), 'on the hex centre').toBeLessThan(1);
    const linked = (a: string, b: string): boolean => (reg.adjacencyMap().get(a) ?? []).some((c) => c.getOtherNode(a) === b);
    expect(linked(solar.id, conn.id), 'solar cabled to the plate connector').toBe(true);
    expect(linked(conn.id, cap.id), 'connector cabled to the Capital').toBe(true);
    const eid = internals.swarmRegistry.get(id!)!.entityId;
    const row = () => (internals.getStructuresSlice() ?? []).find((r) => r.id === eid);
    for (let i = 0; i < 400 && !(solar.isConstructed && row()?.powered); i++) await harness.advance(50);
    expect(solar.isConstructed, 'solar filled in from the Capital through the connector').toBe(true);
    expect(row()?.powered, 'solar powered').toBe(true);
  });
});
