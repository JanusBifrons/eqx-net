/**
 * Rigs of structure family "transport" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Transport + docks: teleporter, pocket pad, freight dock, large teleporter, alien gate.
 * This family's moving parts live only here; `rigs` and `rigOfKind` are
 * spread into the catalogue (`rigCatalogue.ts`). Kind -> family:
 * client/render/pixi/structureFamilies.ts (core never imports it).
 */
import type { RigDef } from '../rig.js';
import { FREIGHT_DOCK_BAY, craneRigDef } from '../craneRig.js';
import type { RigKindMap } from './rigFamily.js';
import { ASTROLABE_RINGS } from '../../galaxy/alienGateAstrolabe.js';

/** The freight dock's crane (bay geometry and arm: `craneRig.ts`). */
export const DOCK_CRANE_DEF: RigDef = craneRigDef(FREIGHT_DOCK_BAY);

// Ancients' gate "Astrolabe" (teleporter redesign A1): three nested rings
// round the crystal, each a SPINNING cosmetic hinge (`PartDef.spin`) under
// the ships. Looks only: no outline, so no collider, hit box or nav change.
// The client sets the spin clock from `astrolabePoseAt`
// (galaxy/alienGateAstrolabe.ts) so the lanes line up at every jump; the
// server passes no clock, so for it the rings sit at rest.
export const ALIEN_GATE_ASTROLABE_DEF: RigDef = {
  id: 'alien-astrolabe',
  parts: ASTROLABE_RINGS.map((r) => ({
    id: r.part, parent: null, anchorX: 0, anchorY: 0,
    joint: { type: 'hinge' as const, min: -Math.PI, max: Math.PI },
    rest: 0, layer: 'under' as const, kind: 'cosmetic' as const, spin: r.spin,
  })),
  clips: [],
};

/** This family's rig defs. */
export const rigs: readonly RigDef[] = [DOCK_CRANE_DEF, ALIEN_GATE_ASTROLABE_DEF];

/** Structure kind id -> rig id, for this family's kinds. */
export const rigOfKind: RigKindMap = { freight_dock: 'dock-crane', alien_gate: 'alien-astrolabe' };
