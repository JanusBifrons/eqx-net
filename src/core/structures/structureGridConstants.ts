/**
 * Power-grid + construction constants (speed-dial-resource-structures plan).
 *
 * Zone-pure: shared by the server grid subsystem and any client-side preview
 * math. Values mirror eqx-peri's `GridManager` + The Space Game (see the plan's
 * "Logistics mechanics reference" table); tune for eqx-net world scale.
 *
 * Phase 2 introduces `SCAFFOLDING_HP_FRACTION` (a freshly-placed blueprint
 * spawns at this fraction of `maxHealth`, non-operational). Phase 3 appends the
 * connection / pulse / construction-rate constants here.
 */

/** A just-placed blueprint spawns at this fraction of `maxHealth` and is
 *  non-operational (power/storage/mining/fire all gated behind `isConstructed`)
 *  until the grid pulse finishes building it. */
export const SCAFFOLDING_HP_FRACTION = 0.1;
