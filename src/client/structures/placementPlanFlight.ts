/**
 * Plan then Build: the Build in flight and the server's replies to it. A
 * leaf (store-free, renderer-free) so the room's message handlers
 * (`net/handlers/structurePanelHandlers.ts`) can import it without pulling
 * the renderer's structure-art graph into the boot order (that graph has an
 * import cycle; entering it from a handler threw a TDZ error at boot).
 * `placementCancel.ts` sends the Build and re-exports these.
 */
import { getGameClient } from '../net/clientSingleton.js';
import { PLACE_STRUCTURES_BATCH_ID_MAX } from '../../shared-types/messages.js';
import { PENDING_PLACEMENT_TIMEOUT_MS, pendingPlacementResolved, type PendingPlacement } from './structurePlacementClient.js';
import { clearPlacementPlan, clearPlanRefused, getPlacementPlanCount, markPlannedRefused } from './placementPlan.js';

/** A Build in flight: nothing is added or re-sent until the server's reply
 *  for its `batchId` (placed or refused) or a timeout. `sentAtMs` < 0 until
 *  the first frame stamps it. `batchId` counts Builds (wraps at the wire max).
 *  `baseline` = the mirror's structure count at the send. */
const flight = { active: false, batchId: 0, sentAtMs: -1, baseline: 0 };

/**
 * The placed plan landing: after `place_structures_placed` the planned ghosts
 * stay drawn (and the plan stays locked) until the buildings are in the
 * mirror and renderable, the same sent/pending rule as a single Place
 * (`pendingPlacementResolved`: `sent` more structures than `baselineStructureCount`,
 * or the timeout). `sentAtMs` < 0 until the first frame stamps it.
 */
const landing: PendingPlacement & { active: boolean } = {
  kind: 'connector', x: 0, y: 0, sentAtMs: -1, baselineStructureCount: 0, sent: 0, active: false,
};

/** Is a Build waiting on the server (the Build button stays disabled)? */
export function isPlanBuildInFlight(): boolean {
  return flight.active;
}

/** Drop the plan and any Build in flight. */
export function dropPlacementPlan(): void {
  flight.active = false;
  landing.active = false;
  clearPlacementPlan();
}

/** The `batchId` the next Build sends (wraps at the wire max). */
export function nextPlanBatchId(): number {
  return flight.batchId >= PLACE_STRUCTURES_BATCH_ID_MAX ? 0 : flight.batchId + 1;
}

/** A Build was sent as `batchId` with `baseline` structures in the mirror. */
export function notePlanSent(batchId: number, baseline: number): void {
  flight.active = true;
  flight.batchId = batchId;
  flight.sentAtMs = -1;
  flight.baseline = baseline;
}

/** Is every structure in the mirror drawable (in the swarm)? Only while a plan lands. */
function allStructuresRenderable(mirror: { structures?: ReadonlyMap<number, unknown> | null; swarm?: { has(id: number): boolean } | null }): boolean {
  const structs = mirror.structures;
  if (!structs || structs.size === 0) return true;
  const sw = mirror.swarm;
  if (!sw) return false;
  for (const id of structs.keys()) if (!sw.has(id)) return false;
  return true;
}

/** Drop the landing plan once its buildings are drawn (or it timed out;
 *  `nowMs` = `landing.sentAtMs` before the first frame stamps it). */
function stepLanding(nowMs: number): void {
  const mirror = getGameClient()?.mirror;
  const count = mirror?.structures?.size ?? 0;
  if (pendingPlacementResolved(landing, nowMs, count, mirror ? allStructuresRenderable(mirror) : true)) dropPlacementPlan();
}

/** Is this reply for the Build in flight? A reply to an older Build (one
 *  that timed out, or from before a ✕) is ignored. */
function replyIsCurrent(batchId: number): boolean {
  return flight.active && !landing.active && batchId === flight.batchId;
}

/** `place_structures_refused` for the Build in flight: nothing was placed.
 *  Keep the plan and mark each refused index red; Build may be pressed again. */
export function onPlaceStructuresRefused(batchId: number, refused: readonly { index: number }[]): void {
  if (!replyIsCurrent(batchId)) return;
  flight.active = false;
  clearPlanRefused();
  for (let k = 0; k < refused.length; k++) markPlannedRefused(refused[k]!.index);
}

/** `place_structures_placed` for the Build in flight: every planned
 *  building was placed. The plan stays drawn (locked) until they are in the
 *  mirror and drawn (`landing`), then it is cleared. */
export function onPlaceStructuresPlaced(batchId: number): void {
  if (!replyIsCurrent(batchId)) return;
  landing.active = true;
  landing.baselineStructureCount = flight.baseline;
  landing.sent = getPlacementPlanCount();
  landing.sentAtMs = -1;
  stepLanding(landing.sentAtMs);
}

/**
 * Per frame (gameRafLoop): time out a Build in flight. Past
 * `PENDING_PLACEMENT_TIMEOUT_MS` with no reply for its batchId, the plan
 * stays and Build may be pressed again (a late reply is then ignored). A
 * placed plan drops once its buildings are drawn (`stepLanding`). One
 * boolean when idle.
 */
export function stepPlacementPlan(nowMs: number): void {
  if (!flight.active) return;
  if (landing.active) {
    if (landing.sentAtMs < 0) landing.sentAtMs = nowMs;
    stepLanding(nowMs);
    return;
  }
  if (flight.sentAtMs < 0) flight.sentAtMs = nowMs;
  else if (nowMs - flight.sentAtMs >= PENDING_PLACEMENT_TIMEOUT_MS) flight.active = false;
}
