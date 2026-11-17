/**
 * Faction messages (plan soft-leaping-truffle v4, F3).
 *
 * `set_faction_policy` — a player edits their own faction's policy: their
 * turrets fire on anyone they view below `hostileBelow`, and anyone above
 * `alliedAbove` is an ally. `null` turns a rule off. Strict.
 *
 * `claim_faction_look` — a player claims a unique (palette slot, sigil) pair
 * for their faction's ships. Range is checked here; "is it free" by the
 * server (`claimFactionLook`). Strict. The claimant gets
 * `claim_faction_look_result`; every room gets `faction_look_claimed`.
 */
import { z } from 'zod';
import { FACTION_LOOK_CLAIMS, FactionLookWireSchema, PlayerPolicyWireSchema, type FactionLookClaim } from '../factions.js';

export const SetFactionPolicySchema = z
  .object({
    type: z.literal('set_faction_policy'),
    policy: PlayerPolicyWireSchema,
  })
  .strict();
export type SetFactionPolicy = z.infer<typeof SetFactionPolicySchema>;

export const ClaimFactionLookSchema = z
  .object({
    type: z.literal('claim_faction_look'),
    colorSlot: FactionLookWireSchema.shape.colorSlot,
    sigil: FactionLookWireSchema.shape.sigil,
  })
  .strict();
export type ClaimFactionLook = z.infer<typeof ClaimFactionLookSchema>;

/** Server → claimant: the claim verdict (accelerator; the claims list in the
 *  welcome / Factions reply is the truth). `reason` is set when refused. */
export const ClaimFactionLookResultSchema = z
  .object({
    type: z.literal('claim_faction_look_result'),
    ok: z.boolean(),
    reason: z.enum(FACTION_LOOK_CLAIMS).exclude(['ok']).optional(),
    message: z.string().max(200),
  })
  .strict();
export type ClaimFactionLookResult = z.infer<typeof ClaimFactionLookResultSchema>;

const LOOK_REFUSALS: Readonly<Record<Exclude<FactionLookClaim, 'ok'>, string>> = {
  npc: 'That faction’s look is fixed.',
  range: 'That look does not exist.',
  taken: 'That look is already taken.',
};

/** The reply for a claim verdict (one wording, server-built). */
export function claimFactionLookResult(claim: FactionLookClaim): ClaimFactionLookResult {
  if (claim === 'ok') return { type: 'claim_faction_look_result', ok: true, message: 'Ship look claimed.' };
  return { type: 'claim_faction_look_result', ok: false, reason: claim, message: LOOK_REFUSALS[claim] };
}

/** Server → every room: a claim just succeeded somewhere in the galaxy
 *  (accelerator; a late joiner gets every claim in its welcome, #16). */
export const FactionLookClaimedSchema = z
  .object({
    type: z.literal('faction_look_claimed'),
    look: FactionLookWireSchema.strict(),
  })
  .strict();
export type FactionLookClaimed = z.infer<typeof FactionLookClaimedSchema>;
