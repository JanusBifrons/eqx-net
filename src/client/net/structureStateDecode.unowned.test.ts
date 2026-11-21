/**
 * Capture 4E S7 — a base whose Capital died (`none:<lostCapitalId>` owner)
 * reads "Unowned" on every panel that shows a structure's owner name (the
 * inspector, the contacts list), never "Unknown" or the old faction's name.
 */
import { describe, expect, it } from 'vitest';
import { unownedOwner } from '../../shared-types/relations.js';
import { UNOWNED_OWNER_LABEL, decodeStructureState, emptyStructureRow } from './structureStateDecode.js';

const list = (xs: number[]): { length: number; at(i: number): number | undefined } => ({ length: xs.length, at: (i: number) => xs[i] });

describe('decodeStructureState: an ownerless base', () => {
  it('labels a none: owner "Unowned", even when the server sends no name or a stale one', () => {
    const out = emptyStructureRow();
    decodeStructureState({ ownerIdx: 0, connTo: list([]) }, { ids: [unownedOwner('cap-1')], names: [''] }, out);
    expect(out.owner).toBe('none:cap-1');
    expect(out.ownerName).toBe('Unowned');
    expect(UNOWNED_OWNER_LABEL).toBe('Unowned');
    decodeStructureState({ ownerIdx: 0, connTo: list([]) }, { ids: [unownedOwner('cap-1')], names: ['Traders Guild'] }, out);
    expect(out.ownerName).toBe('Unowned');
  });
  it('a player owner keeps its resolved name', () => {
    const out = emptyStructureRow();
    decodeStructureState({ ownerIdx: 0, connTo: list([]) }, { ids: ['p1'], names: ['Ada'] }, out);
    expect(out.ownerName).toBe('Ada');
  });
});
