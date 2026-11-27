/**
 * Edge placement slice 2 — the FENCE RUN (plan `.resume/edge-placement-plan.md`).
 * With the fence post (`shield_pylon`) picked on a deck room, each Place on a
 * hex corner puts a post there if it has none (an existing post is reused),
 * and fills a post on every corner along the shortest run of plated hex
 * edges from the previous click's corner (`core/hex/deckCornerGraph.ts`,
 * searched by the one `GraphSearch`). Inner edges count, not just the rim.
 *
 * Plan then Build: a click PLANS each missing corner (and a gate) as one
 * ordinary item of the planned list (`placementPlan.ts`, `planStructureAt`),
 * never sending it; Build sends the run with every other planned building as
 * one `place_structures`, checked all or nothing by the core
 * `BatchPlacementChecker` on both sides. A planned post counts as a post for
 * the next click's path, and every planned building counts as placed for the
 * run's verdict (the batch check's rule, `PlacementGhostVerdict.addFootprint`).
 * Once placed, the server's `autoConnectStructure` links two posts on one
 * seam (`DECK_LINK_SEAM_FENCE`), so the beams appear by themselves. Cost is
 * the same as placing each post by hand.
 *
 * A corner the ghost's own rule (`PlacementGhostVerdict`, the server's
 * `placementRejection`, plus the plan) would refuse ends the run there: it
 * is not planned, nor anything past it (the hover shows it red). The run
 * ends on Cancel (right-click, ✕) or on picking another kind: any change of
 * `placementKind` resets it.
 *
 * Module state (a discrete click anchor, never Zustand: invariant #2). Runs
 * on a click, never per frame.
 */
import { DeckCornerGraph, deckCornerPathInto } from '../../core/hex/deckCornerGraph.js';
import { DECK_CORNER_TOLERANCE, nearestDeckCornerInto, nearestDeckEdgeInto } from '../../core/hex/deckCorners.js';
import type { HexPoint } from '../../core/hex/hex.js';
import { DECK_HEX_SIZE } from '../../core/hex/plates.js';
import { OwnerPlateList } from '../../core/hex/plateSet.js';
import { DECK_FENCE_GATE_KIND, DECK_FENCE_POST_KIND } from '../../core/structures/deckLinks.js';
import type { GridObstacle } from '../../core/structures/Grid.js';
import { snapPlacementToDeck } from '../../core/structures/deckPlacement.js';
import type { DeckSnap } from '../../core/hex/deckSnap.js';
import type { PlacementDeck, PlacementRejection } from '../../core/structures/placementRules.js';
import type { StructureKindId } from '../../shared-types/structureKinds.js';
import type { RenderMirror } from '../../core/contracts/IRenderer.js';
import { getGameClient } from '../net/clientSingleton.js';
import { useUIStore } from '../state/store.js';
import { placementChosen, setPlacementHeld } from './placementChosen.js';
import { PlacementGhostVerdict, type GhostPose } from './placementGhostVerdict.js';
import { asteroidObstaclesFromSwarm, RockObstacleShapes } from './mirrorToGridNode.js';
import { holdOnPlanned, planStructureAt } from './structurePlacementClient.js';
import { plannedPlacements } from './placementPlan.js';

type MirrorPreview = NonNullable<RenderMirror['pendingPlacementPreview']>;

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
    // Edge feel P3: the Gate toggle (post <-> gate) keeps the run open.
    if (s.placementKind !== prev.placementKind
      && !(isFenceEdgeKind(s.placementKind) && isFenceEdgeKind(prev.placementKind))) endFenceRun();
  });
}

const isFenceEdgeKind = (k: string | null): boolean => k === DECK_FENCE_POST_KIND || k === DECK_FENCE_GATE_KIND;

/** Does a Place of `kind` run as a fence run? A post, or (edge feel P3) a
 *  gate: its seam's two posts are filled first, as the run's own fill. */
export function isFenceRunKind(kind: string | null, deck: boolean): boolean {
  return deck && isFenceEdgeKind(kind);
}

/** What one click does, for {@link planFenceRun}. */
export interface FenceRunPlan {
  /** Corners to send `place_structure` at, flat (x, y), in path order. */
  sends: number[];
  /** The run's corners to draw as pending ghosts (the path up to the stop). */
  drawn: number[];
  /** The path's corners up to and including where the plan stopped (the
   *  refused corner, if any): what the hover preview draws. */
  reach: number[];
  /** The last `sends` corner is one `world` refuses (the run stops there). */
  refused: boolean;
  /** Where the run now ends (the last corner reached), or none. */
  anchorOk: boolean;
  anchorX: number;
  anchorY: number;
  /** Edge feel P3: a gate goes at (gateX, gateY) after `sends` (the seam's posts). */
  gate: boolean;
  gateX: number;
  gateY: number;
}

