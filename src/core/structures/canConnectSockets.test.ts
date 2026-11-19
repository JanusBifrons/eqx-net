/**
 * 0d cable sockets, slice 4: `canConnect` picks the socket pair a cable runs
 * between (`pickCableSocketPair`). A building socket takes a cable only to
 * something in front of it (within 90°, never behind the building); a
 * connector (or emitter post) takes one from any side; refused only for a
 * blocked curve, reach (socket to socket) or full slots. Fence links stay
 * straight post to post.
 */
import { describe, it, expect } from 'vitest';
import { canConnect, type GridNode } from './Grid.js';
import {
  CABLE_NO_SOCKET, CABLE_SOCKET_MASK_BITS, linkSocketMask, makeCableSocketPick, pickCableSocketPair, socketListMask,
} from './cableCurve.js';
import { Connection } from './Connection.js';
import { CONNECTION_MAX_RANGE } from './structureGridConstants.js';
import {
  STRUCTURE_KINDS_LIST,
  getStructureKind,
  structureHalfExtents,
  structureSockets,
  structureSocketToWorld,
} from '../../shared-types/structureKinds.js';

/** A node with its real catalogue size (rot in radians). */
function real(id: string, kind: string, x: number, y: number, rot = 0, over: Partial<GridNode> = {}): GridNode {
  const k = getStructureKind(kind);
  const { hw, hh } = structureHalfExtents(kind, (rot * 180) / Math.PI);
  return {
    id, kind, x, y, rot, radius: k.radius, halfW: hw, halfH: hh, isHub: k.isHub,
    isCapital: kind === 'capital', isConnector: kind === 'connector',
    isShieldPylon: kind === 'shield_pylon' || kind === 'shield_gate' || kind === 'shield_airlock',
    maxConnections: 10, powerOutput: 0, powerConsumption: 0, isConstructed: true, ...over,
  };
}

const map = (...ns: GridNode[]): Map<string, GridNode> => new Map(ns.map((n) => [n.id, n]));
const NONE = new Map();
const pick = makeCableSocketPick();

/** World socket `i` of node `n`. */
function sock(n: GridNode, i: number): { x: number; y: number; nx: number; ny: number } {
  return structureSocketToWorld(structureSockets(n.kind)[i]!, n.x, n.y, n.rot, { x: 0, y: 0, nx: 0, ny: 0 });
}

