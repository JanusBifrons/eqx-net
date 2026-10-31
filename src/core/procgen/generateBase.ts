/**
 * Procedural base generator entry point (plan: soft-leaping-truffle).
 *
 * Pure + deterministic: the same descriptor yields a byte-identical layout on
 * the server worker, the client predWorld and the render worker. Generate,
 * then curate: a layout that fails validation is re-generated from
 * `hash(seed, attempt)` up to MAX_ATTEMPTS — still deterministic, because the
 * attempt sequence is a pure function of the seed.
 */
import type { BaseDescriptor, BaseLayout } from './baseLayout.js';
import { BASE_GENERATOR_VERSION } from './baseLayout.js';
import { generateWarehouse } from './archetypes/warehouse.js';
import { generateCity } from './archetypes/city.js';
import { fnvMixU32 } from './rng.js';
import { validateLayout } from './validate.js';
import { carveSealedPockets } from './carve.js';

export const MAX_ATTEMPTS = 8;

export class BaseGenerationError extends Error {}

export function generateBase(desc: BaseDescriptor): BaseLayout {
  if (desc.ver !== BASE_GENERATOR_VERSION) {
    throw new BaseGenerationError(`generator version ${desc.ver} != ${BASE_GENERATOR_VERSION}`);
  }
  let lastReasons: string[] = [];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const seed = attempt === 0 ? desc.seed >>> 0 : fnvMixU32(desc.seed >>> 0, attempt);
    const builder = desc.archetype === 'city' ? generateCity(desc, seed) : generateWarehouse(desc, seed);
    // Generate, then REPAIR (open any sealed pockets), then curate.
    const layout = carveSealedPockets(builder.build(desc, attempt), desc);
    const v = validateLayout(layout);
    if (v.ok) return layout;
    lastReasons = v.reasons;
  }
  throw new BaseGenerationError(`no valid layout after ${MAX_ATTEMPTS} attempts: ${lastReasons.join('; ')}`);
}