/** The world the planner reads: a post on a corner, and the ghost verdict. */
export interface FenceRunWorld {
  hasPost(x: number, y: number): boolean;
  rejection(x: number, y: number): PlacementRejection | null;
  /** The ghost verdict for the GATE itself at seam midpoint (x, y), turned
   *  `rotDeg`; omitted = clear. A seam whose gate already stands is refused. */
  gateRejection?(x: number, y: number, rotDeg: number): PlacementRejection | null;
}

const graph = new DeckCornerGraph();
const PATH: number[] = [];
const END: HexPoint = { x: 0, y: 0 };

/** An empty plan to fill with {@link planFenceRunInto}. */
export function newFenceRunPlan(): FenceRunPlan {
  return { sends: [], drawn: [], reach: [], refused: false, anchorOk: false, anchorX: 0, anchorY: 0, gate: false, gateX: 0, gateY: 0 };
}

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
  return planFenceRunInto(newFenceRunPlan(), from, x, y, plates, world);
}

/** {@link planFenceRun} into `out` (its arrays reused): the hover preview's
 *  allocation-free form (#14). Returns `out`. */
export function planFenceRunInto(
  out: FenceRunPlan,
  from: Readonly<{ active: boolean; x: number; y: number }>, x: number, y: number,
  plates: readonly number[], world: FenceRunWorld,
): FenceRunPlan {
  nearestDeckCornerInto(x, y, END);
  let joined = false;
  if (from.active && Math.hypot(from.x - END.x, from.y - END.y) > DECK_CORNER_TOLERANCE) {
    joined = deckCornerPathInto(graph.build(plates), from.x, from.y, END.x, END.y, PATH);
  }
  if (!joined) { PATH.length = 0; PATH.push(END.x, END.y); }
  out.sends.length = 0; out.drawn.length = 0; out.reach.length = 0;
  out.refused = false; out.anchorOk = false; out.anchorX = 0; out.anchorY = 0;
  out.gate = false; out.gateX = 0; out.gateY = 0;
  // The path's first corner is the open run's own (already a post or sent).
  if (joined) out.reach.push(PATH[0]!, PATH[1]!);
  for (let n = joined ? 2 : 0; n + 1 < PATH.length; n += 2) {
    const cx = PATH[n]!, cy = PATH[n + 1]!;
    out.reach.push(cx, cy);
    if (!world.hasPost(cx, cy)) {
      out.sends.push(cx, cy);
      if (world.rejection(cx, cy) !== null) { out.refused = true; break; } // refused: the run stops here
    }
    out.anchorOk = true; out.anchorX = cx; out.anchorY = cy;
  }
  if (out.anchorOk) {
    for (let n = 0; n + 1 < PATH.length; n += 2) {
      out.drawn.push(PATH[n]!, PATH[n + 1]!);
      if (PATH[n] === out.anchorX && PATH[n + 1] === out.anchorY) break;
    }
  }
  return out;
}

const MID: HexPoint = { x: 0, y: 0 };
const GATE_SNAP: DeckSnap = { x: 0, y: 0, q: 0, r: 0, rhombus: -1, rot: -1, slot: 'hex' };
const NEAR_END: HexPoint = { x: 0, y: 0 };
const FAR_END: HexPoint = { x: 0, y: 0 };

/**
 * Edge feel P3: plan a GATE click at (x, y). The gate sits on the nearest
 * seam's midpoint; the run fills posts up to the seam's nearer end (nearer
 * the open run's corner; with no run, either), then the far end's post, then
 * the gate, and the run continues from the far end. A refused post stops the
 * plan as {@link planFenceRunInto} does (no gate). Same world, same arrays
 * (allocation-free). Returns `out`.
 */
