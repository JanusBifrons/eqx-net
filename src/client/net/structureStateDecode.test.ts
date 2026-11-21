/**
 * Structure-restyle 0d slice 6 — the client decodes each link's cable sockets
 * (`connSock`) onto `connSockSelf` / `connSockOther`, parallel to `connTo`, in
 * place.
 */
import { describe, expect, it } from 'vitest';
import { STRUCTURE_FLAG_BUILT, STRUCTURE_FLAG_LOCK_HOLDING, encodeConnSock, type StructureStateView } from '../../shared-types/structureStateWire.js';
import { blueprintRecipeBits, encodeBpProduct, encodeProdBay, encodeProdQ0, encodeProdQ1 } from '../../shared-types/production.js';
import { blueprintProductFor } from '../../shared-types/recipes.js';
import { decodeStructureState, emptyStructureRow } from './structureStateDecode.js';

const OWNERS = { ids: ['p1'], names: ['Ada'] };

function list(xs: number[]): { length: number; at(i: number): number | undefined } {
  return { length: xs.length, at: (i: number) => xs[i] };
}

describe('decodeStructureState: connSock (0d slice 6)', () => {
  it('decodes this end and the other end per link; fence links read -1', () => {
    const out = emptyStructureRow();
    const v: StructureStateView = { connTo: list([7, 9]), connSock: list([encodeConnSock(2, 11), encodeConnSock(-1, -1)]) };
    decodeStructureState(v, OWNERS, out);
    expect(out.connTo).toEqual([7, 9]);
    expect(out.connSockSelf).toEqual([2, -1]);
    expect(out.connSockOther).toEqual([11, -1]);
  });

  it('a row without connSock reads no sockets, one per link', () => {
    const out = emptyStructureRow();
    decodeStructureState({ connTo: list([4, 5, 6]) }, OWNERS, out);
    expect(out.connSockSelf).toEqual([-1, -1, -1]);
    expect(out.connSockOther).toEqual([-1, -1, -1]);
  });

  it('re-decodes in place (same arrays, shrinks with connTo)', () => {
    const out = emptyStructureRow();
    decodeStructureState({ connTo: list([7, 9]), connSock: list([encodeConnSock(1, 2), encodeConnSock(3, 4)]) }, OWNERS, out);
    const self = out.connSockSelf;
    const other = out.connSockOther;
    decodeStructureState({ connTo: list([9]), connSock: list([encodeConnSock(3, 4)]) }, OWNERS, out);
    expect(out.connSockSelf).toBe(self);
    expect(out.connSockOther).toBe(other);
    expect(out.connSockSelf).toEqual([3]);
    expect(out.connSockOther).toEqual([4]);
  });
});

describe('decodeStructureState: lockHolding (F2)', () => {
  it('reads STRUCTURE_FLAG_LOCK_HOLDING (bit 8) and clears it again in place', () => {
    const out = emptyStructureRow();
    decodeStructureState({ flags: STRUCTURE_FLAG_BUILT | STRUCTURE_FLAG_LOCK_HOLDING, connTo: list([]) }, OWNERS, out);
    expect(out.lockHolding).toBe(true);
    expect(out.built).toBe(true);
    decodeStructureState({ flags: STRUCTURE_FLAG_BUILT, connTo: list([]) }, OWNERS, out);
    expect(out.lockHolding).toBeUndefined();
  });
});

describe('decodeStructureState: prodBay (loop 3R)', () => {
  it('reads the bay and queued count onto the row, in place, absent as none', () => {
    const out = emptyStructureRow();
    decodeStructureState({ flags: STRUCTURE_FLAG_BUILT, connTo: list([]), prodBay: encodeProdBay(2, 3) }, OWNERS, out);
    expect(out.prodBay).toBe(2);
    expect(out.prodQueued).toBe(3);
    decodeStructureState({ flags: STRUCTURE_FLAG_BUILT, connTo: list([]), prodBay: encodeProdBay(4, 0) }, OWNERS, out);
    expect(out.prodBay).toBe(4);
    expect(out.prodQueued).toBeUndefined();
    decodeStructureState({ flags: STRUCTURE_FLAG_BUILT, connTo: list([]) }, OWNERS, out);
    expect(out.prodBay).toBeUndefined();
    expect(out.prodQueued).toBeUndefined();
  });
});

