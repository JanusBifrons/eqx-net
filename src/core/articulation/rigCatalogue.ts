/**
 * Real rig definitions (structure-restyle 2b+, plan §3 layers, §5 clips).
 *
 * Rigs are keyed by rig id; `rigForStructureKind` maps a structure kind id to
 * its rig. The structure kind catalogue is append-only wire format, so the
 * mapping lives in the rig files by kind id string, never as a field on the kind.
 *
 * Phase 0a (docs/plans/structure-restyle-stage4.md §4): each structure
 * family's rigs live in `rigs/<family>.ts` (defs + kind -> rig map); the
 * shared crane arm and bay rules are in `craneRig.ts`. This file only
 * assembles them and re-exports the lot, so callers import from here.
 *
 * Each rig is built once, lazily, and cached: lookups allocate nothing after
 * the first call.
 */
import { buildRig, type Rig, type RigDef } from './rig.js';
import type { RigFamily } from './rigs/rigFamily.js';
import * as core from './rigs/core.js';
import * as power from './rigs/power.js';
import * as fences from './rigs/fences.js';
import * as lightProduction from './rigs/lightProduction.js';
import * as mining from './rigs/mining.js';
import * as heavyIndustry from './rigs/heavyIndustry.js';
import * as turrets from './rigs/turrets.js';
import * as coastal from './rigs/coastal.js';
import * as storage from './rigs/storage.js';
import * as transport from './rigs/transport.js';

export * from './craneRig.js';
export { CAPITAL_CRANE_DEF, CAPITAL_UNFOLD } from './rigs/core.js';
export * from './unfoldRig.js';
export { DOCK_CRANE_DEF } from './rigs/transport.js';
export {
  DOOR_TURRET_LEAF_HALF_H, DOOR_TURRET_LEAF_HALF_W, DOOR_TURRET_LEAF_TRAVEL, DOOR_TURRET_LIFT, DOOR_TURRET_MOUNT,
  SANDBOX_DOOR_TURRET_DEF,
} from './rigs/turrets.js';
export type { RigFamily, RigKindMap } from './rigs/rigFamily.js';

// ── Catalogue ────────────────────────────────────────────────────────────────

/** Every family's rig file, by family id (the ids of the client's
 *  `STRUCTURE_FAMILY_IDS`; a test there checks they match). */
export const RIG_FAMILIES: Readonly<Record<string, RigFamily>> = {
  core, power, fences, lightProduction, mining, heavyIndustry, turrets, coastal, storage, transport,
};

const families = Object.values(RIG_FAMILIES);

export const RIG_DEFS: readonly RigDef[] = families.flatMap((f) => f.rigs);

/** Structure kind id -> rig id. Kind ids are strings from `structureKinds.ts`. */
const RIG_ID_OF_KIND: Readonly<Record<string, string>> = Object.assign({}, ...families.map((f) => f.rigOfKind));

const built = new Map<string, Rig>();

/** The built rig for `rigId`, or null. Built on first use, then cached. */
export function rigById(rigId: string): Rig | null {
  const hit = built.get(rigId);
  if (hit !== undefined) return hit;
  for (let i = 0; i < RIG_DEFS.length; i++) {
    const def = RIG_DEFS[i]!;
    if (def.id === rigId) {
      const rig = buildRig(def);
      built.set(rigId, rig);
      return rig;
    }
  }
  return null;
}

/** The rig a structure kind carries, or null when it has none. */
export function rigForStructureKind(kindId: string): Rig | null {
  const rigId = Object.prototype.hasOwnProperty.call(RIG_ID_OF_KIND, kindId) ? RIG_ID_OF_KIND[kindId] : undefined;
  return rigId === undefined ? null : rigById(rigId);
}
