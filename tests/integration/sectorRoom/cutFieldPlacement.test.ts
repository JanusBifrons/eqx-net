/**
 * Macro terrain C5: structure placement refuses a footprint on a cut-field
 * rock whose chunk is NOT loaded (no ship near, so no body in the registry),
 * as if the rock were there. Real `place_structure` path: the room's
 * `getObstacles(near)` adds the dormant rocks cut from the layout
 * (`CutFieldSubsystem.dormantObstacles`). A broken-up rock no longer blocks.
 * C5b: a dormant rock refuses only a footprint on its real shape (its
 * collider parts), not anywhere in its bounding circle.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { cutFieldOpts, fieldRockBody, fieldRockId, fieldRocksInBox } from '../../../src/core/terrain/chunkStreamer.js';
import { rocksInChunk } from '../../../src/core/terrain/fieldLayout.js';
import { structureHalfExtents } from '../../../src/shared-types/structureKinds.js';
import { clampToSectorBounds } from '../../../src/shared-types/sectorBounds.js';
import { placementRejection } from '../../../src/core/structures/placementRules.js';
import { convexHullCCW } from '../../../src/core/swarm/asteroidShape.js';

let harness: SectorTestHarness | undefined;
afterEach(async () => { await harness?.cleanup(); harness = undefined; });

describe('SectorRoom integration — placement on an unloaded cut-field rock (C5)', () => {
  it('is refused while the rock exists, and allowed once it is broken up', { timeout: 60_000 }, async () => {
    // A rock of the `cut-field-test` room's chunk that alone covers a
    // connector's footprint at its centre; the player spawns ~95 km away.
    const o = cutFieldOpts('look'), { hw, hh } = structureHalfExtents('connector', 0);
    const rock = rocksInChunk(o, -8, 6).find((r) => {
      const b = fieldRockBody(r), under = fieldRocksInBox(o, b.x - hw, b.y - hh, b.x + hw, b.y + hh);
      return under.length === 1 && under[0]!.key === r.key;
    })!;
    expect(rock, 'a rock alone under a connector').toBeDefined();
    const body = fieldRockBody(rock);
    expect(clampToSectorBounds(body.x, body.y).clamped, 'the rock is inside the playable bounds').toBe(false);

    harness = await bootSectorTestServer({ sectorKey: null, cutField: { seed: 'look' }, asteroidConfig: [], defaultSpawnX: 60_000, defaultSpawnY: 0 });
    const client = await harness.connectActive(randomUUID());
    const int = (harness.getServerRoom() as unknown as SectorRoom)._internals;
    // Streaming runs (rocks near the ship load) but the target's chunk does not.
    let streamed = false;
    const deadline = Date.now() + 20_000;
    while (!streamed && Date.now() < deadline) {
      await harness.advance(500);
      for (const r of int.swarmRegistry.all()) if (r.fieldRock === true) { streamed = true; break; }
    }
    expect(streamed, 'field rocks stream in near the ship').toBe(true);
    expect(int.swarmRegistry.get(fieldRockId(rock.key)), 'the target rock has no body').toBeNull();

    async function place(x: number, y: number): Promise<boolean> {
      const before = [...int.structureRegistry.all()].length;
      client.send('place_structure', { type: 'place_structure', kind: 'connector', x, y });
      for (let i = 0; i < 20; i++) {
        await harness!.advance(25);
        if ([...int.structureRegistry.all()].length > before) return true;
      }
      return false;
    }

    expect(await place(body.x, body.y), 'a connector on the unloaded rock is refused').toBe(false);
    expect(await place(0, 0), 'open space (the field core) is fine').toBe(true);
    int.cutFieldSub!.markConsumed(rock.key);
    expect(await place(body.x, body.y), 'a broken-up rock no longer blocks').toBe(true);
  });

  it('accepts a footprint inside a rock\'s bounding circle but clear of its outline (C5b)', { timeout: 60_000 }, async () => {
    // A spot in the same far chunk that a rock's bounding circle covers but
    // no rock's real shape (collider parts, as the server builds them) does.
    const o = cutFieldOpts('look'), { hw, hh } = structureHalfExtents('connector', 0);
    let spot: { x: number; y: number; key: number } | null = null;
    for (const r of rocksInChunk(o, -8, 6)) {
      const b = fieldRockBody(r);
      for (let k = 0; k < 24 && spot === null; k++) {
        const a = (k / 24) * Math.PI * 2, d = b.radius * (0.55 + 0.4 * ((k * 7) % 5) / 4);
        const x = b.x + Math.cos(a) * d, y = b.y + Math.sin(a) * d;
        if (clampToSectorBounds(x, y).clamped) continue;
        const near = fieldRocksInBox(o, x - hw, y - hh, x + hw, y + hh);
        if (!near.some((n) => n.key === r.key)) continue; // the circle reaches the footprint
        const shaped = near.map((n) => { const nb = fieldRockBody(n); return { x: n.x, y: n.y, radius: n.radius, parts: nb.parts ?? [convexHullCCW(nb.verts)] }; });
        if (placementRejection('connector', x, y, [], shaped) === null) spot = { x, y, key: r.key };
      }
      if (spot) break;
    }
    expect(spot, 'a spot inside a rock\'s circle but off its outline').not.toBeNull();
    const circleOnly = fieldRocksInBox(o, spot!.x - hw, spot!.y - hh, spot!.x + hw, spot!.y + hh).map((n) => ({ x: n.x, y: n.y, radius: n.radius }));
    expect(placementRejection('connector', spot!.x, spot!.y, [], circleOnly), 'the bounding circle alone refuses it').toBe('overlap-obstacle');

    harness = await bootSectorTestServer({ sectorKey: null, cutField: { seed: 'look' }, asteroidConfig: [], defaultSpawnX: 60_000, defaultSpawnY: 0 });
    const client = await harness.connectActive(randomUUID());
    const int = (harness.getServerRoom() as unknown as SectorRoom)._internals;
    expect(int.swarmRegistry.get(fieldRockId(spot!.key)), 'the rock has no body (dormant)').toBeNull();
    const before = [...int.structureRegistry.all()].length;
    client.send('place_structure', { type: 'place_structure', kind: 'connector', x: spot!.x, y: spot!.y });
    let placed = false;
    for (let i = 0; i < 20 && !placed; i++) {
      await harness.advance(25);
      placed = [...int.structureRegistry.all()].length > before;
    }
    expect(placed, 'a connector next to the dormant rock, off its outline, is placed').toBe(true);
  });
});
