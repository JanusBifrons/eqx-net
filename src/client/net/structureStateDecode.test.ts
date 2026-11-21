/**
 * Structure-restyle 0d slice 6 — the client decodes each link's cable sockets
 * (`connSock`) onto `connSockSelf` / `connSockOther`, parallel to `connTo`, in
 * place.
 */
import { describe, expect, it } from 'vitest';
import { BUILD_STALL_NOT_CONNECTED, STRUCTURE_FLAG_BUILT, STRUCTURE_FLAG_LOCK_HOLDING, encodeBuildEta, encodeConnSock, type StructureStateView } from '../../shared-types/structureStateWire.js';
import { encodeProdBay } from '../../shared-types/production.js';
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

// Owner play-test: a Shipyard sat at 92% with no reason when the bank ran dry.
// Two-sided (#15): the server packs the stall with `encodeBuildEta`, the client
// decodes the minerals still owed.
describe('decodeStructureState: build stall reason', () => {
  it('a dry-bank stall carries the minerals still owed', () => {
    const out = emptyStructureRow();
    decodeStructureState({ connTo: list([]), buildPct: 0.92, etaMs: encodeBuildEta(null, 420) }, OWNERS, out);
    expect(out.etaMs).toBeNull();
    expect(out.buildMineralsShort).toBe(420);
    expect(out.buildNotConnected).toBeUndefined();
  });

  it('a stall with no Capital route says not connected, and is not a minerals stall', () => {
    const out = emptyStructureRow();
    decodeStructureState({ connTo: list([]), buildPct: 0.4, etaMs: encodeBuildEta(null, BUILD_STALL_NOT_CONNECTED) }, OWNERS, out);
    expect(out.etaMs).toBeNull();
    expect(out.buildNotConnected).toBe(true);
    expect(out.buildMineralsShort).toBeUndefined();
  });

  it('every minerals amount, from 1 up, round-trips and never reads as not connected', () => {
    const out = emptyStructureRow();
    for (const n of [1, 2, 3, 420, 1_000_000]) {
      decodeStructureState({ connTo: list([]), etaMs: encodeBuildEta(null, n) }, OWNERS, out);
      expect(out.buildMineralsShort).toBe(n);
      expect(out.buildNotConnected).toBeUndefined();
    }
  });

  it('a generic stall, a running build and a built row carry no reason', () => {
    const out = emptyStructureRow();
    decodeStructureState({ connTo: list([]), etaMs: encodeBuildEta(null, 420) }, OWNERS, out);
    const cases: Array<[number | undefined, number | null | undefined]> = [
      [encodeBuildEta(null, null), null], [encodeBuildEta(1234, 420), 1234], [undefined, undefined],
    ];
    for (const [etaMs, want] of cases) {
      decodeStructureState({ connTo: list([]), ...(etaMs !== undefined ? { etaMs } : {}) }, OWNERS, out);
      expect(out.etaMs).toBe(want);
      expect(out.buildMineralsShort).toBeUndefined();
      expect(out.buildNotConnected).toBeUndefined();
    }
  });
});
