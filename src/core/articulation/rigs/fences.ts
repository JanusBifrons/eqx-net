/**
 * Rigs of structure family "fences" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Fences + gates: shield pylon, gate, airlock, territory lock.
 * This family's moving parts live only here; `rigs` and `rigOfKind` are
 * spread into the catalogue (`rigCatalogue.ts`). Kind -> family:
 * client/render/pixi/structureFamilies.ts (core never imports it).
 */
import type { RigDef } from '../rig.js';
import type { RigKindMap } from './rigFamily.js';

// ── lock-beacon (territory lock) ─────────────────────────────────────────────
//
// F2: the territory lock's beacon dish, on its sweep arm over the lantern
// tower's beacon seat (the middle of the 400 × 300 footprint), is a SPINNING
// cosmetic hinge (`PartDef.spin`): the client turns it only while the lock is
// holding its sector for its owner's side (the `lockHolding` row flag) and
// holds it where it is otherwise. The server never passes a spin clock, so
// for it the dish sits at rest. No outline: no collider; the dish draws from
// the family hook (`structureStyleC.fences.ts`).

/** Beacon sweep rate (rad per game tick): one slow, calm turn every 8 s at 60 Hz. */
export const LOCK_BEACON_SPIN = (2 * Math.PI) / (8 * 60);

export const LOCK_BEACON_DEF: RigDef = {
  id: 'lock-beacon',
  parts: [{
    id: 'dish', parent: null, anchorX: 0, anchorY: 0,
    joint: { type: 'hinge', min: -Math.PI, max: Math.PI },
    rest: 0, layer: 'plane', kind: 'cosmetic', spin: LOCK_BEACON_SPIN,
  }],
  clips: [],
};

/** This family's rig defs. */
export const rigs: readonly RigDef[] = [LOCK_BEACON_DEF];

/** Structure kind id -> rig id, for this family's kinds. */
export const rigOfKind: RigKindMap = { territory_lock: 'lock-beacon' };
