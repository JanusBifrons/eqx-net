/**
 * Base platforms slices 10/11 — the deck link rule (plan
 * `.resume/base-platforms-plan.md`, "Power on a plate"). On a deck room a
 * plate-anchor connector ({@link isPlateAnchor}) links:
 *   - (slice 10) to any structure whose centre lies on ITS plate, and
 *   - (slice 11) to a plate-anchor connector on a NEIGHBOURING plate,
 * past `CONNECTION_MAX_RANGE` and past the anchor's link cap (`canConnect`).
 * Slice 19 (fence): two shield pylons on the two ends of ONE hex edge (a seam,
 * `deckCorners.ts`) link past range, so the `ShieldWallManager` / client
 * `derivedWalls` wall forms along the seam. On a deck, pylon pairs link ONLY
 * along seams (`isDeckFenceOffSeam`: `canConnect` refuses `'off-seam'`); gates
 * and airlocks keep the normal range rule.
 * Slice 21 (gate): a shield gate on a seam's midpoint and a pylon on one END
 * of that seam link past range ({@link DECK_LINK_SEAM_GATE}), so the fence line
 * runs pylon → gate post → gate → gate post → pylon; on a deck a gate links to
 * no other pylon or gate (`'off-seam'`). The seam's own pylon-to-pylon wall
 * is replaced: its line crosses the gate (`'blocked'`), and placing the gate
 * cuts an existing one (`deckGateCutsFenceLink`).
 *
 * Pure geometry over kind + world centre, so the server projection and the
 * client mirror evaluate the identical rule (invariant 15). Ownership is the
 * caller's filter, exactly as for every other `canConnect` link.
 * Allocation-free (module scratch, invariant 14).
 */
import { pixelToAxialInto, type AxialHex } from '../hex/hex.js';
import { DECK_HEX_SIZE, PLATE_DIRS, plateOfHexInto, type PlateIndex } from '../hex/plates.js';
import { isPlateAnchor } from '../hex/plateSet.js';
import { isDeckSeam, isDeckSeamEnd } from '../hex/deckCorners.js';
// Type-only imports of Grid / cableCurve (both call into this module).
import type { CanConnectResult, GridNode } from './Grid.js';
import { CABLE_NO_SOCKET, type Connection } from './Connection.js';
import type { CableSocketPick } from './cableCurve.js';

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
/** Slice 19: two fence posts on the ends of one hex seam. */
export const DECK_LINK_SEAM_FENCE = 3;
/** Slice 21: a fence gate on a seam midpoint and a post on that seam's end. */
export const DECK_LINK_SEAM_GATE = 4;
export type DeckLinkKind =
  | typeof DECK_LINK_NONE | typeof DECK_LINK_ON_PLATE | typeof DECK_LINK_NEIGHBOUR | typeof DECK_LINK_SEAM_FENCE | typeof DECK_LINK_SEAM_GATE;

/** The kind a deck fence post is: it snaps to a hex corner (`deckPlacement.ts`)
 *  and pairs along seams. */
export const DECK_FENCE_POST_KIND = 'shield_pylon';

/** The kind a deck fence gate is: it snaps to a hex edge midpoint along the
 *  seam (`deckPlacement.ts`) and links to the seam's two end posts. */
export const DECK_FENCE_GATE_KIND = 'shield_gate';

const isFencePart = (k: string): boolean => k === DECK_FENCE_POST_KIND || k === DECK_FENCE_GATE_KIND;

/** Is the (post, gate) pair, either order, a post on an end of the gate's seam? */
function isSeamGatePair(a: DeckLinkEnd, b: DeckLinkEnd): boolean {
  if (a.kind === DECK_FENCE_POST_KIND && b.kind === DECK_FENCE_GATE_KIND) return isDeckSeamEnd(a.x, a.y, b.x, b.y);
  if (a.kind === DECK_FENCE_GATE_KIND && b.kind === DECK_FENCE_POST_KIND) return isDeckSeamEnd(b.x, b.y, a.x, a.y);
  return false;
}

