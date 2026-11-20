/**
 * Rigs of structure family "power" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Power + solar: solar, battery, battery bank, reactor.
 * This family's moving parts live only here; `rigs` and `rigOfKind` are
 * spread into the catalogue (`rigCatalogue.ts`). Kind -> family:
 * client/render/pixi/structureFamilies.ts (core never imports it).
 */
import type { PartDef, RigDef } from '../rig.js';
import type { RigKindMap } from './rigFamily.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';

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

// ── reactor-fans (reactor) ───────────────────────────────────────────────────
//
// Family 1 (§9): the reactor "dims when dry: core dark, fans stop". Four
// cooling fans, one in a round shroud on each corner of the containment
// frame, each a SPINNING cosmetic hinge (`PartDef.spin`): the client runs
// them while the reactor is fuelled (the same `noFuel` flag that darkens the
// core) and stops them where they are when it runs dry. The server never
// passes a spin clock, so for it they sit at rest. No outline: no collider;
// the blades draw from the family hook (`structureStyleC.power.ts`).
// Laid out from the kind's footprint (drawn for 600 × 600, scaled to fit), so
// the body art (`reactorFanLayout`) and the rig agree at any size.

/** Fan layout for a W × H reactor: centre offset from the middle on each
 *  axis (±at), shroud radius and blade radius (game units). */
export interface ReactorFanLayout { at: number; shroud: number; blade: number }

/** The fans of a W × H reactor (drawn for 600, scaled by the short side). */
export function reactorFanLayout(w: number, h: number): ReactorFanLayout {
  const k = Math.min(w, h) / 600;
  return { at: 196 * k, shroud: 66 * k, blade: 54 * k };
}

/** Fan spin rate (rad per game tick): about 0.8 turns a second at 60 Hz. */
export const REACTOR_FAN_SPIN = (2 * Math.PI * 0.8) / 60;

const REACTOR_FP = getStructureKind('reactor').footprint;
const FANS = reactorFanLayout(REACTOR_FP.w, REACTOR_FP.h);

function fan(id: string, sx: number, sy: number): PartDef {
  return {
    id, parent: null, anchorX: sx * FANS.at, anchorY: sy * FANS.at,
    joint: { type: 'hinge', min: -Math.PI, max: Math.PI },
    // Diagonal pairs counter-rotate, so the four never read as one stamp.
    rest: 0, layer: 'plane', kind: 'cosmetic', spin: sx * sy * REACTOR_FAN_SPIN,
  };
}

export const REACTOR_FANS_DEF: RigDef = {
  id: 'reactor-fans',
  parts: [fan('fan-ne', 1, 1), fan('fan-nw', -1, 1), fan('fan-sw', -1, -1), fan('fan-se', 1, -1)],
  clips: [],
};

/** This family's rig defs. */
export const rigs: readonly RigDef[] = [SOLAR_TRACKER_DEF, REACTOR_FANS_DEF];

/** Structure kind id -> rig id, for this family's kinds. */
export const rigOfKind: RigKindMap = { solar: 'solar-tracker', reactor: 'reactor-fans' };
