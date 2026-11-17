import { describe, expect, it } from 'vitest';
import { ClaimFactionLookSchema } from './factionMessages.js';
import { PLAYER_LIVERY, SIGIL_COUNT } from '../factions.js';

describe('claim_faction_look schema', () => {
  const ok = { type: 'claim_faction_look', colorSlot: 0, sigil: 0 };

  it('accepts an in-range pair (both ends)', () => {
    expect(ClaimFactionLookSchema.safeParse(ok).success).toBe(true);
    expect(ClaimFactionLookSchema.safeParse({ ...ok, colorSlot: PLAYER_LIVERY.length - 1, sigil: SIGIL_COUNT - 1 }).success).toBe(true);
  });

  it.each([
    ['colour slot past the palette', { ...ok, colorSlot: PLAYER_LIVERY.length }],
    ['negative colour slot', { ...ok, colorSlot: -1 }],
    ['fractional colour slot', { ...ok, colorSlot: 1.5 }],
    ['sigil past 12 bits', { ...ok, sigil: SIGIL_COUNT }],
    ['negative sigil', { ...ok, sigil: -1 }],
    ['string sigil', { ...ok, sigil: '3' }],
    ['missing sigil', { type: 'claim_faction_look', colorSlot: 0 }],
    ['unknown key (strict)', { ...ok, factionId: 'someone-else' }],
    ['wrong type', { ...ok, type: 'set_faction_policy' }],
  ])('rejects %s', (_label, msg) => {
    expect(ClaimFactionLookSchema.safeParse(msg).success).toBe(false);
  });
});