describe('canConnect picks the cable socket pair (0d slice 4)', () => {
  it('a building socket is never picked for a partner behind it (16 directions, two rotations)', () => {
    for (const rot of [0, 1.0]) {
      const solar = real('s', 'solar', 0, 0, rot);
      for (let k = 0; k < 16; k++) {
        const ang = (k / 16) * Math.PI * 2;
        const con = real('c', 'connector', Math.cos(ang) * 420, Math.sin(ang) * 420);
        pick.a = pick.b = -2;
        expect(canConnect(solar, con, NONE, map(solar, con), undefined, pick), `rot ${rot} dir ${k}`).toEqual({ ok: true });
        const sa = sock(solar, pick.a), sb = sock(con, pick.b);
        // The picked solar socket faces the connector socket it cables to.
        expect(sa.nx * (sb.x - sa.x) + sa.ny * (sb.y - sa.y)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('a socket facing away is refused for a building, taken by an emitter (any side)', () => {
    // A battery's free sockets all face away from a partner behind it: only
    // its east (0) and south (3) studs face south-east, and both hold cables.
    const bat = real('b', 'battery', 0, 0);
    const con = real('c', 'connector', 400, -400);
    expect(pickCableSocketPair(bat, con, CONNECTION_MAX_RANGE, map(bat, con), undefined, pick, 0b1001, 0))
      .toBe('no-facing-socket');
    // The gate's two posts face ±x; a partner off to the side faces neither,
    // but the emitter takes a cable from any side (any-side is by kind).
    const gate = real('g', 'shield_gate', 0, 0);
    const above = real('c', 'connector', 0, 400);
    expect(canConnect(gate, above, NONE, map(gate, above)).ok).toBe(true);
  });

  it('a curve that crosses a building is refused; one that bends round it is not', () => {
    const a = real('a', 'connector', -300, 0);
    const b = real('b', 'connector', 300, 0);
    // A small box on the centre line: the straight (nearest) pair is blocked,
    // a pair off the line clears it and wins.
    const small = real('m', 'connector', 0, 0, 0, { halfW: 8, halfH: 35 });
    expect(canConnect(a, b, NONE, map(a, b, small), undefined, pick)).toEqual({ ok: true });
    // Not one of the two straight front pairs (their slight bend still crosses the box).
    expect([[0, 2], [5, 3]]).not.toContainEqual([pick.a, pick.b]);
    // Without the box the first front pair wins.
    expect(canConnect(a, b, NONE, map(a, b), undefined, pick)).toEqual({ ok: true });
    expect([pick.a, pick.b]).toEqual([0, 2]);
    // A wall across every curve: refused.
    const wall = real('w', 'connector', 0, 0, 0, { halfW: 30, halfH: 200 });
    expect(canConnect(a, b, NONE, map(a, b, wall))).toEqual({ ok: false, reason: 'blocked' });
    // An obstacle (rock) counts the same way.
    expect(canConnect(a, b, NONE, map(a, b), [{ x: 0, y: 0, radius: 150 }])).toEqual({ ok: false, reason: 'blocked' });
  });

  it('reach is socket to socket: in edge range but too far post to post is refused', () => {
    // Edge to edge 650 - 32 - 36 = 582 (in range), but the gate's posts sit
    // 124 u along its length, so the nearest socket pair is ~635 u apart.
    const con = real('c', 'connector', 0, 0);
    const gate = real('g', 'shield_gate', 650, 0, Math.PI / 2);
    expect(canConnect(con, gate, NONE, map(con, gate))).toEqual({ ok: false, reason: 'out-of-range' });
    // Nearer, it links.
    const near = { ...gate, x: 600 };
    expect(canConnect(con, near, NONE, map(con, near)).ok).toBe(true);
    expect(CONNECTION_MAX_RANGE).toBe(600);
  });

  it('the pick is deterministic: nearest first, ties in socket order', () => {
    // Two connectors face to face: the two front pairs tie on distance; the
    // first in socket order (a's socket 0, b's socket 2) wins, every call.
    const a = real('a', 'connector', 0, 0);
    const b = real('b', 'connector', 300, 0);
    const nodes = map(a, b);
    for (let i = 0; i < 3; i++) {
      expect(canConnect(a, b, NONE, nodes, undefined, pick).ok).toBe(true);
      expect([pick.a, pick.b]).toEqual([0, 2]);
    }
    // Swapped arguments: the same cable, indices swapped to match.
    expect(canConnect(b, a, NONE, nodes, undefined, pick).ok).toBe(true);
    expect([pick.a, pick.b]).toEqual([2, 0]);
  });

  it('a fence link (emitter to emitter) stays straight post to post', () => {
    const p1 = real('p1', 'shield_pylon', 0, 0);
    const p2 = real('p2', 'shield_pylon', 500, 0);
    pick.a = pick.b = 3;
    expect(canConnect(p1, p2, NONE, map(p1, p2), undefined, pick)).toEqual({ ok: true });
    expect([pick.a, pick.b]).toEqual([CABLE_NO_SOCKET, CABLE_NO_SOCKET]);
    // The centre line is what counts: a small box on it blocks, even though a
    // curved cable could bend round it.
    const small = real('m', 'connector', 250, 0, 0, { halfW: 8, halfH: 8 });
    expect(canConnect(p1, p2, NONE, map(p1, p2, small))).toEqual({ ok: false, reason: 'blocked' });
  });

  it('a refused link leaves the scratch pick untouched', () => {
    const a = real('a', 'connector', 0, 0);
    const far = real('f', 'connector', 2000, 0);
    pick.a = 7; pick.b = 8;
    expect(canConnect(a, far, NONE, map(a, far), undefined, pick).ok).toBe(false);
    expect([pick.a, pick.b]).toEqual([7, 8]);
  });
});

describe('one cable per stud on a socket-bound building (owner rule)', () => {
  /** Link `a`-`b` as the server does: canConnect, then store the picked pair. */
  function link(a: GridNode, b: GridNode, adj: Map<string, Connection[]>, nodes: Map<string, GridNode>): [number, number] {
    const r = canConnect(a, b, adj, nodes, undefined, pick);
    expect(r, `${a.id}-${b.id}`).toEqual({ ok: true });
    const c = new Connection(adj.size + 100, a.id, b.id, 1, pick.a, pick.b);
    (adj.get(a.id) ?? adj.set(a.id, []).get(a.id)!).push(c);
    (adj.get(b.id) ?? adj.set(b.id, []).get(b.id)!).push(c);
    return [pick.a, pick.b];
  }

  it('every kind fits its sockets in the used-socket mask', () => {
    for (const k of STRUCTURE_KINDS_LIST) expect(structureSockets(k.id).length, k.id).toBeLessThanOrEqual(CABLE_SOCKET_MASK_BITS);
  });

  it('two connectors east of a battery get two different battery sockets', () => {
    const bat = real('bat', 'battery', 0, 0, 0, { maxConnections: 4 });
    const c1 = real('c1', 'connector', 400, 150);
    const c2 = real('c2', 'connector', 400, -150);
    const nodes = map(bat, c1, c2);
    const adj = new Map<string, Connection[]>();
    const [s1] = link(bat, c1, adj, nodes);
    const [s2] = link(bat, c2, adj, nodes);
    expect(s1).toBe(0); // the east stud
    expect(s2).not.toBe(s1);
    expect(linkSocketMask('bat', adj.get('bat')!)).toBe(((1 << s1) | (1 << s2)) >>> 0);
    // Either argument order reads the battery's used studs (the west one is free).
    const c3 = real('c3', 'connector', -400, 0);
    nodes.set('c3', c3);
    expect(canConnect(c3, bat, adj, nodes, undefined, pick).ok).toBe(true);
    expect([s1, s2]).not.toContain(pick.b);
  });

  it('a battery whose facing studs are all used refuses; with all four used it is full', () => {
    const bat = real('bat', 'battery', 0, 0, 0, { maxConnections: 5 });
    const nodes = map(bat);
    const adj = new Map<string, Connection[]>();
    // One connector per side: each takes the stud facing it.
    const sides: Array<[number, number]> = [[400, 0], [0, 400], [-400, 0], [0, -400]];
    const used: number[] = [];
    sides.forEach(([x, y], i) => {
      const c = real(`c${i}`, 'connector', x, y);
      nodes.set(c.id, c);
      used.push(link(bat, c, adj, nodes)[0]);
    });
    expect([...used].sort()).toEqual([0, 1, 2, 3]);
    // The socket clamp holds it at 4 links whatever its level cap says.
    const more = real('more', 'connector', 300, 300);
    nodes.set('more', more);
    expect(canConnect(bat, more, adj, nodes)).toEqual({ ok: false, reason: 'a-full' });
    // Every stud used: the picker itself finds no free facing pair.
    expect(pickCableSocketPair(bat, more, CONNECTION_MAX_RANGE, nodes, undefined, pick, 0b1111, 0)).toBe('no-facing-socket');
    // Two links on the east and south studs: a partner south-east has no free facing stud.
    const two = new Map<string, Connection[]>([['bat', [
      new Connection(1, 'bat', 'x', 1, 0, 0), new Connection(2, 'y', 'bat', 1, 0, 3),
    ]]]);
    const se = real('se', 'connector', 400, -400);
    nodes.set('se', se);
    expect(canConnect(bat, se, two, nodes)).toEqual({ ok: false, reason: 'no-facing-socket' });
    expect(canConnect(se, bat, two, nodes)).toEqual({ ok: false, reason: 'no-facing-socket' });
  });

  it('connector ends share sockets freely', () => {
    const hub = real('hub', 'connector', 0, 0);
    const sol = real('sol', 'solar', 420, 0);
    const nodes = map(hub, sol);
    expect(pickCableSocketPair(hub, sol, CONNECTION_MAX_RANGE, nodes, undefined, pick, 0, 0)).toBeNull();
    const free = pick.a;
    // Every hub face marked used: a connector end ignores its mask.
    expect(pickCableSocketPair(hub, sol, CONNECTION_MAX_RANGE, nodes, undefined, pick, 0x3f, 0)).toBeNull();
    expect(pick.a).toBe(free);
    // Through canConnect: two solars east of a hub both land on its east face.
    const s2 = real('s2', 'solar', 420, 0);
    const adj = new Map<string, Connection[]>([['hub', [new Connection(1, 'hub', 'sol', 1, free, 2)]]]);
    expect(canConnect(hub, s2, adj, map(hub, s2), undefined, pick).ok).toBe(true);
    expect(pick.a).toBe(free);
  });

  it('the build preview (sockets from connSockSelf) and the server (from links) pick the same pair', () => {
    const bat = real('bat', 'battery', 0, 0, 0, { maxConnections: 4 });
    const c1 = real('c1', 'connector', 400, 150);
    const nodes = map(bat, c1);
    const adj = new Map<string, Connection[]>();
    link(bat, c1, adj, nodes);
    // The server: real links carrying their sockets.
    const ghost = real('__ghost__', 'connector', 400, -150);
    expect(canConnect(ghost, bat, adj, map(bat, c1, ghost), undefined, pick).ok).toBe(true);
    const server = [pick.a, pick.b];
    // The preview: link stand-ins with no sockets, the used studs on the node.
    const stand = (aId: string, bId: string): Connection => ({
      aId, bId, getOtherNode: (id: string) => (id === aId ? bId : id === bId ? aId : null),
    }) as unknown as Connection;
    const previewAdj = new Map<string, Connection[]>([['bat', [stand('bat', 'c1')]], ['c1', [stand('c1', 'bat')]]]);
    const selfSocks = adj.get('bat')!.map((c) => c.socketAt('bat'));
    const pBat = { ...bat, usedSockets: socketListMask(selfSocks) };
    const pC1 = { ...c1, usedSockets: socketListMask(adj.get('c1')!.map((c) => c.socketAt('c1'))) };
    pick.a = pick.b = -2;
    expect(canConnect(ghost, pBat, previewAdj, map(pBat, pC1, ghost), undefined, pick).ok).toBe(true);
    expect([pick.a, pick.b]).toEqual(server);
    expect(server[1]).not.toBe(selfSocks[0]);
  });
});
