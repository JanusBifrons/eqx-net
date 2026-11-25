/**
 * Base platforms slices 10/11 — the deck link rule (plan
 * `.resume/base-platforms-plan.md`, "Power on a plate"). On a deck room a
 * plate-anchor connector ({@link isPlateAnchor}) links:
 *   - (slice 10) to any structure whose centre lies on ITS plate, and
 *   - (slice 11) to a plate-anchor connector on a NEIGHBOURING plate,
 * past `CONNECTION_MAX_RANGE` and past the anchor's link cap (`canConnect`).
 *
 * Pure geometry over kind + world centre, so the server projection and the
 * client mirror evaluate the identical rule (invariant 15). Ownership is the
 * caller's filter, exactly as for every other `canConnect` link.
 * Allocation-free (module scratch, invariant 14).
 */
import { pixelToAxialInto, type AxialHex } from '../hex/hex.js';
import { DECK_HEX_SIZE, plateOfHexInto, type PlateIndex } from '../hex/plates.js';
import { isPlateAnchor } from '../hex/plateSet.js';
// Function-only cycle (Grid calls these; they call cableCurve, which calls Grid).
import type { CanConnectReason, CanConnectResult, GridNode, GridObstacle } from './Grid.js';
import type { Connection } from './Connection.js';
import { CABLE_CURVE_FLOATS, CABLE_NO_SOCKET, cableCrossesExisting, flattenLinkCable, isCablePolylineBlocked, type CableBox, type CableSocketPick } from './cableCurve.js';

/** What `deckLinkKind` needs of a structure: its kind and world centre. */
export interface DeckLinkEnd {
  readonly kind: string;
  readonly x: number;
  readonly y: number;
}

/** No deck link. */
export const DECK_LINK_NONE = 0;
/** Slice 10: an anchor and a structure on its plate. */
export const DECK_LINK_ON_PLATE = 1;
/** Slice 11: two anchors on neighbouring plates. */
export const DECK_LINK_NEIGHBOUR = 2;
export type DeckLinkKind = typeof DECK_LINK_NONE | typeof DECK_LINK_ON_PLATE | typeof DECK_LINK_NEIGHBOUR;

const HEX: AxialHex = { q: 0, r: 0 };
const PA: PlateIndex = { i: 0, j: 0 };
const PB: PlateIndex = { i: 0, j: 0 };

/** Allocation-free: the plate whose hex holds world point (x, y). */
export function plateOfWorldInto(x: number, y: number, out: PlateIndex): PlateIndex {
  pixelToAxialInto(x, y, DECK_HEX_SIZE, HEX);
  return plateOfHexInto(HEX.q, HEX.r, out);
}

/**
 * How `a` and `b` may link on a deck (order-free): {@link DECK_LINK_ON_PLATE}
 * when one is a plate anchor and the other's centre is on that plate,
 * {@link DECK_LINK_NEIGHBOUR} when both anchor neighbouring plates, else
 * {@link DECK_LINK_NONE}. Callers gate on the room's deck flag.
 */
export function deckLinkKind(a: DeckLinkEnd, b: DeckLinkEnd): DeckLinkKind {
  const aAnchor = isPlateAnchor(a.kind, a.x, a.y);
  const bAnchor = isPlateAnchor(b.kind, b.x, b.y);
  if (!aAnchor && !bAnchor) return DECK_LINK_NONE;
  plateOfWorldInto(a.x, a.y, PA);
  plateOfWorldInto(b.x, b.y, PB);
  if (PA.i === PB.i && PA.j === PB.j) return DECK_LINK_ON_PLATE;
  return DECK_LINK_NONE;
}

/** Does `n` skip its link cap for a link of deck kind `dk`? Only a plate
 *  anchor end does (slice 10: the anchor fans out past its 6; the other end
 *  keeps its own cap). Slice 11 links have an anchor at both ends. */
