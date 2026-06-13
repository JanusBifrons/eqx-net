/**
 * Unit test for the pure composite-ship per-part point transform
 * (composite-ships Phase 1, Step F). Mirrors how `spriteUpdateDecisions.ts`
 * is unit-tested — the Pixi `Graphics` is not node-constructible, so the
 * geometry mapping is extracted into a pure helper and asserted in isolation.
 *
 * `transformCompositePartPoints` is the `{x:(px+offsetX)*scale, y:(py+offsetY)*scale}`
 * mapping each composite part's points go through before `Graphics.poly` —
 * the SAME no-Y-flip convention as the polygon branch (the sprite transform
 * owns the world Y-flip).
 */
import { describe, it, expect } from 'vitest';
import { transformCompositePartPoints } from './spriteBuilders.js';
import type { ShipPart } from '../../../shared-types/shipKinds.js';

const makePart = (overrides: Partial<ShipPart> = {}): ShipPart => ({
  points: [
    [0, -10],
    [10, 10],
    [-10, 10],
  ],
  color: 0xcc4444,
  offsetX: 0,
  offsetY: 0,
  ...overrides,
});

describe('transformCompositePartPoints', () => {
  it('applies the shape scale (no Y-flip — sprite transform owns world Y)', () => {
    const out = transformCompositePartPoints(makePart(), 0.5);
    expect(out).toEqual([
      { x: 0, y: -5 },
      { x: 5, y: 5 },
      { x: -5, y: 5 },
    ]);
  });

  it('folds in the part offset before scaling', () => {
    const out = transformCompositePartPoints(
      makePart({ points: [[2, 3], [4, 5], [6, 7]], offsetX: 1, offsetY: -1 }),
      2,
    );
    // (px+1)*2 , (py-1)*2
    expect(out).toEqual([
      { x: 6, y: 4 },
      { x: 10, y: 8 },
      { x: 14, y: 12 },
    ]);
  });

  it('is identity at scale 1 with zero offset', () => {
    const out = transformCompositePartPoints(makePart(), 1);
    expect(out).toEqual([
      { x: 0, y: -10 },
      { x: 10, y: 10 },
      { x: -10, y: 10 },
    ]);
  });

  it('returns one mapped point per input point', () => {
    const part = makePart({
      points: [[0, 0], [1, 1], [2, 2], [3, 3]],
    });
    expect(transformCompositePartPoints(part, 1)).toHaveLength(4);
  });
});
