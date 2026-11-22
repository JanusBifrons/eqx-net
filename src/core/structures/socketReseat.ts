/**
 * One cable per socket, without first-come greed: a connector picks each
 * cable's socket as the cable arrives (nearest pair first), so an early cable
 * can sit on the one face a later building needs while an equally good face
 * stays free. Example: capital west of a connector on its face 1, a solar
 * east on face 0, a turret straight off face 1. The turret's cable from face
 * 0 or 2 would run within a cable width of the others (`cableCrossesExisting`),
 * so it is refused while the capital's cable could as well take face 2.
 *
 * `pickWithReseat` is `canConnect`'s fallback when the plain pick
 * (`pickCableSocketPair`) refuses: for a connector end, it frees one socket
 * its links hold, picks the new cable on it, and moves that held link's
 * connector end to another free face (its far end stays on the same socket)
 * under the same pick rules. The caller applies the move (`CableReseat`)
 * together with the new link. Same code on the server and the build preview
 * (#15). Allocation-free.
 */
// CABLE_NO_SOCKET from Connection, never via cableCurve's re-export: this
// module sits on the cableCurve -> Grid -> socketReseat cycle and reads it at
// load time (structureGridLoadOrder.test.ts).
import { CABLE_NO_SOCKET, type Connection } from './Connection.js';
import {
  CABLE_CROSS_STATS, CABLE_CURVE_FLOATS, CABLE_CURVE_SEGMENTS, flattenLinkCable,
  pickCableSocketPair, type CableBox, type CableSocketPick,
} from './cableCurve.js';
import { polylinesWithin } from './cableClearance.js';
import type { GridNode, GridObstacle } from './Grid.js';
import { CABLE_BODY_WIDTH, CONNECTION_MAX_RANGE } from './structureGridConstants.js';

/** An existing link `canConnect` moves to make room: `conn` (null: none) gets
 *  the socket pair `a` (its `aId` end) / `b` (its `bId` end). */
export interface CableReseat {
  conn: Connection | null;
  a: number;
  b: number;
}

export function makeCableReseat(): CableReseat {
  return { conn: null, a: CABLE_NO_SOCKET, b: CABLE_NO_SOCKET };
}

const newPick: CableSocketPick = { a: CABLE_NO_SOCKET, b: CABLE_NO_SOCKET };
const movePick: CableSocketPick = { a: CABLE_NO_SOCKET, b: CABLE_NO_SOCKET };
// Scratch for the new-vs-moved clearance test, made on first use (cableCurve
// and this module import each other through Grid, so not at load).
let newPoly: Float64Array | null = null, movePoly: Float64Array | null = null;
const newBox: CableBox = { x0: 0, y0: 0, x1: 0, y1: 0 }, moveBox: CableBox = { x0: 0, y0: 0, x1: 0, y1: 0 };

/** Does the new cable (`a`-`b` on `newPick`) come within a cable body width
 *  of link `e`-`p` moved to sockets `se` / `sp`? */
function movedCableClashes(a: GridNode, b: GridNode, e: GridNode, se: number, p: GridNode, sp: number): boolean {
  newPoly ??= new Float64Array(CABLE_CURVE_FLOATS);
  movePoly ??= new Float64Array(CABLE_CURVE_FLOATS);
  flattenLinkCable(a, newPick.a, b, newPick.b, newPoly, newBox);
  flattenLinkCable(e, se, p, sp, movePoly, moveBox);
  return polylinesWithin(newPoly, movePoly, moveBox, CABLE_CURVE_SEGMENTS, CABLE_BODY_WIDTH, CABLE_CROSS_STATS);
}
/** Every socket bit (a mask that holds all of them). */
const ALL = 0xffffffff;

function bit(s: number): number {
  return s >= 0 && s < 32 ? (1 << s) >>> 0 : 0;
}

/**
 * Try the `a`-`b` cable with one of connector end `e`'s held sockets freed
 * and that link moved. `eIsA`: `e` is `a`. Writes `out` / `reseat` and
 * returns true on success.
 */
function tryEnd(
  e: GridNode, eIsA: boolean, a: GridNode, b: GridNode, maxRange: number,
  adjacency: ReadonlyMap<string, readonly Connection[]>, nodes: ReadonlyMap<string, GridNode>,
  obstacles: readonly GridObstacle[] | undefined,
  out: CableSocketPick | undefined, usedA: number, usedB: number, reseat: CableReseat,
): boolean {
  if (!e.isConnector) return false;
  const links = adjacency.get(e.id);
  if (links === undefined) return false;
  const usedE = eIsA ? usedA : usedB;
  for (let k = 0; k < links.length; k++) {
    const l = links[k]!;
    const s = l.socketAt(e.id);
    const peerId = l.getOtherNode(e.id);
    if (s === CABLE_NO_SOCKET || peerId === null) continue;
    const p = nodes.get(peerId);
    const q = l.socketAt(peerId);
    if (p === undefined || q === CABLE_NO_SOCKET) continue;
    const freed = (usedE & ~bit(s)) >>> 0;
    if (pickCableSocketPair(a, b, maxRange, nodes, obstacles, newPick,
      eIsA ? freed : usedA, eIsA ? usedB : freed, adjacency, l) !== null) continue;
    if ((eIsA ? newPick.a : newPick.b) !== s) continue;
    // The held link moves off `s` (now the new cable's) to another free face;
    // its far end keeps socket `q`. (Its own old cable never counts against
    // it; the new cable, not stored yet, is checked after.)
    const range = Math.min(e.connectionRange ?? CONNECTION_MAX_RANGE, p.connectionRange ?? CONNECTION_MAX_RANGE);
    if (pickCableSocketPair(e, p, range, nodes, obstacles, movePick, usedE, (ALL & ~bit(q)) >>> 0, adjacency) !== null) continue;
    if (movePick.b !== q) continue;
    // The moved cable keeps a cable body width off the new one.
    if (movedCableClashes(a, b, e, movePick.a, p, q)) continue;
    if (out) { out.a = newPick.a; out.b = newPick.b; }
    reseat.conn = l;
    if (l.aId === e.id) { reseat.a = movePick.a; reseat.b = q; } else { reseat.a = q; reseat.b = movePick.a; }
    return true;
  }
  return false;
}

/** `canConnect`'s re-seat fallback (see the file doc): true when the `a`-`b`
 *  cable fits after moving one of a connector end's links (`reseat`), with
 *  the new pair in `out`. */
export function pickWithReseat(
  a: GridNode, b: GridNode, maxRange: number,
  adjacency: ReadonlyMap<string, readonly Connection[]>, nodes: ReadonlyMap<string, GridNode>,
  obstacles: readonly GridObstacle[] | undefined,
  out: CableSocketPick | undefined, usedA: number, usedB: number, reseat: CableReseat,
): boolean {
  return tryEnd(a, true, a, b, maxRange, adjacency, nodes, obstacles, out, usedA, usedB, reseat)
    || tryEnd(b, false, a, b, maxRange, adjacency, nodes, obstacles, out, usedA, usedB, reseat);
}
