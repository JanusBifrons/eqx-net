/**
 * The client's ONE seam for "what was this wreck cut from?" (structure
 * break-up T4). A wreck descriptor's `parentKind` is a ship kind, the rock
 * parent (`WRECK_ROCK_PARENT_KIND`) or the structure parent
 * (`WRECK_STRUCTURE_PARENT_KIND`); children carry their root's. Every client
 * site asks the SOURCE here instead of comparing `parentKind` itself, and
 * the whole-thing numbers (scale, radius, profile, body params) come from
 * core's `WreckSource` (`shipWreckSource` / `rockWreckSource` /
 * `structureWreckSource`), the same ones the server reads (#15).
 *
 * Never `getShipKind` a non-ship parent: its kind string is not a ship kind
 * (and a rock's or structure's wire `shipKind` byte is junk).
 */
import {
  rockWreckSource, shipWreckSource, structureWreckSource, type WreckSource,
} from '@core/destruction/wreckSource';
import type { ChunkOpts } from '@core/terrain/fieldLayout';
import { getShipKind, type ShipKindId } from '@shared-types/shipKinds';
import { shipShapeScale } from '@core/geometry/shipHullOutline';
import {
  WRECK_ROCK_PARENT_KIND, WRECK_STRUCTURE_PARENT_KIND, type WreckDescriptor,
} from '@shared-types/messages/wreckDescriptor';
import { DESTRUCTION_PROFILES, type DestructionProfile } from '@shared-types/shipScale/destruction';
import { destructionProfileOf } from '@shared-types/shipScale/destructionProfile';

/** What a wreck was cut from. */
export type WreckSourceKind = 'ship' | 'rock' | 'structure';

/** The source kind a descriptor's `parentKind` names (root or child). */
export function wreckSourceKindOf(parentKind: string): WreckSourceKind {
  if (parentKind === WRECK_ROCK_PARENT_KIND) return 'rock';
  if (parentKind === WRECK_STRUCTURE_PARENT_KIND) return 'structure';
  return 'ship';
}

/** A ROOT descriptor's source (core's memoised `WreckSource`). Undefined
 *  when the root lacks what its kind needs: a rock/structure root without
 *  its `rock`/`structure`, or a cut-field rock (`rock.fk`) with no room
 *  field options. No allocation once the source is memoised. */
export function rootSourceOf(root: WreckDescriptor, field: ChunkOpts | null | undefined): WreckSource | undefined {
  switch (wreckSourceKindOf(root.parentKind)) {
    case 'rock':
      if (root.rock === undefined) return undefined;
      if (root.rock.fk !== undefined && (field === undefined || field === null)) return undefined;
      return rockWreckSource(root.rock, field);
    case 'structure':
      return root.structure !== undefined ? structureWreckSource(root.structure) : undefined;
    default:
      return shipWreckSource(root.parentKind as ShipKindId);
  }
}

/** The world units per 1× frame unit of a wreck's pieces, by its parent
 *  kind: a rock's and a structure's frame is world (1), a ship's its kind's
 *  shape scale. */
export function wreckFrameScale(parentKind: string): number {
  return wreckSourceKindOf(parentKind) === 'ship' ? shipShapeScale(getShipKind(parentKind)) : 1;
}

/** A wreck's destruction profile by its parent kind: the rock or structure
 *  profile, else the ship kind's. */
export function wreckProfileOf(parentKind: string): DestructionProfile {
  switch (wreckSourceKindOf(parentKind)) {
    case 'rock': return DESTRUCTION_PROFILES.rock;
    case 'structure': return DESTRUCTION_PROFILES.structure;
    default: return destructionProfileOf({ type: 'ship', kindId: parentKind });
  }
}
