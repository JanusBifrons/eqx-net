/**
 * City archetype locks (plan: soft-leaping-truffle, PR-K2 — "Budget lock",
 * tier 1). Same shape as the warehouse locks in generateBase.test.ts:
 * determinism, a pinned-hash version lock, a 200-seed budget + fly-through
 * sweep, and quality locks so a city keeps READING as a city.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_LAYOUT_BYTES_PER_BASE,
  MAX_PIECES_PER_BASE,
  MAX_PIECES_PER_CHUNK,
  SHOWCASE_BASE_MAX_SIZE,
} from '../../shared-types/baseBudgets.js';
import { basePieceIndex } from '../../shared-types/basePieceKinds.js';
import { BASE_GENERATOR_VERSION, layoutBytes, layoutHash, type BaseDescriptor } from './baseLayout.js';
import { generateBase } from './generateBase.js';
import { validateLayout } from './validate.js';
import { CITY_MIN_SIZE, generateCity } from './archetypes/city.js';
import { carveSealedPockets } from './carve.js';

const HABITAT = basePieceIndex('habitat_block');
const TOWER = basePieceIndex('tower');
const SPIRE = basePieceIndex('spire');
const WALL = basePieceIndex('wall');

function desc(seed: number, size: number): BaseDescriptor {
  return { ver: BASE_GENERATOR_VERSION, archetype: 'city', seed, x: 0, y: 0, size };
}

const SIZES = [CITY_MIN_SIZE, 5800, 6500, SHOWCASE_BASE_MAX_SIZE];

describe('city — determinism + version lock', () => {
  it('same descriptor → byte-identical layout', () => {
    const a = generateBase(desc(1234, 7000));
    const b = generateBase(desc(1234, 7000));
    expect(layoutHash(a)).toBe(layoutHash(b));
    expect(Array.from(a.kind)).toEqual(Array.from(b.kind));
  });

  it('different seeds → different cities', () => {
    expect(layoutHash(generateBase(desc(1, 7000)))).not.toBe(layoutHash(generateBase(desc(2, 7000))));
  });

  // Generator output changed? Bump BASE_GENERATOR_VERSION and re-pin here.
  const PINNED: Array<[seed: number, size: number, hash: string]> = [
    [1, 5000, 'ba922ef'],
    [42, 6500, 'e1023365'],
    [9999, 8000, 'ac231fd9'],
  ];
  it.each(PINNED)('seed %i size %i → pinned hash', (seed, size, hash) => {
    expect(layoutHash(generateBase(desc(seed, size))).toString(16)).toBe(hash);
  });
});

describe('city — budget + validity sweep', () => {
  it(`200 seeds × ${SIZES.length} sizes: valid and inside every budget`, () => {
    let worstPieces = 0;
    let worstChunk = 0;
    let worstBytes = 0;
    let worstAttempts = 0;
    for (const size of SIZES) {
      for (let s = 1; s <= 200; s++) {
        const l = generateBase(desc((s * 2654435761) >>> 0, size));
        expect(validateLayout(l).ok).toBe(true);
        worstPieces = Math.max(worstPieces, l.count);
        worstBytes = Math.max(worstBytes, layoutBytes(l));
        worstAttempts = Math.max(worstAttempts, l.attempts);
        const perChunk = new Map<number, number>();
        for (let i = 0; i < l.count; i++) perChunk.set(l.chunk[i]!, (perChunk.get(l.chunk[i]!) ?? 0) + 1);
        for (const k of perChunk.values()) worstChunk = Math.max(worstChunk, k);
      }
    }
    console.log(`[bases] city sweep worst: pieces ${worstPieces}, per-chunk ${worstChunk}, bytes ${worstBytes}, attempts ${worstAttempts}`);
    expect(worstPieces).toBeLessThanOrEqual(MAX_PIECES_PER_BASE);
    expect(worstChunk).toBeLessThanOrEqual(MAX_PIECES_PER_CHUNK);
    expect(worstBytes).toBeLessThanOrEqual(MAX_LAYOUT_BYTES_PER_BASE);
    expect(worstAttempts).toBeLessThanOrEqual(4);
  }, 120_000);

  it('generator quality: ≥ 80 % of cities validate on the FIRST attempt at every size', () => {
    for (const size of SIZES) {
      let pass = 0;
      for (let s = 1; s <= 200; s++) {
        const seed = (s * 2654435761) >>> 0;
        const d = desc(seed, size);
        if (validateLayout(carveSealedPockets(generateCity(d, seed).build(d, 0), d)).ok) pass++;
      }
      expect(pass / 200, `first-attempt pass rate at size ${size}`).toBeGreaterThanOrEqual(0.8);
    }
  }, 120_000);

  it('quality: buildings cover a real share of the city (not an empty grid)', () => {
    // The first 5000 u cut was one plaza block — 3.4 % coverage, valid and
    // in budget but empty. Measured after the small-city scaling (200 seeds):
    // 5000 u mean 19.2 % (worst 8.1 %), 8000 u mean 24.4 % (worst 19.8 %).
    for (const size of SIZES) {
      let sum = 0;
      let worst = 1;
      for (let s = 1; s <= 60; s++) {
        const l = generateBase(desc((s * 2654435761) >>> 0, size));
        let area = 0;
        for (let i = 0; i < l.count; i++) if (l.kind[i] === HABITAT || l.kind[i] === TOWER) area += l.w[i]! * l.h[i]!;
        const d = area / (2 * l.half) ** 2;
        sum += d;
        worst = Math.min(worst, d);
      }
      expect(sum / 60, `mean coverage at ${size}`).toBeGreaterThanOrEqual(0.15);
      expect(worst, `worst coverage at ${size}`).toBeGreaterThanOrEqual(0.07);
    }
  }, 60_000);

  it('character: every city has a central spire landmark, a tower core, and no perimeter wall', () => {
    for (const size of SIZES) {
      for (let s = 1; s <= 60; s++) {
        const l = generateBase(desc((s * 2654435761) >>> 0, size));
        let spires = 0;
        let towers = 0;
        let walls = 0;
        let spireX = 0;
        let spireY = 0;
        for (let i = 0; i < l.count; i++) {
          if (l.kind[i] === SPIRE) {
            spires++;
            spireX = l.x[i]! + l.w[i]! / 2;
            spireY = l.y[i]! + l.h[i]! / 2;
          } else if (l.kind[i] === TOWER) towers++;
          else if (l.kind[i] === WALL) walls++;
        }
        // A spire can be split at a chunk line into ≤ 4 pieces.
        expect(spires, `spire at size ${size} seed ${s}`).toBeGreaterThanOrEqual(1);
        expect(towers, `towers at size ${size} seed ${s}`).toBeGreaterThan(0);
        expect(walls).toBe(0);
        if (spires === 1) expect(Math.max(Math.abs(spireX), Math.abs(spireY))).toBeLessThan(l.half * 0.25);
      }
    }
  }, 60_000);

  it('rejects a city below its minimum size', () => {
    expect(() => generateBase(desc(1, CITY_MIN_SIZE - 1))).toThrow();
  });
});
