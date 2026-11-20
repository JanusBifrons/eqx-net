/**
 * The shape of one rig family file (`rigs/<family>.ts`, docs/plans/
 * structure-restyle-stage4.md §4 0a): its rig defs and its kinds' rig ids.
 */
import type { StructureKindId } from '../../../shared-types/structureKinds.js';
import type { RigDef } from '../rig.js';

/** Structure kind id -> rig id (a kind carries at most one rig). */
export type RigKindMap = Readonly<Partial<Record<StructureKindId, string>>>;

/** One family file's exports. */
export interface RigFamily {
  readonly rigs: readonly RigDef[];
  readonly rigOfKind: RigKindMap;
}