export function planGateRunInto(
  out: FenceRunPlan,
  from: Readonly<{ active: boolean; x: number; y: number }>, x: number, y: number,
  plates: readonly number[], world: FenceRunWorld,
): FenceRunPlan {
  const deg = nearestDeckEdgeInto(x, y, MID);
  // The gate's own spot first: a red gate ghost sends nothing, no posts either
  // (owner retest 2026-11-27: a second tap on a gated seam was server-refused).
  if (world.gateRejection !== undefined) {
    snapPlacementToDeck(DECK_FENCE_GATE_KIND, MID.x, MID.y, GATE_SNAP);
    if (world.gateRejection(GATE_SNAP.x, GATE_SNAP.y, GATE_SNAP.rot) !== null) {
      out.sends.length = 0; out.drawn.length = 0; out.reach.length = 0;
      out.refused = true; out.anchorOk = false; out.anchorX = 0; out.anchorY = 0;
      out.gate = false; out.gateX = 0; out.gateY = 0;
      return out;
    }
  }
  const r = (deg * Math.PI) / 180, hx = (Math.cos(r) * DECK_HEX_SIZE) / 2, hy = (Math.sin(r) * DECK_HEX_SIZE) / 2;
  nearestDeckCornerInto(MID.x + hx, MID.y + hy, NEAR_END);
  nearestDeckCornerInto(MID.x - hx, MID.y - hy, FAR_END);
  if (from.active && Math.hypot(FAR_END.x - from.x, FAR_END.y - from.y) < Math.hypot(NEAR_END.x - from.x, NEAR_END.y - from.y)) {
    const tx = NEAR_END.x, ty = NEAR_END.y;
    NEAR_END.x = FAR_END.x; NEAR_END.y = FAR_END.y; FAR_END.x = tx; FAR_END.y = ty;
  }
  planFenceRunInto(out, from, NEAR_END.x, NEAR_END.y, plates, world);
  if (out.refused || !out.anchorOk || !near(out.anchorX, out.anchorY, NEAR_END.x, NEAR_END.y)) return out;
  const fx = FAR_END.x, fy = FAR_END.y;
  out.reach.push(fx, fy);
  if (!world.hasPost(fx, fy)) {
    out.sends.push(fx, fy);
    if (world.rejection(fx, fy) !== null) { out.refused = true; return out; }
  }
  if (out.drawn.length > 0) out.drawn.push(NaN, NaN);
  out.drawn.push(fx, fy);
  out.anchorX = fx; out.anchorY = fy;
  out.gate = true; out.gateX = MID.x; out.gateY = MID.y;
  return out;
}

const verdict = new PlacementGhostVerdict();
const pose: GhostPose = { kind: DECK_FENCE_POST_KIND, x: 0, y: 0, angle: 0 };
const gatePose: GhostPose = { kind: DECK_FENCE_GATE_KIND, x: 0, y: 0, angle: 0 };
const plateList = new OwnerPlateList();
const deckCtx: PlacementDeck = { plates: plateList, owner: '' };
const NO_PLATES: number[] = [];

const near = (ax: number, ay: number, bx: number, by: number): boolean =>
  Math.abs(ax - bx) <= DECK_CORNER_TOLERANCE && Math.abs(ay - by) <= DECK_CORNER_TOLERANCE;

/** The live world (module scope, no per-call closures): posts from the
 *  render mirror, the run's sent ones (`preview.run`, never the hover's
 *  `runHover`) and the PLANNED ones (`placementPlan.ts`), and the ghost
 *  verdict with `obstacles` (rocks) and the planned buildings as placed. */
const liveWorld = {
  mirror: null as RenderMirror | null,
  preview: null as MirrorPreview | null,
  obstacles: null as readonly GridObstacle[] | null,
  hasPost(x: number, y: number): boolean {
    const m = liveWorld.mirror!;
    const sw = m.swarm;
    if (m.structures && sw) {
      for (const id of m.structures.keys()) {
        const e = sw.get(id);
        if (e !== undefined && e.shipKind === DECK_FENCE_POST_KIND && near(e.x, e.y, x, y)) return true;
      }
    }
    const run = liveWorld.preview?.run;
    if (run) for (let n = 0; n + 1 < run.length; n += 2) if (near(run[n]!, run[n + 1]!, x, y)) return true;
    const plan = plannedPlacements();
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i]!;
      if (p.kind === DECK_FENCE_POST_KIND && near(p.x, p.y, x, y)) return true;
    }
    return false;
  },
  rejection(x: number, y: number): PlacementRejection | null {
    const m = liveWorld.mirror!;
    if (!m.swarm) return null;
    pose.x = x; pose.y = y;
    return verdict.check(pose, m.structures, m.swarm, liveWorld.obstacles, deckCtx);
  },
  gateRejection(x: number, y: number, rotDeg: number): PlacementRejection | null {
    const m = liveWorld.mirror!;
    if (!m.swarm) return null;
    gatePose.x = x; gatePose.y = y; gatePose.angle = (rotDeg * Math.PI) / 180;
    return verdict.check(gatePose, m.structures, m.swarm, liveWorld.obstacles, deckCtx);
  },
};

/** The rocks the run plan checks, from the mirror's swarm (the main thread
 *  has no renderer rock layer): each asteroid on the wire with its real shape
 *  (`shapeSeed`); a field rock there falls back to its box (never a false
 *  green). Dormant field rocks off the wire are the renderer's only, so its
 *  red can still stop a run the plan let through. Pooled scratch (#14). */
