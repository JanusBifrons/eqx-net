/**
 * Structure-restyle 0d slice 6 — the client decodes each link's cable sockets
 * (`connSock`) onto `connSockSelf` / `connSockOther`, parallel to `connTo`, in
 * place.
 */
import { describe, expect, it } from 'vitest';
import { encodeConnSock, type StructureStateView } from '../../shared-types/structureStateWire.js';
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
