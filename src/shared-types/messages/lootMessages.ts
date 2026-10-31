/**
 * Living World P1a (plan peppy-jumping-pinwheel) — loot messages.
 *
 * `loot_collected` is a UI ACCELERATOR (pickup popup) sent to the collector
 * only. The authoritative cargo is the own-ship snapshot `states[].cargo`
 * slice (invariant #16) — a dropped `loot_collected` loses a popup, never value.
 */
import { z } from 'zod';
import { GOOD_IDS } from '../goods.js';

export const LootCollectedEventSchema = z
  .object({
    type: z.literal('loot_collected'),
    goods: z.partialRecord(z.enum(GOOD_IDS), z.number().int().nonnegative()),
    credits: z.number().int().nonnegative(),
    /** Count of blueprints picked up (ids ride the cargo slice). */
    blueprints: z.number().int().nonnegative(),
  })
  .strict();
export type LootCollectedEvent = z.infer<typeof LootCollectedEventSchema>;
