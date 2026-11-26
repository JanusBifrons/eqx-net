/**
 * Edge placement slice 2 (fence run): the dim "sent, awaiting the server"
 * record (`PendingPlacement`, Issue 7) extended to a RUN of places. A fence
 * run sends one `place_structure` per missing corner in one click; the
 * record counts them (`sent`) against its structure-count baseline and keeps
 * the run's corners (`run`) for the preview, so the whole run shows as post
 * and beam ghosts until every post landed (or the timeout). A plain place
 * (no run) replaces the record exactly as before.
 */
import type { StructureKindId } from '../../shared-types/structureKinds.js';
import { PENDING_PLACEMENT_TIMEOUT_MS, type PendingPlacement, type PlacementPreview } from './structurePlacementClient.js';

/**
 * The pending record after one more `place_structure` was sent. `run` null =
 * a plain place: a fresh record (the old behaviour). `run` given = a fence
 * run place: it joins `prev` while `prev` is a run of the same kind that has
 * neither landed nor timed out (`sent` + 1, `run`'s corners appended after a
 * NaN break when non-empty), else it starts a new run record. Allocates (a
 * send, never per frame).
 */
export function pendingAfterSend(
  prev: PendingPlacement | null,
  kind: StructureKindId, x: number, y: number, rot: number, mirror: boolean,
  nowMs: number, structureCount: number, run: readonly number[] | null,
): PendingPlacement {
  if (run === null) return { kind, x, y, rot, mirror, sentAtMs: nowMs, baselineStructureCount: structureCount };
  const sent = prev?.sent ?? 1;
  if (prev !== null && prev.run !== undefined && prev.kind === kind
    && nowMs - prev.sentAtMs < PENDING_PLACEMENT_TIMEOUT_MS
    && structureCount < prev.baselineStructureCount + sent) {
    prev.x = x; prev.y = y; prev.rot = rot; prev.mirror = mirror;
    prev.sentAtMs = nowMs;
    prev.sent = sent + 1;
    if (run.length > 0) {
      if (prev.run.length > 0) prev.run.push(NaN, NaN);
      for (let n = 0; n < run.length; n++) prev.run.push(run[n]!);
    }
    return prev;
  }
  const corners: number[] = [];
  for (let n = 0; n < run.length; n++) corners.push(run[n]!);
  return { kind, x, y, rot, mirror, sentAtMs: nowMs, baselineStructureCount: structureCount, sent: 1, run: corners };
}

/** Copy `pending`'s run corners onto the preview (`out.run`, reused, #14);
 *  empty when there is no live run. */
export function writePreviewRun(out: PlacementPreview, pending: PendingPlacement | null): void {
  const src = pending?.run;
  if (src === undefined || src.length === 0) {
    if (out.run !== undefined) out.run.length = 0;
    return;
  }
  const dst = out.run ?? (out.run = []);
  dst.length = 0;
  for (let n = 0; n < src.length; n++) dst.push(src[n]!);
}
