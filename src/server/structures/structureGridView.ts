/**
 * Projects the server-side `StructureRegistry` into the zone-pure `GridNode`
 * view the core `Grid` consumes, and the auto-connect-on-place helper
 * (speed-dial-resource-structures plan, Phase 3).
 *
 * The `isConstructed` gate lives here: a blueprint projects `powerOutput /
 * powerConsumption = 0` (inert until built), so the grid never counts a
 * half-built node's power.
 */
import { structureDraw } from '../../shared-types/structurePower.js';
import { getStructureKind, isConnectorKind } from '../../shared-types/structureKinds.js';
import { isShieldEmitterKind } from '../../core/structures/gateGeometry.js';
import { gridLinkAllowed, isUnownedOwner } from '../../shared-types/relations.js';
import { effectiveStructurePowerOutput, effectiveStructureMaxConnections } from '../../core/leveling/structureLevel.js';
import {
  canConnect,
  edgeDistance,
  type CanConnectReason,
  type GridNode,
  type GridObstacle,
  type ObstacleBox,
} from '../../core/structures/Grid.js';
import {
  CONNECTION_MAX_RANGE,
  CONNECTION_THROUGHPUT,
  PLACEMENT_MAX_CONNECTIONS,
} from '../../core/structures/structureGridConstants.js';
import { linkReachBoxAdd, linkReachBoxStart, makeCableSocketPick } from '../../core/structures/cableCurve.js';
import { makeCableReseat } from '../../core/structures/socketReseat.js';
import { DECK_LINK_NONE, deckLinkKind } from '../../core/structures/deckLinks.js';
import type { StructureRecord, StructureRegistry } from './StructureRegistry.js';

/** Scratch socket pick for every link made here: `canConnect` writes the
 *  chosen pair, `addConnection` stores it on the `Connection` (0d slice 5).
 *  Module-level, reused (root invariant #14). */
const linkPick = makeCableSocketPick();
/** Scratch: the connector link a player's link moves to another face to make
 *  room (`pickWithReseat`, one cable per socket); the build preview passes one too (#15). */
const linkReseat = makeCableReseat();

export function structureToGridNode(rec: StructureRecord): GridNode {
  const kind = getStructureKind(rec.kind);
  // Phase 4 WS-B4 — a leveled generator (solar / capital) outputs MORE power.
  // `effectiveStructurePowerOutput` scales `powerOutput` (shared with the
  // client mirror, #15); consumption is unscaled (a leveled consumer still
  // draws its base, so the leveled grant is a pure surplus boost).
  // Review must-fix #2 (2026-06-20, plan effervescent-umbrella): a Capital that
  // is MID-UPGRADE (`rec.isConstructed=false` but `upgradeTargetLevel` set) is
  // an already-operational bank being RE-built, NOT a fresh blueprint — so in
  // the grid VIEW it stays BUILT: traversable as a route SOURCE + relay and
  // power-generating. The `StructureRecord.isConstructed` field itself stays
  // false (so `processConstruction` runs the visible build phase + the
  // funding/completion machinery), but `Grid` must see it as a live source or
  // the construction stream can never reach it (or anything else) — bricking the
  // whole grid (see `findStorageRoute`). This ONLY applies to the Capital, which
  // is the grid's funder; a mid-upgrade LEAF (turret/solar/etc.) is a normal
  // dead-end blueprint while it re-builds.
  const operational = rec.isConstructed || (rec.kind === 'capital' && rec.upgradeTargetLevel !== undefined);
  return {
    id: rec.id,
    kind: rec.kind,
    x: rec.x,
    y: rec.y,
    // Socket rotation: degrees on the record, radians on the node (the
    // client's swarm angle; `rotateStructureSocket` convention).
    rot: ((rec.rot ?? 0) * Math.PI) / 180,
    ...(rec.mirror === true ? { mirror: true } : {}),
    radius: rec.radius,
    halfW: rec.halfW,
    halfH: rec.halfH,
    isHub: kind.isHub,
    isCapital: rec.kind === 'capital',
    // Capture plan 4E — a base that lost its last Capital keeps its power
    // (owner: no faction, everything else works as before).
    rootsPower: isUnownedOwner(rec.owner),
    isConnector: isConnectorKind(rec.kind),
    // Gates join a fence like a pylon (pylon connection rules).
    isShieldPylon: isShieldEmitterKind(rec.kind),
    // Leveled connection cap — an upgraded connector holds MORE links (Equinox
    // Phase-5 audit). Matches the client `structureMirrorToGridNode` so the
    // preview + live grid agree on the cap.
    maxConnections: effectiveStructureMaxConnections(kind.maxConnections, rec.level, rec.kind),
    connectionRange: kind.connectionRange,
    // The isConstructed gate: a blueprint is inert (0 power) until built. A
    // mid-upgrade Capital (see above) is treated as operational so it keeps
    // funding power + minerals through its own re-build.
    // D1 — a fuel-burning kind (Reactor) outputs only while fuelled.
    powerOutput: operational && (kind.fuelEveryPulses == null || rec.fueled === true) ? effectiveStructurePowerOutput(kind.powerOutput, rec.level) : 0,
    // Active power — full draw while active, an idle trickle otherwise.
    powerConsumption: operational ? structureDraw(kind.powerConsumption, rec.drawFull === true, rec.switchedOff === true, rec.throttle) : 0,
    isConstructed: operational,
  };
}

