import { describe, expect, it } from 'vitest';
import { ClaimFactionLookResultSchema, ClaimFactionLookSchema, FactionLookClaimedSchema, claimFactionLookResult } from './factionMessages.js';
import { FACTION_LOOK_CLAIMS, PLAYER_LIVERY, SIGIL_COUNT } from '../factions.js';

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

describe('claim_faction_look_result reply', () => {
  it.each(FACTION_LOOK_CLAIMS)('the server-built reply for %s passes the client schema', (claim) => {
    const reply = claimFactionLookResult(claim);
    expect(ClaimFactionLookResultSchema.parse(reply)).toEqual(reply);
    expect(reply.ok).toBe(claim === 'ok');
    expect(reply.reason).toBe(claim === 'ok' ? undefined : claim);
  });

  it("rejects reason 'ok' and unknown keys", () => {
    const base = { type: 'claim_faction_look_result', ok: false, message: 'x' };
    expect(ClaimFactionLookResultSchema.safeParse({ ...base, reason: 'ok' }).success).toBe(false);
    expect(ClaimFactionLookResultSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});

describe('faction_look_claimed broadcast', () => {
  const ok = { type: 'faction_look_claimed', look: { factionId: 'p', colorSlot: 0, sigil: SIGIL_COUNT - 1 } };
  it('accepts a claim and rejects an out-of-range or padded one', () => {
    expect(FactionLookClaimedSchema.safeParse(ok).success).toBe(true);
    expect(FactionLookClaimedSchema.safeParse({ ...ok, look: { ...ok.look, sigil: SIGIL_COUNT } }).success).toBe(false);
    expect(FactionLookClaimedSchema.safeParse({ ...ok, look: { ...ok.look, extra: 1 } }).success).toBe(false);
  });
});
