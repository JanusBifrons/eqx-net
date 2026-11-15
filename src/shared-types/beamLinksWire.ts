/**
 * Beam links on the snapshot (salvage plan PR 11): ONE flat encoding for
 * every emitter → target beam that lasts longer than a shot, in
 * `SnapshotMessage.structureTargets`. Both sides read these helpers (#15).
 *
 * Records, back to back:
 * - structure beam: `[structureEntityId, turretTarget, miningTarget]`
 *   (`STRUCTURE_TARGET_STRIDE`, unchanged: a snapshot with no tractor is
 *   byte-identical to before; see structureStateWire.ts for the slot values);
 * - ship tractor link: `[BEAM_LINK_TRACTOR, emitter, mountId, target,
 *   startTick, endTick]` (`TRACTOR_LINK_STRIDE`). `emitter` / `target` are a
 *   swarm entity's numeric id or a pilot's id string; `mountId` is the
 *   emitter's mount id; the lease covers server ticks [startTick, endTick),
 *   so a client replays the same field the server applied and a late joiner
 *   converges from the snapshot alone (#16).
 *
 * The tag is negative, and a structure record starts with its entity id
 * (≥ 0), so the walker tells them apart by the first element.
 */
import { STRUCTURE_TARGET_STRIDE } from './structureStateWire.js';

export type BeamLinks = Array<number | string>;

/** First element of a tractor record. */
export const BEAM_LINK_TRACTOR = -1;
export const TRACTOR_LINK_STRIDE = 6;

/** Append one tractor record at `at`; returns the new length (#14: writes
 *  into a reused array). */
export function encodeTractorLink(
  out: BeamLinks, at: number, emitter: number | string, mountId: string, target: number | string,
  startTick: number, endTick: number,
): number {
  out[at++] = BEAM_LINK_TRACTOR;
  out[at++] = emitter;
  out[at++] = mountId;
  out[at++] = target;
  out[at++] = startTick;
  out[at++] = endTick;
  return at;
}

/** A reusable visitor (keep one per consumer; no closure per call, #14). */
export interface BeamLinkVisitor {
  structure(structureEntityId: number, turretTarget: number, miningTarget: number): void;
  tractor(emitter: number | string, mountId: string, target: number | string, startTick: number, endTick: number): void;
}

/** Walk a beam-links array in order. A truncated tail record is ignored. */
export function forEachBeamLink(flat: Readonly<BeamLinks>, v: BeamLinkVisitor): void {
  let i = 0;
  while (i < flat.length) {
    if (flat[i] === BEAM_LINK_TRACTOR) {
      if (i + TRACTOR_LINK_STRIDE > flat.length) return;
      v.tractor(flat[i + 1]!, String(flat[i + 2]), flat[i + 3]!, Number(flat[i + 4]), Number(flat[i + 5]));
      i += TRACTOR_LINK_STRIDE;
      continue;
    }
    if (i + STRUCTURE_TARGET_STRIDE > flat.length) return;
    v.structure(Number(flat[i]), Number(flat[i + 1]), Number(flat[i + 2]));
    i += STRUCTURE_TARGET_STRIDE;
  }
}