/** Build the full `Map<id, GridNode>` from the registry. */
export function buildGridNodes(registry: StructureRegistry): Map<string, GridNode> {
  const nodes = new Map<string, GridNode>();
  for (const rec of registry.all()) nodes.set(rec.id, structureToGridNode(rec));
  return nodes;
}

/** One auto-connect candidate: an in-range, legal hub the new structure may link
 *  to, with its edge-distance for the deterministic (distance, id) ordering. */
interface ConnectCandidate {
  id: string;
  dist: number;
}

/** Why `autoConnectStructure` linked nothing: the most telling refusal seen
 *  across every same-owner structure (see `REFUSAL_RANK`), or `null` when
 *  there was no same-owner structure at all. Caller-owned scratch. */
export interface AutoConnectRefusal {
  reason: CanConnectReason | null;
}

/** Which refusal explains a failed link best, highest first: the structure's
 *  OWN full slots, then a line blocked (by a rock, building or another cable) to a partner
 *  it may link to, then no usable socket, a full partner, the wrong partner
 *  type, an existing link, and last nothing in reach. */
const REFUSAL_RANK: Readonly<Record<CanConnectReason, number>> = Object.freeze({
  'a-full': 9,
  blocked: 8,
  'crosses-cable': 8,
  'too-short': 7,
  'no-facing-socket': 6,
  'b-full': 5,
  'pylon-rule': 4,
  'off-seam': 4,
  'capital-only': 3,
  'connector-required': 3,
  duplicate: 2,
  'out-of-range': 1,
  self: 0,
});

/** Plain player-facing notice for a manual reconnect that linked nothing,
 *  by refusal (`null`: no building of the owner's in reach). */
const RECONNECT_REFUSAL_NOTICE: Readonly<Record<CanConnectReason, string>> = Object.freeze({
  'a-full': "Can't link: it has no free connection slots",
  blocked: "Can't link: the way is blocked by an asteroid or structure",
  'crosses-cable': "Can't link: crosses another cable",
  'too-short': "Can't link: too close to the building in reach",
  'no-facing-socket': "Can't link: no free socket faces a building in reach",
  'b-full': "Can't link: the buildings in reach have no free slots",
  'pylon-rule': "Can't link: shield posts link only to a Connector or another shield post",
  'off-seam': "Can't link: shield posts on a deck link only along a hex edge",
  'capital-only': "Can't link: needs a Connector in reach",
  'connector-required': "Can't link: needs a Connector in reach",
  duplicate: 'Already linked to everything in reach',
  'out-of-range': "Can't link: no building in reach to link to",
  self: "Can't link: no building in reach to link to",
});

/** The notice for a reconnect that linked nothing (see `AutoConnectRefusal`). */
export function reconnectRefusalNotice(reason: CanConnectReason | null): string {
  return RECONNECT_REFUSAL_NOTICE[reason ?? 'out-of-range'];
}