export function deckCapExempt(n: DeckLinkEnd, dk: DeckLinkKind): boolean {
  return dk !== DECK_LINK_NONE && isPlateAnchor(n.kind, n.x, n.y);
}

/** The links that count toward `n`'s cap: on a deck, a plate anchor's deck
 *  links never count (they are not blocked by the cap and must not fill it);
 *  everything else counts every link. Allocation-free. */
export function deckCapLinkCount(
  n: GridNode,
  conns: readonly Connection[],
  nodes: ReadonlyMap<string, GridNode>,
  deck: boolean,
): number {
  if (!deck || !isPlateAnchor(n.kind, n.x, n.y)) return conns.length;
  let count = 0;
  for (let c = 0; c < conns.length; c++) {
    const other = conns[c]?.getOtherNode(n.id);
    const o = other == null ? undefined : nodes.get(other);
    if (o === undefined || deckLinkKind(n, o) === DECK_LINK_NONE) count++;
  }
  return count;
}

/** Straight-cable scratch for {@link deckStraightRefusal} (invariant 14). */
// Built on first use: this module loads inside the Grid <-> cableCurve cycle,
// so cableCurve's exports are not ready at load time.
let straightPoly: Float64Array | null = null;
const straightBox: CableBox = { x0: 0, y0: 0, x1: 0, y1: 0 };

/**
 * A deck link whose socket pick found no free facing socket pair (a plate
 * connector fans out past its 6 sockets): the link takes no sockets
 * (`CABLE_NO_SOCKET`, drawn centre to centre) and still passes the SAME
 * overlap (`isCablePolylineBlocked`) and crossing (`cableCrossesExisting`)
 * refusals as every socket cable. Returns the refusal or null.
 *
 * TODO(base-platforms slice 12): unsocketed cables of one plate connector
 * all start at its centre, so `cableCrossesExisting` refuses every second
 * one ('crosses-cable', shared end point within `CABLE_BODY_WIDTH`). Slice
 * 12 gives deck cables their seam path and the crossing/overlap exemption.
 */
export function deckStraightRefusal(
  a: GridNode,
  b: GridNode,
  adjacency: ReadonlyMap<string, readonly Connection[]>,
  nodes: ReadonlyMap<string, GridNode>,
  obstacles: readonly GridObstacle[] | undefined,
  sockets: CableSocketPick | undefined,
): CanConnectReason | null {
  if (sockets) { sockets.a = CABLE_NO_SOCKET; sockets.b = CABLE_NO_SOCKET; }
  straightPoly ??= new Float64Array(CABLE_CURVE_FLOATS);
  flattenLinkCable(a, CABLE_NO_SOCKET, b, CABLE_NO_SOCKET, straightPoly, straightBox);
  if (isCablePolylineBlocked(a, b, straightPoly, straightBox, nodes, obstacles)) return 'blocked';
  if (cableCrossesExisting(a, b, straightPoly, straightBox, adjacency, nodes)) return 'crosses-cable';
  return null;
}

/** `canConnect`'s verdict on a refused socket pick: a deck link (`dk`) whose
 *  pick found no free facing socket pair tries {@link deckStraightRefusal};
 *  any other refusal stands. */
export function deckRefusalVerdict(
  dk: DeckLinkKind,
  refusal: CanConnectReason,
  a: GridNode,
  b: GridNode,
  adjacency: ReadonlyMap<string, readonly Connection[]>,
  nodes: ReadonlyMap<string, GridNode>,
  obstacles: readonly GridObstacle[] | undefined,
  sockets: CableSocketPick | undefined,
): CanConnectResult {
  const why = dk !== DECK_LINK_NONE && refusal === 'no-facing-socket' ? deckStraightRefusal(a, b, adjacency, nodes, obstacles, sockets) : refusal;
  return why === null ? DECK_OK : { ok: false, reason: why };
}

const DECK_OK: CanConnectResult = Object.freeze({ ok: true });
