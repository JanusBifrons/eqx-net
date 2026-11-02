/**
 * Faction messages (plan soft-leaping-truffle v4, F3).
 *
 * `set_faction_policy` — a player edits their own faction's policy: their
 * turrets fire on anyone they view below `hostileBelow`, and anyone above
 * `alliedAbove` is an ally. `null` turns a rule off. Strict.
 */
import { z } from 'zod';
import { PlayerPolicyWireSchema } from '../factions.js';

export const SetFactionPolicySchema = z
  .object({
    type: z.literal('set_faction_policy'),
    policy: PlayerPolicyWireSchema,
  })
  .strict();
export type SetFactionPolicy = z.infer<typeof SetFactionPolicySchema>;
