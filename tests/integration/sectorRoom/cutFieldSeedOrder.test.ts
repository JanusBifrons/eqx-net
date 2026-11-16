/**
 * Macro terrain C5: structures seeded when the room is created (a test
 * scenario, a generated NPC base) see the cut field's rocks. The cut-field
 * subsystem is built BEFORE the seeding, so placement's `getObstacles(near)`
 * already adds the dormant field rocks: a footprint on a rock is refused.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { cutFieldOpts, fieldRockBody, fieldRocksInBox } from '../../../src/core/terrain/chunkStreamer.js';
import { rocksInChunk } from '../../../src/core/terrain/fieldLayout.js';
import { structureHalfExtents } from '../../../src/shared-types/structureKinds.js';
import { clampToSectorBounds } from '../../../src/shared-types/sectorBounds.js';
import { placementRejection } from '../../../src/core/structures/placementRules.js';
import { rockObstacleParts } from '../../../src/core/structures/Grid.js';

let harness: SectorTestHarness | undefined;
afterEach(async () => { await harness?.cleanup(); harness = undefined; });

describe('SectorRoom integration — structures seeded at room create see the cut field (C5)', () => {
  it('a scenario structure on a field rock is refused; one in open space is placed', { timeout: 60_000 }, async () => {
    const o = cutFieldOpts('look'), { hw, hh } = structureHalfExtents('connector', 0);
    const rock = rocksInChunk(o, -8, 6).find((r) => {
      const b = fieldRockBody(r);
      return fieldRocksInBox(o, b.x - hw, b.y - hh, b.x + hw, b.y + hh).length > 0 && !clampToSectorBounds(b.x, b.y).clamped;
    })!;
    expect(rock, 'a field rock inside the playable bounds').toBeDefined();
    const body = fieldRockBody(rock);

    harness = await bootSectorTestServer({
      sectorKey: null, cutField: { seed: 'look' }, asteroidConfig: [], defaultSpawnX: 60_000, defaultSpawnY: 0,
      prebuiltStructures: [{ kind: 'connector', x: body.x, y: body.y }, { kind: 'connector', x: 0, y: 0 }],
    });
    await harness.connectActive(randomUUID()); // the room is created on the first join
    const int = (harness.getServerRoom() as unknown as SectorRoom)._internals;
    const placed = [...int.structureRegistry.all()];
    expect(placed.length, 'the open-space connector is placed (the seeding ran)').toBeGreaterThan(0);
    for (const s of placed) {
      const { hw: sw, hh: sh } = structureHalfExtents(s.kind, 0);
      const rocks = fieldRocksInBox(o, s.x - sw * 2, s.y - sh * 2, s.x + sw * 2, s.y + sh * 2).map((r) => {
        const b = fieldRockBody(r);
        return { x: r.x, y: r.y, radius: r.radius, angle: 0, parts: rockObstacleParts(b.verts, b.parts, true) };
      });
      expect(placementRejection(s.kind, s.x, s.y, [], rocks), `${s.kind} at (${s.x.toFixed(0)}, ${s.y.toFixed(0)}) sits on a field rock`).toBeNull();
    }
  });
});
