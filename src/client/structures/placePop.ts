/**
 * Edge feel P4, the place pop: when a structure the player just placed lands
 * (it shows in the room's structures AND has a swarm pose, the same gate the
 * dim pending ghost clears on), push one `place-pop` effect trigger at it.
 * A fence run's posts land one by one, so each post pops as it appears.
 *
 * Matching: an OWN structure new since the pending record began, within
 * `POP_MATCH_R` × its kind's footprint radius of the sent point or a run
 * corner (the server snaps to the same deck slot the ghost showed).
 * Someone else's build, or one of ours far from the click, does not pop.
 *
 * Called from the placement-preview pass (`localShipPass` / `worldPasses`)
 * BEFORE a resolved record is dropped, so the last post of a run still pops.
 * The structures walk runs only when the slice size changed or a landed id
 * waits for its swarm pose; the seen-set grows only when something lands
 * (#14: nothing per frame once idle).
 */
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { PendingPlacement } from './structurePlacementClient.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';

/** How near the sent point a landed structure must be, × its footprint radius. */
export const POP_MATCH_R = 0.75;

export class PlacePopTracker {
  private readonly seen = new Set<number>();
  private armed: PendingPlacement | null = null;
  private lastSize = -1;
  private waiting = false;

  /** Per frame. `pending` = the live record (null when none). */
  update(pending: PendingPlacement | null, mirror: RenderMirror): void {
    const structs = mirror.structures;
    if (pending === null || !structs) { this.disarm(); return; }
    if (this.armed !== pending) {
      // A new record (or a run record replaced): everything already here is old.
      if (this.armed === null) { this.seen.clear(); for (const id of structs.keys()) this.seen.add(id); }
      this.armed = pending;
    }
    if (structs.size === this.lastSize && !this.waiting) return;
    this.lastSize = structs.size;
    this.waiting = false;
    const sw = mirror.swarm;
    const local = mirror.localPlayerId;
    const fp = getStructureKind(pending.kind).footprint;
    const r = 0.5 * Math.hypot(fp.w, fp.h);
    const tol2 = (r * POP_MATCH_R) ** 2;
    for (const [id, s] of structs) {
      if (this.seen.has(id)) continue;
      if (local === null || s.owner !== local) { this.seen.add(id); continue; }
      const pose = sw?.get(id);
      if (!pose) { this.waiting = true; continue; } // pops when drawn
      this.seen.add(id);
      if (!nearSent(pending, pose.x, pose.y, tol2)) continue;
      mirror.pendingEffectTriggers?.push({ kind: 'place-pop', worldX: pose.x, worldY: pose.y, radius: r });
    }
  }

  private disarm(): void {
    if (this.armed === null) return;
    this.armed = null; this.lastSize = -1; this.waiting = false; this.seen.clear();
  }
}

/** True when (x, y) is within `tol2` (squared) of the sent point or a run corner. */
export function nearSent(p: PendingPlacement, x: number, y: number, tol2: number): boolean {
  let dx = x - p.x, dy = y - p.y;
  if (dx * dx + dy * dy <= tol2) return true;
  const run = p.run;
  if (!run) return false;
  for (let i = 0; i + 1 < run.length; i += 2) {
    const cx = run[i]!, cy = run[i + 1]!;
    if (cx !== cx) continue; // NaN break between clicks
    dx = x - cx; dy = y - cy;
    if (dx * dx + dy * dy <= tol2) return true;
  }
  return false;
}

/** The one tracker (the placement-preview pass runs on the main thread only). */
export const placePop = new PlacePopTracker();