/** Keep the better-ranked of `why`'s refusal and `reason`. */
function noteRefusal(why: AutoConnectRefusal, reason: CanConnectReason): void {
  if (why.reason === null || REFUSAL_RANK[reason] > REFUSAL_RANK[why.reason]) why.reason = reason;
}

/**
 * Auto-connect a freshly-placed structure into its owner's grid (WS-5 / R2.17 —
 * MULTI-connect). Link it to EVERY in-range hub (Connector / Capital) with a free
 * slot that passes `canConnect`, in deterministic (distance, id) order, until the
 * new structure's own `maxConnections` OR the global `PLACEMENT_MAX_CONNECTIONS`
 * cap is reached. A leaf (cap 1) therefore still connects to exactly the nearest
 * hub — the multi-connect only widens hubs (a Connector fans out to up to 6).
 * If none qualifies, the structure stays unconnected (renders dimmed/unpowered)
 * until the player drops a Connector to bridge it — The Space Game's relay
 * workflow. Returns the NEAREST connected neighbour id (backward-compatible with
 * the old single-id return), or null.
 *
 * Only links structures `gridLinkAllowed` lets join: the SAME owner, or a player
 * and an ownerless base, which the pulse then captures (connections are per-owner,
 * intra-sector).
 *
 * `obstacles` (Item D) — non-structure bodies (asteroids) that block a
 * connection's line of sight. Optional: omitting it falls back to the
 * structures-only LOS check (byte-identical to pre-Item-D).
 *
 * Placement is a low-frequency wire event (not a 60 Hz tick) and grids are small
 * (cap ≤ 6), so the gather + sort + per-iteration `canConnect` re-check is not a
 * hot-loop allocation concern (invariant #14). The per-iteration re-check is
 * load-bearing: each `addConnection` mutates the LIVE `adjacency` view, so a hub
 * that was free may fill AND the new node's own slot count rises as it connects.
 *
 * `why` (optional) gets the best refusal (`REFUSAL_RANK`) when NOTHING links,
 * so a manual reconnect can tell the player why; null once anything links.
 */
export function autoConnectStructure(
  registry: StructureRegistry,
  newId: string,
  obstacles?: readonly GridObstacle[],
  why?: AutoConnectRefusal,
): string | null {
  if (why) why.reason = null;
  const newRec = registry.get(newId);
  if (!newRec) return null;
  const nodes = buildGridNodes(registry);
  const adjacency = registry.adjacencyMap();
  const newNode = nodes.get(newId)!;

  // Gather every legal, in-range hub the new structure could link to right now.
  const candidates: ConnectCandidate[] = [];
  for (const other of registry.all()) {
    if (other.id === newId) continue;
    if (!gridLinkAllowed(other.owner, newRec.owner)) continue; // per-owner grid (+ ownerless capture)
    const otherNode = nodes.get(other.id)!;
    const verdict = canConnect(newNode, otherNode, adjacency, nodes, obstacles, undefined, linkReseat, registry.deck);
    if (!verdict.ok) {
      if (why) noteRefusal(why, verdict.reason);
      continue;
    }
    candidates.push({ id: other.id, dist: edgeDistance(newNode, otherNode) });
  }
  if (candidates.length === 0) return null;
  // Deterministic order: nearest first, ties broken by id (no Map-iteration
  // flake — placement must be reproducible across runs).
  candidates.sort((p, q) => p.dist - q.dist || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));

  let firstConnected: string | null = null;
  let made = 0;
  for (const cand of candidates) {
    const otherNode = nodes.get(cand.id)!;
    // A deck link (base platforms) never counts toward the placement cap.
    const deckLink = registry.deck && deckLinkKind(newNode, otherNode) !== DECK_LINK_NONE;
    if (made >= PLACEMENT_MAX_CONNECTIONS && !deckLink) continue;
    // Re-check against the live adjacency: an earlier addition may have filled
    // this hub or the new node's own slots.
    const verdict = canConnect(newNode, otherNode, adjacency, nodes, obstacles, linkPick, linkReseat, registry.deck);
    if (!verdict.ok) {
      if (why) noteRefusal(why, verdict.reason);
      continue;
    }
    if (linkReseat.conn) registry.reseatConnection(linkReseat.conn, linkReseat.a, linkReseat.b);
    // canConnect(newNode, other) ⇒ pick.a is newId's socket, pick.b cand's.
    registry.addConnection(newId, cand.id, CONNECTION_THROUGHPUT, linkPick.a, linkPick.b);
    if (!deckLink) made++;
    if (firstConnected === null) firstConnected = cand.id;
  }
  if (why && firstConnected !== null) why.reason = null;
  return firstConnected;
}

