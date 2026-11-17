/**
 * The Territory Lock structure record (sector control, galaxy-map plan), kept
 * beside the catalogue so `structureKinds.ts` stays under its size cap. It is
 * appended to `STRUCTURE_KINDS_LIST` there (wire order, invariant #11).
 */
import type { StructureKind } from './structureKinds.js';

/**
 * Sector control: the price of a Territory Lock, in minerals drained while it
 * builds. A strategic piece, so it is the priciest normal structure on purpose
 * (the 80 cm siege gun is 12,000): building one freezes a sector you hold until
 * it is destroyed. Only the holder may build one; one per sector.
 */
export const TERRITORY_LOCK_COST = 20_000;

/** Sector control (galaxy-map plan): while built and its owner holds the
 *  sector, nobody can take the sector (`stepMultiControl` `lockedBy`). The
 *  look is a placeholder (the Research Lab's) pending the owner's pick. */
export const TERRITORY_LOCK: StructureKind = {
  id: 'territory_lock',
  displayName: 'Territory Lock',
  description: 'Locks a sector your side holds: nobody can take it while this stands. One per sector. A leaf node.',
  radius: 250, // bounding circle of the 400×300 footprint
  footprint: { w: 400, h: 300 },
  maxHealth: 4000,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 0,
  storageCapacity: 0,
  constructionCost: TERRITORY_LOCK_COST,
  color: 0xd9b25c,
};
