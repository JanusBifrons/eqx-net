/**
 * Base platforms slice 19: on the deck room, two shield pylons dropped near
 * the two ends of one hex edge snap onto the corners (`snapPlacementToDeck`)
 * and link along the seam (`canConnect`'s deck fence rule, fed
 * `StructureRegistry.deck`), so the shield wall runs on the seam.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { matchMaker } from 'colyseus';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { DECK_TEST_OPTS } from '../../../src/server/rooms/testRooms/engineeringRooms.js';
import { HEX_DIRS, hexCornerInto } from '../../../src/core/hex/hex.js';
import { DECK_HEX_SIZE, deckHexCentreInto } from '../../../src/core/hex/plates.js';

function roomOf(roomId: string): SectorRoom {
  return matchMaker.getLocalRoomById(roomId) as unknown as SectorRoom;
}

/** The two corners of the edge between the (0,0) plate's middle hex and its
 *  northmost outer hex (clear of the Capital). */
function northSeam(): Array<{ x: number; y: number }> {
  let best = { x: 0, y: -Infinity };
  for (const d of HEX_DIRS) {
    const p = deckHexCentreInto(d.q, d.r, { x: 0, y: 0 });
    if (p.y > best.y) best = p;
  }
  const mid = deckHexCentreInto(0, 0, { x: 0, y: 0 });
  const corners: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < 6; i++) corners.push(hexCornerInto(best.x, best.y, DECK_HEX_SIZE, i, { x: 0, y: 0 }));
  corners.sort((a, b) => Math.hypot(a.x - mid.x, a.y - mid.y) - Math.hypot(b.x - mid.x, b.y - mid.y));
  return corners.slice(0, 2);
}

describe('deck fence', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it('two pylons near a seam snap to its corners and link along it', { timeout: 45_000 }, async () => {
    harness = await bootSectorTestServer(structuredClone(DECK_TEST_OPTS) as Record<string, unknown>);
    const pilot = randomUUID();
    const cr = await harness.connectActive(pilot);
    const reg = roomOf(cr.roomId)._internals.structureRegistry;
    const seam = northSeam();
    expect(Math.hypot(seam[1]!.x - seam[0]!.x, seam[1]!.y - seam[0]!.y)).toBeCloseTo(DECK_HEX_SIZE, 3);
    const ids: string[] = [];
    for (const c of seam) {
      const before = new Set([...reg.all()].map((s) => s.id));
      cr.send('place_structure', { type: 'place_structure', kind: 'shield_pylon', x: c.x + 60, y: c.y - 40 });
      let id: string | undefined;
      for (let i = 0; i < 75 && id === undefined; i++) {
        await harness.advance(40);
        id = [...reg.all()].find((s) => !before.has(s.id))?.id;
      }
      expect(id, 'pylon placed').toBeDefined();
      const rec = reg.get(id!)!;
      expect(Math.hypot(rec.x - c.x, rec.y - c.y), 'on the corner').toBeLessThan(1);
      ids.push(id!);
    }
    const linked = (reg.adjacencyMap().get(ids[0]!) ?? []).some((c) => c.getOtherNode(ids[0]!) === ids[1]);
    expect(linked, 'pylons linked along the seam').toBe(true);
  });
});
