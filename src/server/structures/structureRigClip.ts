/**
 * Start a rig clip on a structure (structure-restyle 2d, plan §5).
 *
 * The server owns rig playback: it records the deterministic clip record
 * `{clipId, startTick, target?}` on the structure (`StructureRecord.rigClip`)
 * and tells the physics worker (`RIG_CLIP` → `World.setRigClip`), which moves
 * the rig's solid parts from that record every tick (`World.stepRigs`).
 * Clients reproduce the same pose from the same record (slice 2e puts it on
 * the `structureStateWire.ts` row).
 *
 * Entry point: `SectorRoom.startStructureRigClip` (tests, a sceneScript).
 */
import { rigClipIndex } from '../../core/articulation/rig.js';
import { rigForStructureKind } from '../../core/articulation/rigCatalogue.js';
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
  rec.rigClip = target
    ? { clipId, startTick, target: { x: target.x, y: target.y } }
    : { clipId, startTick };
  post(target
    ? { type: 'RIG_CLIP', id: rec.id, clipId, startTick, targetX: target.x, targetY: target.y }
    : { type: 'RIG_CLIP', id: rec.id, clipId, startTick });
  return true;
}
