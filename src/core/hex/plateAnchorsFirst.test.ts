/**
 * Base platforms slice 9: the sector-restore order. Plate-anchor connectors
 * (a connector-kind on a plate centre) come back first, so the derived plate
 * set exists before the buildings on it; each group keeps its saved order.
 */
import { describe, it, expect } from 'vitest';
import { isPlateAnchor, plateAnchorsFirst } from './plateSet.js';
import { plateCentreWorldInto } from './plates.js';

const C = plateCentreWorldInto(1, 0, { x: 0, y: 0 });

describe('isPlateAnchor', () => {
  it('is a connector on a plate centre only', () => {
    expect(isPlateAnchor('connector', 0, 0)).toBe(true);
    expect(isPlateAnchor('connector', C.x, C.y)).toBe(true);
    expect(isPlateAnchor('capital', 0, 0)).toBe(false);
    expect(isPlateAnchor('connector', 400, 0)).toBe(false);
  });
});

describe('plateAnchorsFirst', () => {
  it('moves plate anchors to the front, stable within each group', () => {
    const rows = [
      { id: 'cap', kind: 'capital', x: 0, y: -600 },
      { id: 'a1', kind: 'connector', x: C.x, y: C.y },
      { id: 'offPlateConn', kind: 'connector', x: 400, y: 0 },
      { id: 'miner', kind: 'miner', x: 300, y: 300 },
      { id: 'a0', kind: 'connector', x: 0, y: 0 },
    ];
    expect(plateAnchorsFirst(rows).map((r) => r.id)).toEqual(['a1', 'a0', 'cap', 'offPlateConn', 'miner']);
    expect(rows[0]!.id, 'input untouched').toBe('cap');
  });

  it('leaves a list with no anchors in its order', () => {
    const rows = [{ kind: 'miner', x: 1, y: 2 }, { kind: 'capital', x: 3, y: 4 }];
    expect(plateAnchorsFirst(rows)).toEqual(rows);
  });
});
