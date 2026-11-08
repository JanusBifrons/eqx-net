/**
 * Machined art — what to bake before the player needs it.
 *
 * The renderer starts on the galaxy map, before a sector is chosen, and the
 * join screen stays up for a few seconds after. That's free time: we queue
 * the art most players will see, so in play the brief "today's look until
 * the art is ready" swap is rarely visible. Anything not listed (the biggest
 * structures, asteroids — unique per rock) still bakes on demand.
 *
 * Order matters: ships first (they appear first), then the structures every
 * base has, then the rest of the common set. On a device's second visit all
 * of it comes from the cache in a fraction of a second.
 */
import { SHIP_KINDS_LIST } from '../../../shared-types/shipKinds.js';
import { FX_WARM } from './fx/fxTextures.js';
import type { BakeJob } from './bake.js';
import { seedVariant } from './bake.js';
import { shipExtent } from './fields.js';

/** Structures worth baking ahead, most common first. All at their usual
 *  (unturned) orientation; other turns bake on demand. */
export const WARM_STRUCTURES: readonly string[] = [
  'capital', 'connector', 'solar', 'turret', 'miner', 'battery', 'shield_pylon',
  'laser_bolt_turret', 'missile_turret', 'autocannon_turret', 'cargo_bay', 'shield_gate',
  'reactor', 'battery_bank', 'storage_vault', 'habitat_module', 'tower_module', 'mine_layer',
  // Coastal defences: the common batteries every base now carries.
  'aa_quad_40mm', 'dp_mount_5in',
];

/** Ships bigger than this (world units of outline half-extent) are test or
 *  capital hulls players rarely meet; they bake on demand. */
const WARM_SHIP_MAX_EXTENT = 100;

/** `fx`: also the effect textures every sector uses (the new effects). */
export function warmUpJobs(fx = false): BakeJob[] {
  const jobs: BakeJob[] = [];
  // Effects first: they are few, small and on screen in every fight.
  if (fx) for (const id of FX_WARM) jobs.push({ type: 'fx', id });
  for (const k of SHIP_KINDS_LIST) {
    if (shipExtent(k.id) < WARM_SHIP_MAX_EXTENT) jobs.push({ type: 'ship', id: k.id });
  }
  // Seed 1 is what the renderer asks for (structHandleFor), so the keys match.
  for (const id of WARM_STRUCTURES) jobs.push({ type: 'struct', id, seed: seedVariant(1), rot: 0 });
  return jobs;
}
