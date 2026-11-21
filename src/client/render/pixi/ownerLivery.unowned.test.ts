/**
 * Capture 4E S7 — an ownerless base (`none:<lostCapitalId>`) has no faction,
 * so its structures bake in the neutral grey (the galaxy map's neutral-ground
 * colour), never a hashed player palette slot or the old faction's colour.
 */
import { describe, expect, it } from 'vitest';
import { ownerLivery } from '../art/shipArtSprites.js';
import { DEFAULT_FACTION_COLOR } from '../galaxy/galaxyTerritories.js';
import { teamColorOf } from '../../../shared-types/factions.js';
import { unownedOwner } from '../../../shared-types/relations.js';

describe('ownerLivery: an ownerless base', () => {
  it('paints every none: owner the same neutral grey, with the same markings', () => {
    const a = ownerLivery(unownedOwner('cap-1'));
    const b = ownerLivery(unownedOwner('cap-2'));
    expect(a.team).toBe(DEFAULT_FACTION_COLOR);
    expect(b).toEqual(a);
  });
  it('a faction or player keeps its own colour', () => {
    expect(ownerLivery('traders').team).toBe(teamColorOf('traders'));
    expect(ownerLivery('p1').team).toBe(teamColorOf('p1'));
    expect(ownerLivery('p1').team).not.toBe(DEFAULT_FACTION_COLOR);
  });
});
