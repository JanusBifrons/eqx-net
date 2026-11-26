/**
 * Edge placement slice 2 — the FENCE RUN (plan `.resume/edge-placement-plan.md`).
 * With the fence post (`shield_pylon`) picked on a deck room, each Place on a
 * hex corner puts a post there if it has none (an existing post is reused),
 * and fills a post on every corner along the shortest run of plated hex
 * edges from the previous click's corner (`core/hex/deckCornerGraph.ts`,
 * searched by the one `GraphSearch`). Inner edges count, not just the rim.
 *
 * Nothing new on the wire: each missing corner is one ordinary
 * `place_structure` at its exact corner (`placeStructureAt`), and the
 * server's `autoConnectStructure` links two posts on one seam
 * (`DECK_LINK_SEAM_FENCE`), so the beams appear by themselves. Cost is the
 * same as placing each post by hand.
 *
 * A corner the ghost's own rule (`PlacementGhostVerdict`, the server's
 * `placementRejection`; rocks are not on this list) would refuse ends the run
 * there: that corner is still sent, so the server's refusal notice
 * (`lastRefusal`) says why, and nothing past it is. No rollback. The run
 * ends on Cancel (right-click, ✕) or on picking another kind: any change of
 * `placementKind` resets it.
 *
 * Module state (a discrete click anchor, never Zustand: invariant #2). Runs
 * on a click, never per frame.
 */
import { DeckCornerGraph, deckCornerPathInto } from '../../core/hex/deckCornerGraph.js';
import { DECK_CORNER_TOLERANCE, nearestDeckCornerInto } from '../../core/hex/deckCorners.js';
import type { HexPoint } from '../../core/hex/hex.js';
import { OwnerPlateList } from '../../core/hex/plateSet.js';
import { DECK_FENCE_POST_KIND } from '../../core/structures/deckLinks.js';
import type { PlacementDeck, PlacementRejection } from '../../core/structures/placementRules.js';
import type { StructureKindId } from '../../shared-types/structureKinds.js';
import type { RenderMirror } from '../../core/contracts/IRenderer.js';
import { getGameClient } from '../net/clientSingleton.js';
import { useUIStore } from '../state/store.js';
import { placementChosen, setPlacementHeld } from './placementChosen.js';
import { PlacementGhostVerdict, type GhostPose } from './placementGhostVerdict.js';
import { placeStructureAt } from './structurePlacementClient.js';

/** The run's last corner (where the next click's path starts). */
const anchor = { active: false, x: 0, y: 0 };

/** End the run: the next click starts a fresh one. */
export function endFenceRun(): void {
  anchor.active = false;
}

/** Is a run open (a previous click's corner to continue from)? */
export function fenceRunAnchor(): Readonly<{ active: boolean; x: number; y: number }> {
  return anchor;
}

let subscribed = false;
/** Any change of the placed kind (another pick, Cancel) ends the run. */
function watchKind(): void {
  if (subscribed) return;
  subscribed = true;
  useUIStore.subscribe((s, prev) => {
    if (s.placementKind !== prev.placementKind) endFenceRun();
  });
}

/** Does a Place of `kind` run as a fence run? */
export function isFenceRunKind(kind: string | null, deck: boolean): boolean {
  return deck && kind === DECK_FENCE_POST_KIND;
}

/** What one click does, for {@link planFenceRun}. */
export interface FenceRunPlan {
  /** Corners to send `place_structure` at, flat (x, y), in path order. */
  sends: number[];
  /** The run's corners to draw as pending ghosts (the path up to the stop). */
  drawn: number[];
  /** Where the run now ends (the last corner reached), or none. */
  anchorOk: boolean;
  anchorX: number;
  anchorY: number;
}

/** The world the planner reads: a post on a corner, and the ghost verdict. */
export interface FenceRunWorld {
  hasPost(x: number, y: number): boolean;
  rejection(x: number, y: number): PlacementRejection | null;
}

const graph = new DeckCornerGraph();
const PATH: number[] = [];
const END: HexPoint = { x: 0, y: 0 };

/**
 * Plan one click at (x, y): the path from the open run's corner (if any) to
 * the corner nearest (x, y) over `plates` (flat (i, j) pairs); when no run of
 * plated edges joins them, just that corner (a fresh run). Each corner
 * without a post is sent; the first one `world` would refuse is sent too (the
 * server says why) and ends the plan. Pure over `world`; allocates its
 * result (a click).
 */
