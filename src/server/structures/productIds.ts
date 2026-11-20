// Split out of ProductionSubsystem.ts (god-file ceiling).
import type { StructureKindId } from '../../shared-types/structureKinds.js';

/** `structure:<kind>` product ids, built once per kind (no per-cycle strings). */
const PACKED_PRODUCT = new Map<StructureKindId, string>();
export function packedProduct(kind: StructureKindId): string {
  let p = PACKED_PRODUCT.get(kind);
  if (p === undefined) {
    p = `structure:${kind}`;
    PACKED_PRODUCT.set(kind, p);
  }
  return p;
}

/** `hull:<kind>` product ids, built once per kind. */
const HULL_PRODUCT = new Map<string, string>();
export function hullProduct(kind: string): string {
  let p = HULL_PRODUCT.get(kind);
  if (p === undefined) {
    p = `hull:${kind}`;
    HULL_PRODUCT.set(kind, p);
  }
  return p;
}
