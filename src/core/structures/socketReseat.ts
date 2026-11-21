/**
 * One cable per socket, without first-come greed: a connector picks each
 * cable's socket as the cable arrives (nearest pair first), so an early cable
 * can sit on the one face a later building needs while an equally good face
 * stays free. Example: capital west of a connector, a solar east, a turret
 * just below. The capital and solar cables take the two lower diagonal faces,
 * the straight-down face is too short for the turret (`MIN_CABLE_LENGTH`), and
 * the turret is refused with two upper faces free.
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
import { pickCableSocketPair, type CableSocketPick } from './cableCurve.js';
import type { GridNode, GridObstacle } from './Grid.js';
import { CONNECTION_MAX_RANGE } from './structureGridConstants.js';

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
      eIsA ? freed : usedA, eIsA ? usedB : freed, adjacency) !== null) continue;
    if ((eIsA ? newPick.a : newPick.b) !== s) continue;
    // The held link moves off `s` (now the new cable's) to another free face;
    // its far end keeps socket `q`.
    const range = Math.min(e.connectionRange ?? CONNECTION_MAX_RANGE, p.connectionRange ?? CONNECTION_MAX_RANGE);
    if (pickCableSocketPair(e, p, range, nodes, obstacles, movePick, usedE, (ALL & ~bit(q)) >>> 0, adjacency) !== null) continue;
    if (movePick.b !== q) continue;
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