describe('decodeStructureState: recipe queue (building panels B4)', () => {
  it('decodes the queue and repeat flag in place; an emptied queue keeps its array', () => {
    const out = emptyStructureRow();
    decodeStructureState({ connTo: list([]) }, OWNERS, out);
    expect(out.prodQueue, 'no queue ever: nothing allocated').toBeUndefined();
    expect(out.prodQueueRepeat).toBeUndefined();
    const queue = ['build_gunship', 'build_interceptor', 'build_heavy', 'build_gunship', 'build_barge'] as const;
    decodeStructureState({ connTo: list([]), prodQ0: encodeProdQ0(queue), prodQ1: encodeProdQ1(queue, true) }, OWNERS, out);
    expect(out.prodQueue).toEqual(queue);
    expect(out.prodQueueRepeat).toBe(true);
    const arr = out.prodQueue;
    decodeStructureState({ connTo: list([]), prodQ0: encodeProdQ0(['build_heavy']) }, OWNERS, out);
    expect(out.prodQueue).toBe(arr);
    expect(out.prodQueue).toEqual(['build_heavy']);
    expect(out.prodQueueRepeat).toBeUndefined();
    decodeStructureState({ connTo: list([]) }, OWNERS, out);
    expect(out.prodQueue).toBe(arr);
    expect(out.prodQueue).toEqual([]);
  });
});

describe('decodeStructureState: blueprint stock (building panels B7)', () => {
  const I = blueprintProductFor('build_interceptor');
  const G = blueprintProductFor('build_gunship');

  it('a yard reads its slot blueprint and the hulls its network stores, in place', () => {
    const out = emptyStructureRow();
    decodeStructureState({ connTo: list([]) }, OWNERS, out, 'shipyard');
    expect(out.bpProduct).toBeNull();
    expect(out.bpAvailable, 'no stock ever: nothing allocated').toBeUndefined();
    const q1 = encodeProdQ1(undefined, false, encodeBpProduct('shipyard', I));
    const bpAvail = (blueprintRecipeBits('shipyard', I) | blueprintRecipeBits('shipyard', G)) >>> 0;
    decodeStructureState({ connTo: list([]), prodQ1: q1, bpAvail }, OWNERS, out, 'shipyard');
    expect(out.bpProduct).toBe('build_interceptor');
    expect(out.bpAvailable).toEqual(['build_interceptor', 'build_gunship']);
    expect(out.prodQueue, 'the slot byte is not a queue').toBeUndefined();
    const arr = out.bpAvailable;
    decodeStructureState({ connTo: list([]), prodQ1: q1, bpAvail: blueprintRecipeBits('shipyard', I) }, OWNERS, out, 'shipyard');
    expect(out.bpAvailable).toBe(arr);
    expect(out.bpAvailable).toEqual(['build_interceptor']);
    decodeStructureState({ connTo: list([]) }, OWNERS, out, 'shipyard');
    expect(out.bpProduct).toBeNull();
    expect(out.bpAvailable).toBe(arr);
    expect(out.bpAvailable).toEqual([]);
  });

  it('an unknown kind (no pose yet) or a non-processor leaves both unset', () => {
    const out = emptyStructureRow();
    const v = { connTo: list([]), prodQ1: encodeProdQ1(undefined, false, 1), bpAvail: 3 };
    decodeStructureState(v, OWNERS, out);
    expect(out.bpProduct).toBeUndefined();
    expect(out.bpAvailable).toBeUndefined();
    decodeStructureState(v, OWNERS, out, 'cargo_bay');
    expect(out.bpProduct).toBeUndefined();
  });
});
