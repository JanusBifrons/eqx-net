/**
 * Macro terrain C5g: a power link never runs through a cut-field rock whose
 * chunk is NOT loaded (no ship near, so no body in the registry). Real
 * `place_structure` path: auto-connect on placement and the 1 Hz reconnect
 * sweep ask the room's `getObstacles(near)` with a box over the links they
 * may make, so the dormant rocks in it block like live ones
 * (`CutFieldSubsystem.dormantObstacles`). Control: a clear line still links.
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
import { rockObstacleParts, segmentHitsObstacle, type GridObstacle } from '../../../src/core/structures/Grid.js';
import { CONNECTION_MAX_RANGE } from '../../../src/core/structures/structureGridConstants.js';
import { linkReachBox } from '../../../src/server/structures/structureGridView.js';

let harness: SectorTestHarness | undefined;
afterEach(async () => { await harness?.cleanup(); harness = undefined; });

describe('SectorRoom integration — links past an unloaded cut-field rock (C5g)', () => {
  it('two connectors either side of a dormant rock do not link; a clear pair does', { timeout: 60_000 }, async () => {
    const o = cutFieldOpts('look'), { hw, hh } = structureHalfExtents('connector', 0);
    const shaped = (x0: number, y0: number, x1: number, y1: number): GridObstacle[] =>
      fieldRocksInBox(o, x0, y0, x1, y1).map((n) => { const b = fieldRockBody(n); return { x: n.x, y: n.y, radius: n.radius, parts: rockObstacleParts(b.verts, b.parts, true) }; });
    const clearAt = (x: number, y: number): boolean =>
      !clampToSectorBounds(x, y).clamped && placementRejection('connector', x, y, [], shaped(x - hw, y - hh, x + hw, y + hh)) === null;
    // A rock of the far chunk with two clear connector spots on opposite
    // sides, in link range, whose centre line crosses the rock's real shape.
    let pair: { ax: number; ay: number; bx: number; by: number; key: number } | null = null;
    for (const r of rocksInChunk(o, -8, 6)) {
      const b = fieldRockBody(r);
      for (let k = 0; k < 12 && pair === null; k++) {
        const ux = Math.cos((k / 12) * Math.PI), uy = Math.sin((k / 12) * Math.PI), d = b.radius + Math.hypot(hw, hh) + 10;
        const ax = b.x - ux * d, ay = b.y - uy * d, bx = b.x + ux * d, by = b.y + uy * d;
        if (Math.max(Math.abs(bx - ax) - 2 * hw, 0) ** 2 + Math.max(Math.abs(by - ay) - 2 * hh, 0) ** 2 > (CONNECTION_MAX_RANGE * 0.9) ** 2) continue;
        if (!clearAt(ax, ay) || !clearAt(bx, by)) continue;
        const rock: GridObstacle = { x: b.x, y: b.y, radius: b.radius, parts: rockObstacleParts(b.verts, b.parts, true) };
        if (segmentHitsObstacle(ax, ay, bx, by, rock)) pair = { ax, ay, bx, by, key: r.key };
      }
      if (pair) break;
    }
    expect(pair, 'two clear spots either side of a rock, in link range').not.toBeNull();
    // Control: open space at the field core, a clear line between the two.
    expect(shaped(-10, -10, 410, 10), 'the control line is clear of field rocks').toHaveLength(0);

    harness = await bootSectorTestServer({ sectorKey: null, cutField: { seed: 'look' }, asteroidConfig: [], defaultSpawnX: 60_000, defaultSpawnY: 0 });
    const client = await harness.connectActive(randomUUID());
    const int = (harness.getServerRoom() as unknown as SectorRoom)._internals;
    expect(int.swarmRegistry.get(fieldRockId(pair!.key)), 'the rock has no body (dormant)').toBeNull();

    async function place(x: number, y: number): Promise<string> {
      const before = new Set([...int.structureRegistry.all()].map((s) => s.id));
      client.send('place_structure', { type: 'place_structure', kind: 'connector', x, y });
      for (let i = 0; i < 20; i++) {
        await harness!.advance(25);
        const added = [...int.structureRegistry.all()].find((s) => !before.has(s.id));
        if (added) return added.id;
      }
      throw new Error(`connector at (${x}, ${y}) was not placed`);
    }

    const a = await place(pair!.ax, pair!.ay);
    const b = await place(pair!.bx, pair!.by);
    const c = await place(0, 0);
    const d = await place(400, 0);
    await harness.advance(2_500); // past a reconnect-sweep pulse (1 Hz)
    expect(int.swarmRegistry.get(fieldRockId(pair!.key)), 'still dormant').toBeNull();
    expect(int.structureRegistry.connectionCount(a), 'no link through the dormant rock').toBe(0);
    expect(int.structureRegistry.connectionCount(b)).toBe(0);
    expect(int.structureRegistry.connectionCount(c), 'a clear line links').toBe(1);
    expect(int.structureRegistry.connectionCount(d)).toBe(1);

    // Cost (printed, never asserted): one dormant query over a link-range box,
    // as auto-connect and each reconnect-sweep attempt make one.
    const box = { x0: 0, y0: 0, x1: 0, y1: 0 };
    expect(linkReachBox(int.structureRegistry, a, box), 'b is in range of a').toBe(true);
    const wide = { x0: pair!.ax - CONNECTION_MAX_RANGE, y0: pair!.ay - CONNECTION_MAX_RANGE, x1: pair!.ax + CONNECTION_MAX_RANGE, y1: pair!.ay + CONNECTION_MAX_RANGE };
    for (const [name, bx] of [['link box', box], ['± link range', wide]] as const) {
      const out: GridObstacle[] = [];
      const t0 = performance.now();
      for (let i = 0; i < 10; i++) { out.length = 0; int.cutFieldSub!.dormantObstacles(bx, out); }
      console.log(`[C5g] dormantObstacles ${name} ${Math.round(bx.x1 - bx.x0)}x${Math.round(bx.y1 - bx.y0)}: ${((performance.now() - t0) / 10).toFixed(2)} ms, ${out.length} rocks`);
    }
  });
});
