/**
 * Start a rig clip on a structure (structure-restyle 2d, plan §5).
 *
 * The server owns rig playback: it records the deterministic clip record
 * `{clipId, startTick, target?}` on the structure (`StructureRecord.rigClip`)
 * and tells the physics worker (`RIG_CLIP` → `World.setRigClip`), which moves
 * the rig's solid parts from that record every tick (`World.stepRigs`).
 * Clients reproduce the same pose from the same record, which rides the
 * structure's room-state row (`writeRigClipRow`, `structureStateWire.ts`;
 * late-join safe, #16). The target is float32-rounded at the source, so the
 * server worker and every client's predWorld pose from the same bits.
 *
 * Entry point: `SectorRoom.startStructureRigClip` (tests, a sceneScript).
 */
import { createRigPose, evaluateRig } from '../../core/articulation/evaluate.js';
import { twoBoneIkSolve } from '../../core/articulation/ikAdapter.js';
import { rigClipIndex } from '../../core/articulation/rig.js';
import { rigForStructureKind } from '../../core/articulation/rigCatalogue.js';
import { encodeRigClip, STRUCTURE_DEFAULTS as SD } from '../../shared-types/structureStateWire.js';
import type { StructureState } from '../rooms/schema/SectorState.js';
import type { StructureRecord } from './StructureRegistry.js';

/** The worker command this posts (a `WorkerCmd` variant). */
export interface RigClipCmd {
  type: 'RIG_CLIP';
  id: string;
  clipId: string | null;
  startTick: number;
  targetX?: number;
  targetY?: number;
}

/**
 * Start clip `clipId` on `rec` at game tick `startTick` (null clears it: the
 * rig rests), with an optional target in the structure's frame. Returns false
 * (and changes nothing) when the kind has no rig or the rig has no such clip.
 */
export function startStructureRigClip(
  rec: StructureRecord,
  clipId: string | null,
  startTick: number,
  post: (cmd: RigClipCmd) => void,
  target?: { readonly x: number; readonly y: number },
): boolean {
  const rig = rigForStructureKind(rec.kind);
  if (!rig) return false;
  if (clipId !== null && rigClipIndex(rig, clipId) < 0) return false;
  if (clipId === null) {
    rec.rigClip = null;
    post({ type: 'RIG_CLIP', id: rec.id, clipId: null, startTick });
    return true;
  }
  // float32 like the wire (`rigTx` / `rigTy`), so every side poses the same.
  const tx = target ? Math.fround(target.x) : 0;
  const ty = target ? Math.fround(target.y) : 0;
  rec.rigClip = target
    ? { clipId, startTick, target: { x: tx, y: ty } }
    : { clipId, startTick };
  post(target
    ? { type: 'RIG_CLIP', id: rec.id, clipId, startTick, targetX: tx, targetY: ty }
    : { type: 'RIG_CLIP', id: rec.id, clipId, startTick });
  return true;
}

/**
 * Mirror `rec.rigClip` into its room-state row (assigned only on change, A2).
 * A cleared clip writes `rigClip = 0` only; the start / target fields keep
 * their last value (the client ignores them with no clip).
 */
export function writeRigClipRow(rec: StructureRecord, st: StructureState): void {
  const p = rec.rigClip ?? null;
  const rig = p !== null ? rigForStructureKind(rec.kind) : null;
  const code = p !== null && rig !== null ? encodeRigClip(rigClipIndex(rig, p.clipId), p.target !== undefined) : 0;
  if ((st.rigClip ?? SD.rigClip) !== code) st.rigClip = code;
  if (code === 0 || p === null) return;
  if ((st.rigStart ?? SD.rigStart) !== p.startTick) st.rigStart = p.startTick;
  if (p.target !== undefined) {
    if ((st.rigTx ?? SD.rigTx) !== p.target.x) st.rigTx = p.target.x;
    if ((st.rigTy ?? SD.rigTy) !== p.target.y) st.rigTy = p.target.y;
  }
}

/** World point (wx, wy) in `rec`'s host frame (its centre, turned by `rot`
 *  degrees CCW): what a targeted clip takes. Scene / test entry points only. */
export function worldToRigHost(rec: StructureRecord, wx: number, wy: number): { x: number; y: number } {
  const a = ((rec.rot ?? 0) * Math.PI) / 180;
  const dx = wx - rec.x;
  const dy = wy - rec.y;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}

/**
 * Where the playing targeted clip's chain tip is at `nowTick` (host frame),
 * or null with no targeted clip. An early retract (`arm-retract` keyed from
 * its target at tick 0) started at this point begins from the pose the rig
 * is in, so an aborted reach reverses without a jump: the 2-bone solve of a
 * point the chain already reaches returns the same joint angles. Scene /
 * test entry points only (allocates).
 */
export function rigClipTip(rec: StructureRecord, nowTick: number): { x: number; y: number } | null {
  const rig = rigForStructureKind(rec.kind);
  const p = rec.rigClip ?? null;
  if (rig === null || p === null || p.target === undefined) return null;
  const ci = rigClipIndex(rig, p.clipId);
  const clip = ci >= 0 ? rig.clips[ci]! : null;
  if (clip === null || clip.chain.length === 0) return null;
  const pose = evaluateRig(rig, p, nowTick, createRigPose(rig), twoBoneIkSolve);
  const tip = clip.chain[clip.chain.length - 1]!;
  return {
    x: pose.x[tip]! + clip.tipX * pose.cos[tip]! - clip.tipY * pose.sin[tip]!,
    y: pose.y[tip]! + clip.tipX * pose.sin[tip]! + clip.tipY * pose.cos[tip]!,
  };
}
