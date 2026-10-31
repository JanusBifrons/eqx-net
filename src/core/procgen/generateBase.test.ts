/**
 * Generator locks (plan: soft-leaping-truffle — "Budget lock", tier 1).
 *
 *  - DETERMINISM: same descriptor → byte-identical layout (Invariant #15:
 *    server worker, client predWorld and render worker must agree).
 *  - VERSION LOCK: a pinned hash per reference seed. Any change to generator
 *    output fails here and must bump BASE_GENERATOR_VERSION (the descriptor
 *    carries it, so old/new can never silently mix).
 *  - BUDGET SWEEP: 200 seeds × sizes — every layout validates (fly-through,
 *    thickness, bounds) and stays inside every piece/chunk/byte budget, within
 *    the re-seed cap.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_LAYOUT_BYTES_PER_BASE,
  MAX_PIECES_PER_BASE,
  MAX_PIECES_PER_CHUNK,
  SHOWCASE_BASE_MAX_SIZE,
} from '../../shared-types/baseBudgets.js';
import { BASE_GENERATOR_VERSION, layoutBytes, layoutHash, type BaseDescriptor } from './baseLayout.js';
import { generateBase, MAX_ATTEMPTS } from './generateBase.js';
import { validateLayout } from './validate.js';
import { WAREHOUSE_MIN_SIZE, generateWarehouse } from './archetypes/warehouse.js';
import { carveSealedPockets } from './carve.js';

function desc(seed: number, size: number): BaseDescriptor {
  return { ver: BASE_GENERATOR_VERSION, archetype: 'warehouse', seed, x: 0, y: 0, size };
}

describe('generateBase — determinism', () => {
  it('same descriptor → byte-identical layout', () => {
    const a = generateBase(desc(1234, 6000));
    const b = generateBase(desc(1234, 6000));
    expect(layoutHash(a)).toBe(layoutHash(b));
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    expect(Array.from(a.chunk)).toEqual(Array.from(b.chunk));
  });

  it('different seeds → different layouts', () => {
    expect(layoutHash(generateBase(desc(1, 6000)))).not.toBe(layoutHash(generateBase(desc(2, 6000))));
  });

  it('the world origin does not change base-local geometry', () => {
    const a = generateBase({ ...desc(77, 5000), x: 0, y: 0 });
    const b = generateBase({ ...desc(77, 5000), x: 1200, y: -800 });
    expect(layoutHash(a)).toBe(layoutHash(b));
  });

  it('rejects a descriptor from a different generator version', () => {
    expect(() => generateBase({ ...desc(1, 5000), ver: BASE_GENERATOR_VERSION + 1 })).toThrow();
  });
});

describe('generateBase — version lock', () => {
  // If this fails, generator OUTPUT changed. That is fine on purpose — but
  // bump BASE_GENERATOR_VERSION in baseLayout.ts and re-pin these hashes in
  // the same change, so a client and server on different code can never
  // build different geometry from the same descriptor.
  const PINNED: Array<[seed: number, size: number, hash: string]> = [
    [1, 5000, 'b8d6823'],
    [42, 5000, '935a7350'],
    [9999, 8000, 'fb802737'],
  ];
  it.each(PINNED)('seed %i size %i → pinned hash', (seed, size, hash) => {
    const got = layoutHash(generateBase(desc(seed, size))).toString(16);
    expect(got).toBe(hash);
  });
});

describe('generateBase — budget + validity sweep', () => {
  const SIZES = [WAREHOUSE_MIN_SIZE, 6000, 7000, SHOWCASE_BASE_MAX_SIZE];
  it(`200 seeds × ${SIZES.length} sizes: valid, inside every budget, within ${MAX_ATTEMPTS} attempts`, () => {
    let worstPieces = 0;
    let worstChunk = 0;
    let worstBytes = 0;
    let worstAttempts = 0;
    for (const size of SIZES) {
      for (let seed = 1; seed <= 200; seed++) {
        const l = generateBase(desc(seed * 2654435761, size));
        expect(validateLayout(l).ok).toBe(true);
        worstPieces = Math.max(worstPieces, l.count);
        worstBytes = Math.max(worstBytes, layoutBytes(l));
        worstAttempts = Math.max(worstAttempts, l.attempts);
        const perChunk = new Map<number, number>();
        for (let i = 0; i < l.count; i++) perChunk.set(l.chunk[i]!, (perChunk.get(l.chunk[i]!) ?? 0) + 1);
        for (const k of perChunk.values()) worstChunk = Math.max(worstChunk, k);
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[bases] warehouse sweep worst: pieces ${worstPieces}, per-chunk ${worstChunk}, bytes ${worstBytes}, attempts ${worstAttempts}`);
    expect(worstPieces).toBeLessThanOrEqual(MAX_PIECES_PER_BASE);
    expect(worstChunk).toBeLessThanOrEqual(MAX_PIECES_PER_CHUNK);
    expect(worstBytes).toBeLessThanOrEqual(MAX_LAYOUT_BYTES_PER_BASE);
    // Re-seeding is a safety net, not a crutch: a generator that needs many
    // re-seeds is producing bad layouts. Keep a wide margin below the cap.
    expect(worstAttempts).toBeLessThanOrEqual(4);
  }, 120_000);

  it('generator quality: ≥ 80 % of layouts validate on the FIRST attempt (generate + repair) at every size', () => {
    for (const size of SIZES) {
      let pass = 0;
      for (let s = 1; s <= 200; s++) {
        const seed = (s * 2654435761) >>> 0;
        const d = desc(seed, size);
        if (validateLayout(carveSealedPockets(generateWarehouse(d, seed).build(d, 0), d)).ok) pass++;
      }
      expect(pass / 200, `first-attempt pass rate at size ${size}`).toBeGreaterThanOrEqual(0.8);
    }
  }, 120_000);

  it('quality: storage density — racks cover a real share of the floor (it must READ as a warehouse)', () => {
    // v2 (3× scale) silently dropped to 3.5 % mean / 0 % worst at 5000 u —
    // valid and in-budget, but an empty yard. Measured after the v3 retune:
    // 5000 u mean 22.8 % (worst 16.4 %), 8000 u mean 25.2 % (worst 19.5 %).
    const rack = 1; // basePieceIndex('rack_row')
    for (const size of [WAREHOUSE_MIN_SIZE, SHOWCASE_BASE_MAX_SIZE]) {
      let sum = 0;
      let worst = 1;
      for (let s = 1; s <= 60; s++) {
        const l = generateBase(desc((s * 2654435761) >>> 0, size));
        let area = 0;
        for (let i = 0; i < l.count; i++) if (l.kind[i] === rack) area += l.w[i]! * l.h[i]!;
        const d = area / (2 * l.half) ** 2;
        sum += d;
        worst = Math.min(worst, d);
      }
      expect(sum / 60, `mean density at ${size}`).toBeGreaterThanOrEqual(0.2);
      expect(worst, `worst density at ${size}`).toBeGreaterThanOrEqual(0.12);
    }
  }, 60_000);

  it('rejects a warehouse below its minimum size', () => {
    expect(() => generateBase(desc(1, WAREHOUSE_MIN_SIZE - 1))).toThrow();
  });
});
