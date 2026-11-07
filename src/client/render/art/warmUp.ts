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
 * base has. On a device's second visit all of it comes from the cache in a
 * fraction of a second.
 *
 * Kept SMALL on purpose (memory, 2026-11-07): every baked image is packed into
 * an atlas page that lives on the GPU (64 MB per 4096 px page) and as a
 * packing canvas, cached or not. Baking every ship kind ahead filled all four
 * desktop pages in a fighters-only room (348 MB of art textures; the robot
 * nexus alone 4.2 Mpx). Only what every pilot sees is warmed; the rest bakes
 * on first sight (today's look shows until it is ready).
 */
import { STARTER_HULL_KINDS } from '../../../shared-types/blueprints.js';
import { FX_WARM } from './fx/fxTextures.js';
import type { BakeJob } from './bake.js';
import { seedVariant } from './bake.js';

/** Structures worth baking ahead: the starter base every player builds. All
 *  at their usual (unturned) orientation; other turns bake on demand. */
export const WARM_STRUCTURES: readonly string[] = ['capital', 'connector', 'solar', 'turret', 'miner', 'battery'];

/** `fx`: also the effect textures every sector uses (the new effects). */
export function warmUpJobs(fx = false): BakeJob[] {
  const jobs: BakeJob[] = [];
  // Effects first: they are few, small and on screen in every fight.
  if (fx) for (const id of FX_WARM) jobs.push({ type: 'fx', id });
  // The hulls a pilot can start in; every other kind bakes on first sight.
  for (const id of STARTER_HULL_KINDS) jobs.push({ type: 'ship', id });
  // Seed 1 is what the renderer asks for (structHandleFor), so the keys match.
  for (const id of WARM_STRUCTURES) jobs.push({ type: 'struct', id, seed: seedVariant(1), rot: 0 });
  return jobs;
}
