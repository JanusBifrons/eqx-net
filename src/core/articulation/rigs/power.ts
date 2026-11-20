/**
 * Rigs of structure family "power" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Power + solar: solar, battery, battery bank, reactor.
 * This family's moving parts live only here; `rigs` and `rigOfKind` are
 * spread into the catalogue (`rigCatalogue.ts`). Kind -> family:
 * client/render/pixi/structureFamilies.ts (core never imports it).
 */
import type { PartDef, RigDef } from '../rig.js';
import type { RigKindMap } from './rigFamily.js';

// ── solar-tracker (solar) ────────────────────────────────────────────────────
//
// Family 1 (§9): the solar array, drawn for the 700 × 300 footprint. Eight
// panels on slewing pedestals, 4 columns × 2 rows, each an AIMING cosmetic
// hinge (`PartDef.aim`): on the client every panel turns to face the
// sector's sun (look only, power output unchanged, rule 5). The server never
// passes an aim, so for it they sit at rest. No outline: a plane part with an
// outline gets a collider (`rigBodies.ts`); a panel collides with nothing and
// draws from its family hook (`structureStyleC.power.ts`).
// Each panel faces its frame's +x: its long side runs along y. Its sweep
// radius (hypot(half long, half deep)) stays under half the pitch, so turning
// panels never overlap one another or leave the footprint.

/** Panel centres (host frame, game units): columns × rows. */
export const SOLAR_PANEL_XS = [-225, -75, 75, 225] as const;
export const SOLAR_PANEL_YS = [-76, 76] as const;
/** Panel half extents in its own frame: across (x, the face normal) and along (y). */
export const SOLAR_PANEL_HALF_DEEP = 26;
export const SOLAR_PANEL_HALF_LONG = 62;

function panel(id: string, x: number, y: number): PartDef {
  return {
    id, parent: null, anchorX: x, anchorY: y,
    joint: { type: 'hinge', min: -Math.PI, max: Math.PI },
    rest: 0, layer: 'plane', kind: 'cosmetic', aim: true,
  };
}

export const SOLAR_TRACKER_DEF: RigDef = {
  id: 'solar-tracker',
  parts: SOLAR_PANEL_YS.flatMap((y, r) => SOLAR_PANEL_XS.map((x, c) => panel(`panel-${r}-${c}`, x, y))),
  clips: [],
};

/** This family's rig defs. */
export const rigs: readonly RigDef[] = [SOLAR_TRACKER_DEF];

/** Structure kind id -> rig id, for this family's kinds. */
export const rigOfKind: RigKindMap = { solar: 'solar-tracker' };
