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
import { CABLE_NO_SOCKET, makeCableSocketPick } from './cableCurve.js';
import { CONNECTION_MAX_RANGE } from './structureGridConstants.js';
import {
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

  it('a socket facing away is refused for a building, taken by a connector (any side)', () => {
    // Two sockets facing ±x (the gate's post layout); the partner sits off to
    // the side, so neither socket faces it.
    const con = real('c', 'connector', 0, 400);
    const building = real('b', 'shield_gate', 0, 0, 0, { isShieldPylon: false });
    expect(canConnect(building, con, NONE, map(building, con))).toEqual({ ok: false, reason: 'no-facing-socket' });
    // The same two sockets on an any-side end: a connector, or the real
    // emitter (its sockets are round posts).
    const anySide = { ...building, isConnector: true };
    expect(canConnect(anySide, con, NONE, map(anySide, con)).ok).toBe(true);
    const gate = real('g', 'shield_gate', 0, 0);
    expect(canConnect(gate, con, NONE, map(gate, con)).ok).toBe(true);
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
