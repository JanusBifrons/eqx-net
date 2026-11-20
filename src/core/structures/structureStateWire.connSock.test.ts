/**
 * Structure-restyle 0d slice 6 — the `connSock` packing both sides share
 * (invariant #15): round-trip, the no-socket sentinel against core's
 * `CABLE_NO_SOCKET`, and that every kind's socket indices fit a byte.
 */
import { describe, expect, it } from 'vitest';
import { CABLE_NO_SOCKET } from './Connection.js';
import {
  CONN_SOCK_NONE,
  CONN_SOCK_UNKNOWN,
  decodeConnSockOther,
  decodeConnSockSelf,
  encodeConnSock,
} from '../../shared-types/structureStateWire.js';
import { STRUCTURE_KINDS_LIST } from '../../shared-types/structureKinds.js';
import { structureSockets } from '../../shared-types/structureKinds/structureSockets.js';

describe('connSock encoding (0d slice 6)', () => {
  it('round-trips socket pairs 0..254 and none', () => {
    for (const self of [CABLE_NO_SOCKET, 0, 1, 23, 128, 254]) {
      for (const other of [CABLE_NO_SOCKET, 0, 7, 200, 254]) {
        const v = encodeConnSock(self, other);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(0xffff);
        expect(decodeConnSockSelf(v)).toBe(self);
        expect(decodeConnSockOther(v)).toBe(other);
      }
    }
  });

  it('a fence link (CABLE_NO_SOCKET at both ends) packs to CONN_SOCK_UNKNOWN', () => {
    expect(encodeConnSock(CABLE_NO_SOCKET, CABLE_NO_SOCKET)).toBe(CONN_SOCK_UNKNOWN);
    expect(decodeConnSockSelf(CONN_SOCK_UNKNOWN)).toBe(CABLE_NO_SOCKET);
    expect(decodeConnSockOther(CONN_SOCK_UNKNOWN)).toBe(CABLE_NO_SOCKET);
  });

  it('out-of-range or non-integer indices encode as no socket', () => {
    for (const bad of [CONN_SOCK_NONE, 300, -5, 1.5, Number.NaN]) {
      expect(decodeConnSockSelf(encodeConnSock(bad, 0))).toBe(-1);
      expect(decodeConnSockOther(encodeConnSock(0, bad))).toBe(-1);
    }
  });

  it('every kind has fewer sockets than the sentinel (indices fit a byte)', () => {
    for (const k of STRUCTURE_KINDS_LIST) expect(structureSockets(k.id).length, k.id).toBeLessThan(CONN_SOCK_NONE);
  });
});
