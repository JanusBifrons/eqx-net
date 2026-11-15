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
import { allegianceOfKind, SHIP_KINDS_LIST } from '../../../shared-types/shipKinds.js';
import { teamColorOf, teamEdgeOf, teamSigilOf } from '../../../shared-types/factions.js';
import { FX_WARM } from './fx/fxTextures.js';
import type { BakeJob } from './bake.js';
import { seedVariant } from './bake.js';
import { shipExtent, type LiveryTreatment } from './fields.js';
import { hasTurrets } from './turretLayout.js';

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

/** `fx`: also the effect textures every sector uses (the new effects).
 *  `livery`: the ship livery in use (on by default): each ship is queued in
 *  the livery of its usual owner (its kind's allegiance), with turret rings
 *  when the new effects fit turrets, i.e. the same job `shipHandleFor` asks
 *  for, so the bake is reused. Cargo pods keep their tier paint. */
export function warmUpJobs(fx = false, livery?: LiveryTreatment): BakeJob[] {
  const jobs: BakeJob[] = [];
  // Effects first: they are few, small and on screen in every fight.
  if (fx) for (const id of FX_WARM) jobs.push({ type: 'fx', id });
  for (const k of SHIP_KINDS_LIST) {
    if (shipExtent(k.id) >= WARM_SHIP_MAX_EXTENT) continue;
    if (livery === undefined || k.id === 'cargo-pod') { jobs.push({ type: 'ship', id: k.id }); continue; }
    const owner = allegianceOfKind(k.id);
    const job: Extract<BakeJob, { type: 'ship' }> = {
      type: 'ship', id: k.id, paint: undefined,
      livery: { treatment: livery, team: teamColorOf(owner), sigil: teamSigilOf(owner), edge: teamEdgeOf(owner) },
    };
    if (fx && hasTurrets(k.id, false)) job.rings = true;
    jobs.push(job);
  }
  // Seed 1 is what the renderer asks for (structHandleFor), so the keys match.
  for (const id of WARM_STRUCTURES) jobs.push({ type: 'struct', id, seed: seedVariant(1), rot: 0 });
  return jobs;
}
