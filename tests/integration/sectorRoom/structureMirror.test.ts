/**
 * Build mirror (base loop job 4A): a structure placed with `mirror: true`
 * through the real `place_structure` message keeps the flag on its record and
 * sends it to clients in the room-state row's `flags` (the join payload and
 * every patch, #16), so a late joiner decodes it too.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { STRUCTURE_FLAG_MIRROR, type StructureStateView } from '../../../src/shared-types/structureStateWire.js';

describe('SectorRoom integration — mirrored structure placement (4A)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it('a Solar placed with mirror carries the flag on its record and its room-state row', async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
    const room = await harness.connectAs('player-1');
    await harness.advance(200);
    room.send('place_structure', { type: 'place_structure', kind: 'solar', x: 1500, y: 0, rot: 90, mirror: true });
    room.send('place_structure', { type: 'place_structure', kind: 'solar', x: -1500, y: 0 });
    await harness.advance(400);
    const internals = harness.getServerRoom()!._internals;
    const solars = [...internals.structureRegistry.all()].filter((r) => r.kind === 'solar');
    const flipped = solars.find((r) => r.x > 0);
    const plain = solars.find((r) => r.x < 0);
    expect(flipped?.mirror, 'the mirrored solar landed with its flag').toBe(true);
    expect(plain?.mirror, 'an unmirrored placement stores no flag').toBeUndefined();

    // A LATE joiner reads the flag from its join payload alone (#16).
    const late = await harness.connectAs('player-2');
    await harness.advance(200);
    const flagsOf = (id: string): number => {
      const row = late.state.structures.get(String(internals.swarmRegistry.get(id)!.entityId)) as unknown as StructureStateView | undefined;
      return row?.flags ?? 0;
    };
    expect(flagsOf(flipped!.id) & STRUCTURE_FLAG_MIRROR).toBe(STRUCTURE_FLAG_MIRROR);
    expect(flagsOf(plain!.id) & STRUCTURE_FLAG_MIRROR).toBe(0);
  });
});
