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
    /** Count of blueprints picked up (ids ride the cargo slice). */
    blueprints: z.number().int().nonnegative(),
  })
  .strict();
export type LootCollectedEvent = z.infer<typeof LootCollectedEventSchema>;

/** Living World P1a-2 — a short player-facing notice (e.g. "Repaired for 40 cr",
 *  "not enough banked credits"). Rendered as a HUD popup line. */
export const NoticeEventSchema = z
  .object({
    type: z.literal('notice'),
    text: z.string().min(1).max(200),
  })
  .strict();

/** Living World P1a-2 — an auto-deposit landed (UI accelerator: the "Banked …"
 *  popup). Cargo truth is still the own-ship snapshot slice. */
export const CargoDepositedEventSchema = z
  .object({
    type: z.literal('cargo_deposited'),
    goods: z.partialRecord(z.enum(GOOD_IDS), z.number().int().nonnegative()),
    blueprints: z.number().int().nonnegative(),
  })
  .strict();