/** On a deck: are `a` and `b` two fence parts (posts, gates) NOT linked along
 *  one seam (refused `'off-seam'`: deck fences run only along hex edges)?
 *  Post–post: the two ends of a seam; post–gate: the post on an end of the
 *  gate's seam; gate–gate: never. */
export function isDeckFenceOffSeam(a: DeckLinkEnd, b: DeckLinkEnd): boolean {
  if (!isFencePart(a.kind) || !isFencePart(b.kind)) return false;
  if (a.kind === DECK_FENCE_POST_KIND && b.kind === DECK_FENCE_POST_KIND) return !isDeckSeam(a.x, a.y, b.x, b.y);
  return !isSeamGatePair(a, b);
}

/** Slice 21: does a deck fence gate `gate` replace the post–post link `a`–`b`
 *  (both posts on the two ends of the gate's seam)? The server cuts that link
 *  when the gate is placed (`autoConnectStructure`), so the gate's own two
 *  links carry the fence line. Callers gate on the room's deck flag. */
export function deckGateCutsFenceLink(gate: DeckLinkEnd, a: DeckLinkEnd, b: DeckLinkEnd): boolean {
  return gate.kind === DECK_FENCE_GATE_KIND && a.kind === DECK_FENCE_POST_KIND && b.kind === DECK_FENCE_POST_KIND
    && isDeckSeamEnd(a.x, a.y, gate.x, gate.y) && isDeckSeamEnd(b.x, b.y, gate.x, gate.y);
}

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
 * {@link DECK_LINK_SEAM_FENCE} for two fence posts on one seam,
 * {@link DECK_LINK_SEAM_GATE} for a gate and a post on its seam's end, else
 * {@link DECK_LINK_NONE}. Callers gate on the room's deck flag.
 */
export function deckLinkKind(a: DeckLinkEnd, b: DeckLinkEnd): DeckLinkKind {
  if (a.kind === DECK_FENCE_POST_KIND && b.kind === DECK_FENCE_POST_KIND) {
    return isDeckSeam(a.x, a.y, b.x, b.y) ? DECK_LINK_SEAM_FENCE : DECK_LINK_NONE;
  }
  if (isSeamGatePair(a, b)) return DECK_LINK_SEAM_GATE;
  const aAnchor = isPlateAnchor(a.kind, a.x, a.y);
  const bAnchor = isPlateAnchor(b.kind, b.x, b.y);
  if (!aAnchor && !bAnchor) return DECK_LINK_NONE;
  plateOfWorldInto(a.x, a.y, PA);
  plateOfWorldInto(b.x, b.y, PB);
  if (PA.i === PB.i && PA.j === PB.j) return DECK_LINK_ON_PLATE;
  if (!aAnchor || !bAnchor) return DECK_LINK_NONE;
  const di = PB.i - PA.i, dj = PB.j - PA.j;
  for (let k = 0; k < PLATE_DIRS.length; k++) {
    const d = PLATE_DIRS[k]!;
    if (d.i === di && d.j === dj) return DECK_LINK_NEIGHBOUR;
  }
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

/**
 * `canConnect`'s verdict on a deck link (`dk` != none; slice 12): its cable
 * is the seam path (`flattenDeckSeamCable`, centre to centre), so it takes no
 * socket (`CABLE_NO_SOCKET` both ends) and skips the overlap and crossing
 * refusals (deck cables share seams by design). Always ok.
 */
export function deckSeamVerdict(sockets: CableSocketPick | undefined): CanConnectResult {
  if (sockets) { sockets.a = CABLE_NO_SOCKET; sockets.b = CABLE_NO_SOCKET; }
  return DECK_OK;
}

const DECK_OK: CanConnectResult = Object.freeze({ ok: true });
