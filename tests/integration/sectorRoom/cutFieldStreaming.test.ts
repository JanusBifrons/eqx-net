/**
 * Macro terrain v2, cut-field slice 1 (behind the `cutField` room option):
 * a pilot inside a cut field gets the chunks around it loaded as fixed rock
 * colliders, marked as field rocks so the swarm wire and the save skip them.
 * Counts only.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';

interface Room {
  _internals: {
    cutField: { stats: { chunksLoaded: number; rocksLoaded: number } } | undefined;
    swarmRegistry: { all(): Iterable<{ id: string; kind: number; fieldRock?: boolean }> };
  };
}

let harness: SectorTestHarness | undefined;
afterEach(async () => { await harness?.cleanup(); harness = undefined; });

describe('SectorRoom integration — cut-field streaming', () => {
  it('loads the chunks around a pilot as field rocks', { timeout: 60_000 }, async () => {
    // A point in the field's middle band, between the core hole and the rim.
    harness = await bootSectorTestServer({ sectorKey: null, cutField: { seed: 'look' }, asteroidConfig: [], defaultSpawnX: 60_000, defaultSpawnY: 0 });
    await harness.connectActive(randomUUID());
    const room = harness.getServerRoom() as unknown as Room;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && (room._internals.cutField?.stats.chunksLoaded ?? 0) < 25) await harness.advance(500);
    const stats = room._internals.cutField!.stats;
    expect(stats.chunksLoaded).toBe(25); // 5×5 around the pilot (wake radius 2)
    let field = 0;
    for (const rec of room._internals.swarmRegistry.all()) if (rec.fieldRock) { field++; expect(rec.kind).toBe(0); }
    expect(field).toBe(stats.rocksLoaded);
    expect(field).toBeGreaterThan(50);
  });
});
