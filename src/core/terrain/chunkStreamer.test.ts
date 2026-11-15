import { describe, it, expect } from 'vitest';
import { CutFieldStreamer, MAX_CHUNKS_PER_STEP } from './chunkStreamer.js';
import { CHUNK_SIZE } from './fieldLayout.js';

// A 20 km field keeps the cuts cheap; the rules are the same at 300 km.
const FIELD = { seed: 'test', battleshipLength: 5752, fighterLength: 48, radius: 20_000 };

function rig(ship: { x: number; y: number } | null) {
  const live = new Set<string>();
  let now = 0;
  const s = new CutFieldStreamer(FIELD, {
    visitShips: (cb) => { if (ship) cb(ship.x, ship.y); },
    spawnRock: (id) => { live.add(id); return true; },
    removeRock: (id) => { live.delete(id); },
    nowMs: () => now,
  }, 1, 1000);
  return { s, live, advance: (ms: number) => { now += ms; } };
}

describe('CutFieldStreamer (macro terrain v2, cut-field slice 1)', () => {
  it('loads the chunks around a ship, a few per step, and nothing else', () => {
    const ship = { x: 5000, y: -3000 };
    const { s, live } = rig(ship);
    s.step();
    expect(s.stats.cutsThisStep).toBe(MAX_CHUNKS_PER_STEP);
    for (let i = 0; i < 5; i++) s.step();
    expect(s.stats.chunksLoaded).toBe(9); // 3×3 around the ship (wake radius 1)
    expect(s.stats.rocksLoaded).toBe(live.size);
    expect(live.size).toBeGreaterThan(10);
    for (const id of live) expect(id.startsWith('field:')).toBe(true);
    void CHUNK_SIZE;
  });

  it('unloads chunks once no ship has been near them for the linger time', () => {
    const ship = { x: 5000, y: -3000 };
    const { s, live, advance } = rig(ship);
    for (let i = 0; i < 5; i++) s.step();
    const before = live.size;
    ship.x += 10 * CHUNK_SIZE; // far away: new chunks wanted, the old ones not
    s.step();
    expect(live.size).toBeGreaterThanOrEqual(before); // still within the linger time
    advance(2000);
    for (let i = 0; i < 5; i++) s.step();
    expect(s.stats.chunksLoaded).toBe(9);
    expect(s.stats.rocksLoaded).toBe(live.size);
  });

  it('loads nothing with no ships', () => {
    const { s, live } = rig(null);
    s.step();
    expect(live.size).toBe(0);
  });
});
