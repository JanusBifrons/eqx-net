/**
 * Rigs of structure family "turrets" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Turrets: turret, laser bolt, missile, autocannon, mine layer.
 * This family's moving parts live only here; `rigs` and `rigOfKind` are
 * spread into the catalogue (`rigCatalogue.ts`). Kind -> family:
 * client/render/pixi/structureFamilies.ts (core never imports it).
 */
import { box, type RigDef } from '../rig.js';
import type { RigKindMap } from './rigFamily.js';

// ── sandbox-door-turret (turret) ─────────────────────────────────────────────
//
// On the 140 × 140 `turret` kind: a pop-up gun in a socket at the centre
// (0, 0) under a two-leaf hatch.
//  - The riser is a LIFT part: it rises out of the plane and never moves in
//    it, so its kinematic collider stays put (only the drawn rise changes).
//    It carries the kind's `barrel` mount (`mountBridge.ts`).
//  - The hatch leaves sit over the socket: closed, they meet at x = 0 and
//    cover the riser's top (the riser outline is 36 × 40, drawn up to
//    `liftScaleUp` ≈ 1.14× risen, so ±20.5 × ±22.8); open, each slides 30
//    out, its meeting edge at |x| = 30, clear of the risen riser.
// The riser is listed first so the leaves draw over it.
// With no clip record the turret idles DEPLOYED (`idleClip`: hatch open, gun
// up): every turret in the game fires today, and a stowed one holds fire
// (`rigDeployed`), so "never clipped" must read as deployed on every side.

export const DOOR_TURRET_LEAF_HALF_W = 12;
export const DOOR_TURRET_LEAF_HALF_H = 24;
export const DOOR_TURRET_LEAF_TRAVEL = 30;
/** Lift height at full rise (progress 1); the unit is only a scale. */
export const DOOR_TURRET_LIFT = 1;
/** The part that carries the turret kind's mount (via `mountBridge.ts`). */
export const DOOR_TURRET_MOUNT = { mountId: 'barrel', partId: 'turret-lift' } as const;

const LEAF_OUTLINE = box(-DOOR_TURRET_LEAF_HALF_W, -DOOR_TURRET_LEAF_HALF_H, DOOR_TURRET_LEAF_HALF_W, DOOR_TURRET_LEAF_HALF_H);

export const SANDBOX_DOOR_TURRET_DEF: RigDef = {
  id: 'sandbox-door-turret',
  idleClip: 'turret-deploy',
  parts: [
    {
      id: 'turret-lift', parent: null, anchorX: 0, anchorY: 0,
      joint: { type: 'lift', min: 0, max: DOOR_TURRET_LIFT },
      rest: 0, layer: 'plane', kind: 'physical',
      outline: [-18, -14, -12, -20, 12, -20, 18, -14, 18, 14, 12, 20, -12, 20, -18, 14],
    },
    {
      id: 'door-left', parent: null, anchorX: -DOOR_TURRET_LEAF_HALF_W, anchorY: 0,
      joint: { type: 'slide', axisX: -1, axisY: 0, min: 0, max: DOOR_TURRET_LEAF_TRAVEL },
      rest: 0, layer: 'plane', kind: 'physical', outline: LEAF_OUTLINE,
    },
    {
      id: 'door-right', parent: null, anchorX: DOOR_TURRET_LEAF_HALF_W, anchorY: 0,
      joint: { type: 'slide', axisX: 1, axisY: 0, min: 0, max: DOOR_TURRET_LEAF_TRAVEL },
      rest: 0, layer: 'plane', kind: 'physical', outline: LEAF_OUTLINE,
    },
  ],
  clips: [
    {
      id: 'door-open',
      tracks: [
        { part: 'door-left', keys: [{ tick: 20, value: DOOR_TURRET_LEAF_TRAVEL, ease: 'out' }] },
        { part: 'door-right', keys: [{ tick: 20, value: DOOR_TURRET_LEAF_TRAVEL, ease: 'out' }] },
      ],
    },
    {
      id: 'door-close',
      tracks: [
        { part: 'door-left', keys: [{ tick: 0, value: DOOR_TURRET_LEAF_TRAVEL }, { tick: 20, value: 0 }] },
        { part: 'door-right', keys: [{ tick: 0, value: DOOR_TURRET_LEAF_TRAVEL }, { tick: 20, value: 0 }] },
      ],
    },
    {
      // Self-contained: opens the hatch first, then the turret rises through it.
      id: 'turret-deploy',
      tracks: [
        { part: 'door-left', keys: [{ tick: 20, value: DOOR_TURRET_LEAF_TRAVEL, ease: 'out' }] },
        { part: 'door-right', keys: [{ tick: 20, value: DOOR_TURRET_LEAF_TRAVEL, ease: 'out' }] },
        { part: 'turret-lift', keys: [{ tick: 15, value: 0 }, { tick: 60, value: DOOR_TURRET_LIFT }] },
      ],
    },
    {
      // The turret sinks, then the hatch closes over it.
      id: 'turret-retract',
      tracks: [
        { part: 'turret-lift', keys: [{ tick: 0, value: DOOR_TURRET_LIFT }, { tick: 45, value: 0 }] },
        { part: 'door-left', keys: [{ tick: 0, value: DOOR_TURRET_LEAF_TRAVEL }, { tick: 45, value: DOOR_TURRET_LEAF_TRAVEL }, { tick: 65, value: 0 }] },
        { part: 'door-right', keys: [{ tick: 0, value: DOOR_TURRET_LEAF_TRAVEL }, { tick: 45, value: DOOR_TURRET_LEAF_TRAVEL }, { tick: 65, value: 0 }] },
      ],
    },
  ],
};

/** This family's rig defs. */
export const rigs: readonly RigDef[] = [SANDBOX_DOOR_TURRET_DEF];

/** Structure kind id -> rig id, for this family's kinds. */
export const rigOfKind: RigKindMap = { turret: 'sandbox-door-turret' };
