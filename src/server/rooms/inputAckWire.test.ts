import { describe, it, expect } from 'vitest';
import { writeInputAck, type InputAckFields } from './inputAckWire.js';

describe('writeInputAck', () => {
  it('sends a pilot its latest input margin once, then omits it', () => {
    const margins = new Map<string, number>([['p1', 4]]);
    const snap: InputAckFields = { ackedTick: 0 };
    writeInputAck(snap, 100, margins, 'p1');
    expect(snap).toEqual({ ackedTick: 100, inputMargin: 4 });
    expect(margins.has('p1')).toBe(false);
    // Next snapshot reuses the same object: no new margin ⇒ the field is dropped.
    writeInputAck(snap, 103, margins, 'p1');
    expect(snap).toEqual({ ackedTick: 103 });
    expect('inputMargin' in snap).toBe(false);
  });

  it('never leaks one pilot’s margin to another recipient', () => {
    const margins = new Map<string, number>([['p1', -2]]);
    const snap: InputAckFields = { ackedTick: 0 };
    writeInputAck(snap, 50, margins, 'p2');
    expect(snap).toEqual({ ackedTick: 50 });
    expect(margins.get('p1')).toBe(-2);
  });
});
