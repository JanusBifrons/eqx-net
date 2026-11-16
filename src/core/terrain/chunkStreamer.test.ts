import { describe, it, expect } from 'vitest';
import { CutFieldStreamer, MAX_CHUNKS_PER_STEP, FIELD_CHAIN_WAKE_SPEED, cutFieldOpts, fieldRockBody, fieldRockCircle, fieldRocksInBox, fieldRockWakes, fieldRockMass, FIELD_ROCK_BATTLESHIP_MASSES } from './chunkStreamer.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipBodyMass } from '../../shared-types/shipScale/tuning.js';
import { CHUNK_SIZE, rocksInChunk } from './fieldLayout.js';
import { placementRejection } from '../structures/placementRules.js';

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

describe('fieldRockWakes (ramming, plan v2 C2; rock mass, owner 2026-11-16)', () => {
  const bs = getShipKind('battleship'), fighter = getShipKind('fighter'), destroyer = getShipKind('destroyer');
  const bsMass = shipBodyMass(bs), fMass = shipBodyMass(fighter);
  // The field's rocks run from about 60 (smallest cut piece) to over 10 000.
  const smallest = fieldRockMass(60), median = fieldRockMass(326), bsSized = fieldRockMass(bs.radius);
  it('a battleship-sized rock weighs a hundred battleships, scaling with area', () => {
    expect(bsSized / bsMass).toBeCloseTo(FIELD_ROCK_BATTLESHIP_MASSES, 6);
    expect(fieldRockMass(bs.radius / 10)).toBeCloseTo(bsMass, 6);
    expect(fieldRockMass(2 * 300) / fieldRockMass(300)).toBeCloseTo(4, 9);
  });
  it('a fighter never wakes a rock, not even the smallest, however fast', () => {
    expect(smallest).toBeGreaterThan(fMass * 10);
    expect(fieldRockWakes(smallest, undefined, fMass, 10_000)).toBe(false);
    expect(fieldRockWakes(median, {}, fMass, 10_000)).toBe(false);
  });
  it('a battleship wakes a much smaller rock, never one its own size', () => {
    expect(fieldRockWakes(smallest, undefined, bsMass, 0)).toBe(true);
    expect(fieldRockWakes(fieldRockMass(bs.radius / 10 * 0.999), undefined, bsMass, 0)).toBe(true); // up to its own mass
    expect(fieldRockWakes(fieldRockMass(bs.radius / 9), undefined, bsMass, 0)).toBe(false);
    expect(fieldRockWakes(bsSized, undefined, bsMass, 1_000)).toBe(false);
  });
  it('the rule scales with the ship: a destroyer only nudges the smallest pieces', () => {
    const reach = bs.radius * Math.sqrt(shipBodyMass(destroyer) / (FIELD_ROCK_BATTLESHIP_MASSES * bsMass));
    expect(fieldRockWakes(fieldRockMass(reach * 0.99), undefined, shipBodyMass(destroyer), 0)).toBe(true);
    expect(fieldRockWakes(fieldRockMass(reach * 1.01), undefined, shipBodyMass(destroyer), 0)).toBe(false);
  });
  it('a body of unknown mass never wakes a rock', () => {
    expect(fieldRockWakes(smallest, {}, undefined, 1_000)).toBe(false);
  });
  it('a fixed neighbour never wakes it, however hard the contact', () => {
    expect(fieldRockWakes(smallest, { fieldRock: true }, median, 1_000)).toBe(false);
  });
  it('an awake rock wakes one no heavier than itself, only when driven in fast enough', () => {
    const awake = { fieldRock: true, fieldAwake: true };
    expect(fieldRockWakes(smallest, awake, median, FIELD_CHAIN_WAKE_SPEED - 1)).toBe(false);
    expect(fieldRockWakes(smallest, awake, median, FIELD_CHAIN_WAKE_SPEED)).toBe(true);
    expect(fieldRockWakes(median, awake, median, FIELD_CHAIN_WAKE_SPEED)).toBe(true);
    expect(fieldRockWakes(median, awake, smallest, 1_000)).toBe(false);
  });
});

describe('fieldRocksInBox (C5: placement sees rocks whose chunk is not loaded)', () => {
  const o = cutFieldOpts('look');
  // The `cut-field-test` room's chunk: rocks for sure, far from the open core.
  const members = rocksInChunk(o, -8, 6);
  const big = members.reduce((a, b) => (b.size > a.size ? b : a));
  const body = fieldRockBody(big);

  it('cuts a rock from the layout with its chunk key, body circle and outline', () => {
    const t0 = performance.now();
    const found = fieldRocksInBox(o, body.x - 10, body.y - 10, body.x + 10, body.y + 10);
    console.log(`[C5] fieldRocksInBox: ${(performance.now() - t0).toFixed(2)} ms, ${found.length} rock(s)`);
    expect(found).toContainEqual({ key: big.key, x: body.x, y: body.y, radius: body.radius, verts: big.verts });
    expect(fieldRockCircle(big)).toEqual({ x: body.x, y: body.y, radius: body.radius });
  });

  it('the placement rule refuses a footprint on that rock and accepts open space', () => {
    const on = fieldRocksInBox(o, body.x - 200, body.y - 200, body.x + 200, body.y + 200);
    expect(placementRejection('capital', body.x, body.y, [], on)).toBe('overlap-obstacle');
    // The field's open core holds no rock.
    const core = fieldRocksInBox(o, -500, -500, 500, 500);
    expect(core).toEqual([]);
    expect(placementRejection('capital', 0, 0, [], core)).toBeNull();
  });

  it('finds a rock that reaches in from a neighbouring chunk', () => {
    const x0 = -8 * CHUNK_SIZE, y0 = 6 * CHUNK_SIZE, x1 = x0 + CHUNK_SIZE, y1 = y0 + CHUNK_SIZE;
    // A point just outside chunk (-8, 6) but inside one of its rocks' circles.
    let hit: { key: number; x: number; y: number } | undefined;
    for (const r of members) {
      const b = fieldRockCircle(r);
      for (const [x, y] of [[x0 - 30, b.y], [x1 + 30, b.y], [b.x, y0 - 30], [b.x, y1 + 30]] as const) {
        if (!hit && Math.hypot(x - b.x, y - b.y) < b.radius - 5) hit = { key: r.key, x, y };
      }
    }
    expect(hit, 'a rock of chunk (-8, 6) reaches past its edge').toBeDefined();
    const found = fieldRocksInBox(o, hit!.x - 1, hit!.y - 1, hit!.x + 1, hit!.y + 1);
    expect(found.map((f) => f.key)).toContain(hit!.key);
  });
});
