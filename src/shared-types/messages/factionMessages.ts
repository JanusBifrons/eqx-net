/**
 * Faction messages (plan soft-leaping-truffle v4, F3).
 *
 * `set_faction_policy` — a player edits their own faction's policy: their
 * turrets fire on anyone they view below `hostileBelow`, and anyone above
 * `alliedAbove` is an ally. `null` turns a rule off. Strict.
 *
 * `claim_faction_look` — a player claims a unique (palette slot, sigil) pair
 * for their faction's ships. Range is checked here; "is it free" by the
 * server (`claimFactionLook`). Strict.
 */
import { z } from 'zod';
import { FactionLookWireSchema, PlayerPolicyWireSchema } from '../factions.js';

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
