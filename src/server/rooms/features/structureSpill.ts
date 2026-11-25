/**
 * Where a structure leaving the world spills its payload (`SectorRoom.evictSwarmEntity`
 * → `LootSubsystem.drop`). A structure that breaks into wreck pieces
 * (structure break-up) spawns them over its whole hull at its centre, so a
 * pod dropped there hid under them (a dead Capital's minerals looked lost).
 * A wrecked structure spills just past its hull instead, on its back side
 * (local -y: away from the crane bay's pad at +y): the kind's outline radius
 * (`structureWreckSource`, from its footprint outline) plus the pod's own hit
 * radius (`tuningFor('cargo-pod')`), never a fixed distance (#18). A
 * structure that leaves no wreck (deconstructed, no break-up) spills where
 * it stood, as before.
 */
import { structureWreckSource } from '../../../core/destruction/wreckSource.js';
import { tuningFor } from '../../../shared-types/shipScale/lookup.js';
import type { StructureKindId } from '../../../shared-types/structureKinds.js';
import { structureLocalToWorld } from '../../../shared-types/structureKinds/geometry.js';

/** Shared scratch for callers that read the point at once (discrete eviction). */
const SPILL_AT = { x: 0, y: 0 };

/** The spill point of structure `s` into `out` (default: a shared scratch, read it at once; alloc-free). */
export function structureSpillPoint(
  s: { kind: StructureKindId; x: number; y: number; rot?: number; mirror?: boolean },
  wrecked: boolean,
  out: { x: number; y: number } = SPILL_AT,
): { x: number; y: number } {
  if (!wrecked) {
    out.x = s.x;
    out.y = s.y;
    return out;
  }
  const off = structureWreckSource({ k: s.kind }).radius + tuningFor('cargo-pod').hitRadius;
  const a = ((s.rot ?? 0) * Math.PI) / 180;
  return structureLocalToWorld(0, -off, s.x, s.y, Math.cos(a), Math.sin(a), s.mirror, out);
}