const runRocks: GridObstacle[] = [];
const runRockShapes = new RockObstacleShapes();
export function fenceRunRocks(mirror: RenderMirror): readonly GridObstacle[] | null {
  return mirror.swarm ? asteroidObstaclesFromSwarm(mirror.swarm, runRocks, runRockShapes) : null;
}

/** Point the live world at `mirror` and `preview` (default: the mirror's; its deck and sent run), the planned list and `obstacles`
 *  (rocks, {@link fenceRunRocks}; null = none). Allocation-free;
 *  the returned world is shared module state. */
export function mirrorFenceWorld(
  mirror: RenderMirror, obstacles: readonly GridObstacle[] | null,
  preview: MirrorPreview | null = mirror.pendingPlacementPreview ?? null,
): FenceRunWorld {
  const pv = preview;
  liveWorld.preview = preview;
  plateList.set(pv?.deckOwner ?? '', pv?.deckPlates ?? NO_PLATES);
  deckCtx.owner = pv?.deckOwner ?? '';
  liveWorld.mirror = mirror;
  liveWorld.obstacles = obstacles;
  // Plan then Build: every planned building counts as placed for the run's
  // verdict, as the core batch check judges a later item (pooled, #14).
  verdict.clearAdded();
  const plan = plannedPlacements();
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i]!;
    verdict.addFootprint(p.kind, p.x, p.y, p.rot, p.mirror);
  }
  return liveWorld;
}

/** Each planned post goes at the deck snap's exact seam point (the same
 *  rounding the live ghost's chosen point gets), so the planned item matches
 *  the ghost left on that spot and the plan hold (`isHeldOnPlanned`) covers
 *  it: dim, no red verdict, no second Place. Raw lattice corners differ in the
 *  last bits. */
const SEND_SNAP: DeckSnap = { x: 0, y: 0, q: 0, r: 0, rhombus: -1, rot: -1, slot: 'hex' };

/**
 * Place for a fence run at the chosen point (`commitPlacement` routes a deck
 * room's fence post and gate here): PLANS the run's missing posts in path
 * order, then the gate last (the server cuts the seam's post-post link as it
 * lands); a refused corner (the plan's last send when `refused`) and
 * anything past it are not planned. Sends nothing (Build does). Returns
 * whether anything was planned; with no chosen point yet it returns null (the
 * caller's plain place path runs).
 */
export function commitFenceRun(kind: StructureKindId): boolean | null {
  const cx = placementChosen.worldX, cy = placementChosen.worldY;
  if (cx === null || cy === null) return null;
  if (placementChosen.held) return false; // still on the post just planned
  const client = getGameClient();
  if (!client) return false;
  watchKind();
  const mirror = client.mirror;
  const plates = mirror.pendingPlacementPreview?.deckPlates ?? NO_PLATES, world = mirrorFenceWorld(mirror, fenceRunRocks(mirror));
  const plan = kind === DECK_FENCE_GATE_KIND
    ? planGateRunInto(newFenceRunPlan(), anchor, cx, cy, plates, world)
    : planFenceRun(anchor, cx, cy, plates, world);
  // The refused corner is the last send: never planned (the ghost shows it red).
  const posts = plan.refused ? plan.sends.length - 2 : plan.sends.length;
  let planned = false, full = false, lastX = 0, lastY = 0;
  for (let n = 0; n + 1 < posts; n += 2) {
    const at = snapPlacementToDeck(DECK_FENCE_POST_KIND, plan.sends[n]!, plan.sends[n + 1]!, SEND_SNAP);
    if (!planStructureAt(DECK_FENCE_POST_KIND, at.x, at.y)) { full = true; break; } // the plan is full
    planned = true; lastX = plan.sends[n]!; lastY = plan.sends[n + 1]!;
  }
  if (plan.gate && !full) {
    const g = snapPlacementToDeck(DECK_FENCE_GATE_KIND, plan.gateX, plan.gateY, SEND_SNAP);
    if (planStructureAt(DECK_FENCE_GATE_KIND, g.x, g.y)) planned = true; else full = true;
  }
  if (!full) {
    anchor.active = plan.anchorOk; anchor.x = plan.anchorX; anchor.y = plan.anchorY;
  } else if (planned) {
    // The plan filled up mid-run: the run goes on from the last planned post.
    anchor.active = true; anchor.x = lastX; anchor.y = lastY;
  }
  if (planned) { holdOnPlanned(kind, cx, cy); setPlacementHeld(true); }
  return planned;
}
