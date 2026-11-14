/**
 * `destructionProfile(entity)`: which destruction profile a dying entity
 * uses (`destruction.ts` holds the profiles and their numbers).
 *
 * Takes an entity, not just a ship kind id, so a structure kind
 * (`structureKinds.ts`) can map to a profile later (owner 2026-11-13: "This
 * includes structures as well in the future"). Until that work decides it
 * (a base's capital a spectacle, a solar panel quiet), structures are `none`:
 * they keep today's behaviour.
 *
 * Kept out of `destruction.ts`, which `tuning.ts` (and so the catalogue)
 * imports: this one reads the catalogue.
 */
import { getShipKind, isShipKindId } from '../shipKinds.js';
import { shipTuning } from './tuning.js';
import { DESTRUCTION_PROFILES, type DestructionProfile, type DestructionProfileId } from './destruction.js';

/** A dying thing, by entity type and its kind within that type. */
export type DestructionEntity =
  | { readonly type: 'ship'; readonly kindId: string }
  | { readonly type: 'structure'; readonly kindId: string };

/** The profile id for a dying entity. Ships read `shipTuning(kind)` (#18);
 *  an unknown ship kind id is `none` (never the default kind's profile). */
export function destructionProfile(entity: DestructionEntity): DestructionProfileId {
  switch (entity.type) {
    case 'ship':
      return isShipKindId(entity.kindId) ? shipTuning(getShipKind(entity.kindId)).destruction : 'none';
    case 'structure':
      return 'none';
  }
}

/** The profile's numbers for a dying entity. */
export function destructionProfileOf(entity: DestructionEntity): DestructionProfile {
  return DESTRUCTION_PROFILES[destructionProfile(entity)];
}
