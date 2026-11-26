/**
 * Edge feel P1 — the fence run's HOVER preview. While a run is open (a
 * previous click's corner) and the fence post is picked on a deck room, the
 * hovered corner (the pointer, or the parked/tapped point on touch: the same
 * `placementChosen` point the click uses) runs the click's own planner
 * (`planFenceRunInto`, same path search, same world) and the corners it would
 * reach go on the preview as `runHover` (+ `runHoverMark`), never in `run`
 * (the click reads `run` as the posts already sent).
 *
 * Called once per frame from both mirror passes (`localShipPass`,
 * `worldPasses`) right after `writePreviewDeck`. Allocation-free (#14): the
 * plan and the preview arrays are reused, and the plan re-runs only when its
 * key changes (hovered corner, run anchor, structure count, sent run length,
 * deck plates).
 */
import { nearestDeckCornerInto } from '../../core/hex/deckCorners.js';
import type { HexPoint } from '../../core/hex/hex.js';
import type { RenderMirror } from '../../core/contracts/IRenderer.js';
import { fenceRunAnchor, isFenceRunKind, mirrorFenceWorld, newFenceRunPlan, planFenceRunInto } from './fenceRun.js';
import type { PlacementPreview } from './structurePlacementClient.js';

const plan = newFenceRunPlan();
const CORNER: HexPoint = { x: 0, y: 0 };

/** The last plan's inputs; `valid` false = recompute. */
const key = {
  valid: false, cx: 0, cy: 0, active: false, ax: 0, ay: 0,
  structures: 0, run: 0, owner: '', plates: 0, plateSum: 0,
};

/** A cheap order-sensitive sum of the plate list (alloc-free). */
function plateChecksum(plates: readonly number[] | undefined): number {
  if (plates === undefined) return 0;
  let h = 0;
  for (let n = 0; n < plates.length; n++) h = (h * 31 + plates[n]! + 1) % 1000000007;
  return h;
}

function clear(out: PlacementPreview): void {
  if (out.runHover !== undefined) out.runHover.length = 0;
  if (out.runHoverMark !== undefined) out.runHoverMark.length = 0;
  key.valid = false;
}

/**
 * Write the hover run onto `out` (the preview scratch), or empty it. `active`
 * = this frame's preview is the live positioning ghost (not the pending one);
 * `chosenX/Y` the hovered point. Returns whether the plan was recomputed (a
 * probe for the key test).
 */
export function writePreviewHoverRun(
  out: PlacementPreview, mirror: RenderMirror, active: boolean,
  chosenX: number | null, chosenY: number | null,
): boolean {
  const anchor = fenceRunAnchor();
  if (!active || out.held === true || chosenX === null || chosenY === null || !anchor.active
    || !isFenceRunKind(out.kind, out.deck === true)) {
    clear(out);
    return false;
  }
  nearestDeckCornerInto(chosenX, chosenY, CORNER);
  const structures = mirror.structures?.size ?? 0;
  const run = out.run?.length ?? 0;
  const owner = out.deckOwner ?? '';
  const plates = out.deckPlates?.length ?? 0;
  const plateSum = plateChecksum(out.deckPlates);
  if (key.valid && key.cx === CORNER.x && key.cy === CORNER.y && key.active === anchor.active
    && key.ax === anchor.x && key.ay === anchor.y && key.structures === structures && key.run === run
    && key.owner === owner && key.plates === plates && key.plateSum === plateSum) {
    return false;
  }
  key.valid = true; key.cx = CORNER.x; key.cy = CORNER.y; key.active = anchor.active;
  key.ax = anchor.x; key.ay = anchor.y; key.structures = structures; key.run = run;
  key.owner = owner; key.plates = plates; key.plateSum = plateSum;

  // Rocks: the click has no rock list either (the renderer adds them to its red).
  planFenceRunInto(plan, anchor, chosenX, chosenY, out.deckPlates ?? EMPTY, mirrorFenceWorld(mirror, null, out));
  const hover = out.runHover ?? (out.runHover = []);
  const mark = out.runHoverMark ?? (out.runHoverMark = []);
  hover.length = 0; mark.length = 0;
  const reach = plan.reach, sends = plan.sends;
  let s = 0;
  for (let n = 0; n + 1 < reach.length; n += 2) {
    const x = reach[n]!, y = reach[n + 1]!;
    hover.push(x, y);
    if (s + 1 < sends.length && sends[s] === x && sends[s + 1] === y) {
      s += 2;
      mark.push(plan.refused && s === sends.length ? 2 : 1);
    } else {
      mark.push(0);
    }
  }
  return true;
}

const EMPTY: number[] = [];

/** Tests: forget the cached plan. */
export function resetFenceRunHover(): void {
  key.valid = false;
}
