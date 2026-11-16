/**
 * Macro terrain C1b: a shot at a cut-field rock hits the rock where it is
 * drawn (its convex parts, the same ones its collider is built from), not the
 * convex hull of its outline. A beam fired from inside a dent travels across
 * the open dent before it meets rock; with the hull test it started "inside"
 * the rock and hit at once.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { convexHullCCW as convexHull } from '../../../src/core/swarm/asteroidShape.js';

let harness: SectorTestHarness | undefined;
afterEach(async () => { await harness?.cleanup(); harness = undefined; });

/** The dent spot `tests/e2e/cut-field-collision.spec.ts` parks a ship in
 *  (seed `look`): 48 u inside a rock's hull, 40 u clear of its parts. */
const DENT = { x: -30_698, y: 25_366 };

function insideConvex(poly: readonly { x: number; y: number }[], px: number, py: number): boolean {
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k]!, b = poly[(k + 1) % poly.length]!;
    if ((b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x) < 0) return false;
  }
  return true;
}

describe('SectorRoom integration — weapon hits on cut-field rocks (C1b)', () => {
  it('a beam from inside a dent crosses the open dent before it hits rock', { timeout: 60_000 }, async () => {
    harness = await bootSectorTestServer({ sectorKey: null, cutField: { seed: 'look' }, asteroidConfig: [], defaultSpawnX: DENT.x + 3000, defaultSpawnY: DENT.y });
    const pid = randomUUID();
    await harness.connectActive(pid);
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const int = room._internals;
    let rock: { id: string; x: number; y: number; vertices?: ReadonlyArray<{ x: number; y: number }>; wreckParts?: unknown } | undefined;
    const deadline = Date.now() + 20_000;
    while (!rock && Date.now() < deadline) {
      await harness.advance(500);
      for (const r of int.swarmRegistry.all()) {
        if (r.fieldRock !== true || !r.vertices || r.restX === undefined || r.restY === undefined) continue;
        const hull = convexHull(r.vertices.map((v) => ({ x: v.x, y: v.y })));
        if (insideConvex(hull, DENT.x - r.restX, DENT.y - r.restY)) { rock = { ...r, x: r.restX, y: r.restY }; break; }
      }
    }
    expect(rock, 'the dent rock streamed in').toBeDefined();
    expect(rock!.wreckParts, 'the rock carries its convex parts').toBeDefined();

    const toX = rock!.x - DENT.x, toY = rock!.y - DENT.y, len = Math.hypot(toX, toY);
    const hit = int.rayHit(DENT.x, DENT.y, toX / len, toY / len, 2000, '');
    expect(hit?.id, 'the beam still stops on rock').toMatch(/^field:/);
    expect(hit!.dist, 'it first crosses the open dent').toBeGreaterThan(30);
  });
});
