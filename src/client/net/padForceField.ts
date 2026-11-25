/**
 * v4 T2 / redesign T3 — a teleporter's closing push for the prediction world,
 * from its room-state phase: the same `PadForceField` the server's
 * `teleportMessages` sets in its worker (#15). A chamber pad
 * (`isPadChamberKind`) carries its rotation as `doorAngle`, so the push runs
 * only along its doorway axis (`padPushDir`), never into a wall; the
 * Ancients' gate has none (the open square pad). Writes `out` in place (#14).
 */
import type { PadForceField } from '@core/physics/forceFields';
import { PAD_SPECS, TP_PHASE, isPadChamberKind, type TeleporterKind } from '../../shared-types/teleport.js';

export function writePadForceField(
  out: PadForceField, kind: TeleporterKind, x: number, y: number, angle: number, phase: number,
): PadForceField {
  out.cx = x;
  out.cy = y;
  out.half = PAD_SPECS[kind].padRadius;
  out.active = phase === TP_PHASE.CLOSING;
  out.doorAngle = isPadChamberKind(kind) ? angle : undefined;
  return out;
}
