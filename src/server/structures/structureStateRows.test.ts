/**
 * Structure-restyle 0d slice 6 — `writeConnToRow` mirrors each link's cable
 * sockets into `connSock` alongside `connTo`, from either end, and leaves both
 * arrays untouched when nothing changed.
 */
import { describe, expect, it } from 'vitest';
import { CABLE_NO_SOCKET, Connection } from '../../core/structures/Connection.js';
import {
  CONN_SOCK_UNKNOWN,
  decodeConnSockOther,
  decodeConnSockSelf,
  encodeConnSock,
} from '../../shared-types/structureStateWire.js';
import { ArraySchema } from '@colyseus/schema';
import type { StructureState } from '../rooms/schema/SectorState.js';
import { writeConnToRow } from './structureStateRows.js';

const EIDS: Record<string, number> = { a: 10, b: 20, c: 30 };
const eid = (id: string): number | undefined => EIDS[id];

/** The row's two collections only (the schema class needs the decorator
 *  transform the integration config has; this writer touches nothing else). */
function row(): StructureState {
  return { connTo: new ArraySchema<number>(), connSock: new ArraySchema<number>() } as unknown as StructureState;
}

function registry(conns: Connection[]) {
  return { connectionsOf: (id: string): readonly Connection[] => conns.filter((c) => c.hasNode(id)) };
}

function arr(a: { length: number; at(i: number): number | undefined }): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) out.push(a.at(i)!);
  return out;
}

describe('writeConnToRow: connSock (0d slice 6)', () => {
  // a-b cable: socket 3 on a, socket 7 on b. a-c fence link: no sockets.
  const ab = new Connection(1, 'a', 'b', 100, 3, 7);
  const ac = new Connection(2, 'a', 'c', 100, CABLE_NO_SOCKET, CABLE_NO_SOCKET);
  const reg = registry([ab, ac]);

  it('writes one packed socket pair per connTo entry, this end first', () => {
    const st = row();
    writeConnToRow('a', st, reg, eid);
    expect(arr(st.connTo)).toEqual([20, 30]);
    expect(arr(st.connSock)).toEqual([encodeConnSock(3, 7), encodeConnSock(-1, -1)]);
    expect(decodeConnSockSelf(st.connSock.at(0)!)).toBe(3);
    expect(decodeConnSockOther(st.connSock.at(0)!)).toBe(7);
    expect(st.connSock.at(1)).toBe(CONN_SOCK_UNKNOWN);
  });

  it('from the other end the pair is swapped', () => {
    const st = row();
    writeConnToRow('b', st, reg, eid);
    expect(arr(st.connTo)).toEqual([10]);
    expect(decodeConnSockSelf(st.connSock.at(0)!)).toBe(7);
    expect(decodeConnSockOther(st.connSock.at(0)!)).toBe(3);
  });

  it('a fence link from the far end reads -1 at both ends', () => {
    const st = row();
    writeConnToRow('c', st, reg, eid);
    expect(arr(st.connTo)).toEqual([10]);
    expect(decodeConnSockSelf(st.connSock.at(0)!)).toBe(-1);
    expect(decodeConnSockOther(st.connSock.at(0)!)).toBe(-1);
  });

  it('unchanged links leave both arrays alone (no rewrite)', () => {
    const st = row();
    writeConnToRow('a', st, reg, eid);
    let clears = 0;
    for (const a of [st.connTo, st.connSock]) {
      const orig = a.clear.bind(a);
      a.clear = () => { clears++; orig(); };
    }
    writeConnToRow('a', st, reg, eid);
    expect(clears).toBe(0);
    expect(arr(st.connSock)).toEqual([encodeConnSock(3, 7), encodeConnSock(-1, -1)]);
  });

  it('a socket-only change (same partner, new socket) rewrites both arrays', () => {
    const st = row();
    writeConnToRow('a', st, reg, eid);
    writeConnToRow('a', st, registry([new Connection(3, 'a', 'b', 100, 5, 7), ac]), eid);
    expect(arr(st.connTo)).toEqual([20, 30]);
    expect(arr(st.connSock)).toEqual([encodeConnSock(5, 7), encodeConnSock(-1, -1)]);
  });

  it('a row whose connSock lags connTo is repaired', () => {
    const st = row();
    st.connTo.push(20, 30);
    writeConnToRow('a', st, reg, eid);
    expect(arr(st.connSock)).toEqual([encodeConnSock(3, 7), encodeConnSock(-1, -1)]);
  });

  it('links whose partner has no entity id are skipped in both arrays', () => {
    const st = row();
    writeConnToRow('a', st, registry([new Connection(4, 'a', 'ghost', 100, 1, 2), ab]), eid);
    expect(arr(st.connTo)).toEqual([20]);
    expect(arr(st.connSock)).toEqual([encodeConnSock(3, 7)]);
  });
});
