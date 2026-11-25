/**
 * Structure kinds — deck tiles (base platforms). Family file of the structure
 * catalogue (barrel: `../structureKinds.ts`). A new kind's record goes in its
 * family file AND is APPENDED to `catalogueOrder.ts` (invariant #11).
 *
 * A deck tile is flat: it lies on the base deck, so it is no obstacle. Its
 * body is a permanent hologram (the blueprint ghost body, `ghostBody`, that
 * never turns solid: `isFlatDeckKind`, `server/structures/blueprintBody.ts`),
 * so ships fly over it, it is no nav obstacle, and no weapon touches it
 * (`isWeaponTransparent`). Its hex is still taken: placement overlap-checks
 * the registry, so no other building stands on a road.
 */
import type { StructureKind } from './types.js';

/** Road tile (base platforms slice 20): one deck hex of roadway. Deck rooms
 *  only (`DECK_ONLY_STRUCTURE_KINDS`). The footprint is the biggest box that
 *  fits its hex with the slot's 130 u room, shaped for the flat-top hex the
 *  art draws (the `hex` outline family: circumradius 400 = w / 2, height
 *  692 ≈ 400·√3). A 30° turn lines it up with the pointy-top deck cells. */
export const ROAD: StructureKind = {
  id: 'road',
  displayName: 'Road',
  description: 'A flat deck tile of roadway. Ships fly over it and shots pass over it. Deck bases only.',
  radius: 529, // bounding circle of the 800×692 footprint
  footprint: { w: 800, h: 692 },
  deckSlot: 'hex',
  maxHealth: 400,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 0,
  storageCapacity: 0,
  constructionCost: 40,
  color: 0x2a313b, // the deck floor fill (`structureDeckPlates.ts` DECK_FILL)
};
