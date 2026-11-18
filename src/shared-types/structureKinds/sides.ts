import type { StructureKindId } from './types.js';

// ── Unified entity hull (unified-hull plan) ────────────────────────────────
// A structure's FORM is a regular N-gon. This side-count is the single piece
// of shape data; `structureHullPoints` turns it into the point-set that drives
// BOTH the rendered silhouette (`buildStructureGfx`) AND the polygon collision
// hull (server `SwarmSpawner.spawnStructure` + client `structureClientLeaf`) —
// so render == collider, and the ball collider + the renderer's old procedural
// generation are both retired. Hubs read many-sided; leaves simpler.
export const STRUCTURE_SIDES: Record<StructureKindId, number> = {
  capital: 8,
  connector: 6,
  solar: 4,
  miner: 5,
  turret: 3,
  battery: 4, // boxy like the solar, distinguished by its amber tint
  shield_pylon: 7, // a distinct heptagon; the wall span between a pair is the star
  // WS-8 (R2.15) — the two new defence turrets read apart from the red triangle
  // beam turret by SHAPE + tint: bolt = orange square, missile = teal hexagon.
  laser_bolt_turret: 4,
  missile_turret: 6,
  cargo_bay: 4, // boxy crate, told apart from solar/battery by its teal tint
  shield_gate: 4,
  shield_airlock: 4,
  gas_collector: 4,
  reclaimer: 4,
  smelter: 4,
  refinery: 4,
  silicon_works: 4,
  hydroponics: 4,
  fabricator: 4,
  munitions_works: 4,
  freight_dock: 4,
  deep_core_rig: 4,
  ore_processing_complex: 4,
  assembly_plant: 4,
  research_lab: 4,
  autocannon_turret: 4,
  reactor: 4,
  battery_bank: 4,
  storage_vault: 4,
  shipyard: 4,
  habitat_module: 4,
  tower_module: 4,
  mine_layer: 4,
  teleporter: 4,
  teleporter_large: 4,
  alien_gate: 12,
  pocket_pad: 4,
  aa_quad_40mm: 4,
  dp_mount_5in: 4,
  coastal_casemate_8in: 4,
  coastal_turret_11in: 4,
  coastal_barbette_16in: 4,
  coastal_lindemann: 4,
  siege_gun_80cm: 4,
  territory_lock: 4,
};
