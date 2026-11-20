import { getStructureKind } from '../../shared-types/structureKinds.js';

/**
 * What a generated base pays for the power a purchase draws: its share of a
 * Solar, priced per unit of draw (one 120-power Solar is shared by small
 * loads), rounded up. The one price both the growth planner and the region
 * heart's super-gun funding use.
 */
export function powerShareCost(draw: number): number {
  const solar = getStructureKind('solar');
  return Math.ceil((draw / solar.powerOutput) * solar.constructionCost);
}