export function planFenceRun(
  from: Readonly<{ active: boolean; x: number; y: number }>, x: number, y: number,
  plates: readonly number[], world: FenceRunWorld,
): FenceRunPlan {
  nearestDeckCornerInto(x, y, END);
  let joined = false;
  if (from.active && Math.hypot(from.x - END.x, from.y - END.y) > DECK_CORNER_TOLERANCE) {
    joined = deckCornerPathInto(graph.build(plates), from.x, from.y, END.x, END.y, PATH);
  }
  if (!joined) { PATH.length = 0; PATH.push(END.x, END.y); }
  const plan: FenceRunPlan = { sends: [], drawn: [], anchorOk: false, anchorX: 0, anchorY: 0 };
  // The path's first corner is the open run's own (already a post or sent).
  for (let n = joined ? 2 : 0; n + 1 < PATH.length; n += 2) {
    const cx = PATH[n]!, cy = PATH[n + 1]!;
    if (!world.hasPost(cx, cy)) {
      plan.sends.push(cx, cy);
      if (world.rejection(cx, cy) !== null) break; // refused: the run stops here
    }
    plan.anchorOk = true; plan.anchorX = cx; plan.anchorY = cy;
  }
  if (plan.anchorOk) {
    for (let n = 0; n + 1 < PATH.length; n += 2) {
      plan.drawn.push(PATH[n]!, PATH[n + 1]!);
      if (PATH[n] === plan.anchorX && PATH[n + 1] === plan.anchorY) break;
    }
  }
  return plan;
}

const verdict = new PlacementGhostVerdict();
const pose: GhostPose = { kind: DECK_FENCE_POST_KIND, x: 0, y: 0, angle: 0 };
const plateList = new OwnerPlateList();
const deckCtx: PlacementDeck = { plates: plateList, owner: '' };
const NO_PLATES: number[] = [];
const NO_CORNERS: number[] = [];

/** The live world: posts from the render mirror (and the run's sent ones). */
function mirrorWorld(mirror: RenderMirror): FenceRunWorld {
  const pv = mirror.pendingPlacementPreview;
  plateList.set(pv?.deckOwner ?? '', pv?.deckPlates ?? NO_PLATES);
  deckCtx.owner = pv?.deckOwner ?? '';
  const near = (ax: number, ay: number, bx: number, by: number): boolean =>
    Math.abs(ax - bx) <= DECK_CORNER_TOLERANCE && Math.abs(ay - by) <= DECK_CORNER_TOLERANCE;
  return {
    hasPost(x, y) {
      const sw = mirror.swarm;
      if (mirror.structures && sw) {
        for (const id of mirror.structures.keys()) {
          const e = sw.get(id);
          if (e !== undefined && e.shipKind === DECK_FENCE_POST_KIND && near(e.x, e.y, x, y)) return true;
        }
      }
      const run = pv?.run;
      if (run) for (let n = 0; n + 1 < run.length; n += 2) if (near(run[n]!, run[n + 1]!, x, y)) return true;
      return false;
    },
    rejection(x, y) {
      if (!mirror.swarm) return null;
      pose.x = x; pose.y = y;
      return verdict.check(pose, mirror.structures, mirror.swarm, null, deckCtx);
    },
  };
}

/**
 * Place for a fence run at the chosen point (`commitPlacement` routes a deck
 * room's fence post here). Returns whether anything was sent; with no chosen
 * point yet it returns null (the caller's plain place path runs).
 */
export function commitFenceRun(kind: StructureKindId): boolean | null {
  const cx = placementChosen.worldX, cy = placementChosen.worldY;
  if (cx === null || cy === null) return null;
  if (placementChosen.held) return false; // still on the post just sent
  const client = getGameClient();
  if (!client) return false;
  watchKind();
  const mirror = client.mirror;
  const plan = planFenceRun(anchor, cx, cy, mirror.pendingPlacementPreview?.deckPlates ?? NO_PLATES, mirrorWorld(mirror));
  let sent = false;
  for (let n = 0; n + 1 < plan.sends.length; n += 2) {
    // The first send carries the run's corners for the pending ghost.
    if (placeStructureAt(kind, plan.sends[n]!, plan.sends[n + 1]!, n === 0 ? plan.drawn : NO_CORNERS)) sent = true;
  }
  anchor.active = plan.anchorOk;
  anchor.x = plan.anchorX;
  anchor.y = plan.anchorY;
  if (sent) setPlacementHeld(true);
  return sent;
}