/**
 * The world box every link `autoConnectStructure` could make from `id` lies
 * in: the bounds of its centre and the centres of the same-owner structures
 * within link range (`CONNECTION_MAX_RANGE`, edge to edge, as `canConnect`).
 * A link's cable (0d cable sockets) runs between sockets on each end's
 * outline and bends out at most `CABLE_TAIL_MAX` along their normals, so
 * each end widens the box by its half extent plus that tail: an obstacle
 * that can block one reaches this box. It is the `near` box for
 * `getObstacles`, so rocks with no body (an unloaded cut-field chunk, macro
 * terrain C5) block links too. False when nothing is in range: there is no
 * link to make. Writes `out`; no allocation.
 */
export function linkReachBox(registry: StructureRegistry, id: string, out: ObstacleBox): boolean {
  const rec = registry.get(id);
  if (!rec) return false;
  // The shared core maths (the build preview runs the same two calls, #15).
  linkReachBoxStart(rec, out);
  let found = false;
  for (const o of registry.all()) {
    if (o.id === id || !gridLinkAllowed(o.owner, rec.owner)) continue;
    // A deck link (base platforms) reaches past the range: its partner is in reach.
    const range = registry.deck && deckLinkKind(rec, o) !== DECK_LINK_NONE ? Infinity : CONNECTION_MAX_RANGE;
    if (linkReachBoxAdd(rec, o, range, out)) found = true;
  }
  return found;
}

/**
 * Link two SAME-OWNER structures explicitly (a generated base's intended
 * graph), re-checking the real `canConnect` against the live adjacency.
 * Returns false (and links nothing) when the rules reject the edge — a
 * generated layout must never bypass the building rules a player plays by.
 *
 * `nodes` lets a bulk seeder project the registry ONCE (`buildGridNodes`) and
 * reuse it across many edges. Seed-time only — not a hot path.
 */
export function connectExplicit(
  registry: StructureRegistry,
  aId: string,
  bId: string,
  nodes: ReadonlyMap<string, GridNode> = buildGridNodes(registry),
  obstacles?: readonly GridObstacle[],
): boolean {
  const a = registry.get(aId);
  const b = registry.get(bId);
  if (!a || !b || !gridLinkAllowed(a.owner, b.owner)) return false;
  const na = nodes.get(aId);
  const nb = nodes.get(bId);
  if (!na || !nb) return false;
  if (!canConnect(na, nb, registry.adjacencyMap(), nodes, obstacles, linkPick, undefined, registry.deck).ok) return false;
  registry.addConnection(aId, bId, CONNECTION_THROUGHPUT, linkPick.a, linkPick.b);
  return true;
}

/** Scratch: why the last manual reconnect linked nothing. */
const reconnectWhy: AutoConnectRefusal = { reason: null };

/** A manual reconnect (`StructureGridSubsystem.reconnect`): wire `id` to
 *  the nearest legal in-range hub(s), additively. Returns null when it linked,
 *  else the player-facing reason it linked nothing. `box` is caller scratch. */
export function reconnectWithNotice(
  registry: StructureRegistry,
  id: string,
  box: ObstacleBox,
  getObstacles?: (near?: ObstacleBox) => readonly GridObstacle[],
): string | null {
  const inReach = linkReachBox(registry, id, box);
  const linked = inReach && autoConnectStructure(registry, id, getObstacles?.(box), reconnectWhy) !== null;
  return linked ? null : reconnectRefusalNotice(inReach ? reconnectWhy.reason : null);
}
