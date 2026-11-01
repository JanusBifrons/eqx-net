/**
 * Research Lab messages (economy v2 W3, plan peppy-jumping-pinwheel).
 *
 * The lab panel is rebuilt from `lab_state` replies ONLY (#16): the client
 * asks with `lab_query` when the panel opens and every second while it's on
 * screen, and after every action. Every action replies with a fresh
 * `lab_state` carrying a player-facing `message`. Blueprints are shown by
 * NAME; uids travel only so the client can say which item it means.
 */
import { z } from 'zod';
import { COMBINE_COUNT, COPY_MAX_RUNS } from '../research.js';

const entityId = z.number().int().nonnegative();
const uid = z.string().min(1).max(80);

export const LabQuerySchema = z.object({ entityId }).strict();
export type LabQuery = z.infer<typeof LabQuerySchema>;

export const LabJobSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('research'), stat: z.enum(['material', 'output']), uid }).strict(),
  z.object({ kind: z.literal('copy'), uid, runs: z.number().int().min(1).max(COPY_MAX_RUNS) }).strict(),
  z.object({ kind: z.literal('combine'), uids: z.array(uid).length(COMBINE_COUNT) }).strict(),
]);

export const LabStartSchema = z.object({ entityId, job: LabJobSpecSchema }).strict();
export type LabStart = z.infer<typeof LabStartSchema>;

export const LabCancelSchema = z.object({ entityId }).strict();
export type LabCancel = z.infer<typeof LabCancelSchema>;

/** One blueprint as the lab panel shows it. */
export const LabBlueprintViewSchema = z
  .object({
    uid,
    product: z.string().max(80),
    name: z.string().max(80),
    kind: z.enum(['bpo', 'bpc']),
    runs: z.number().int().nonnegative().nullable(),
    material: z.number().nonnegative(),
    output: z.number().nonnegative(),
    quality: z.number().nonnegative(),
  })
  .strict();
export type LabBlueprintView = z.infer<typeof LabBlueprintViewSchema>;

export const LabJobViewSchema = z
  .object({
    kind: z.enum(['research', 'copy', 'combine']),
    /** Player-facing summary, e.g. "Researching Gunship (output)". */
    label: z.string().max(120),
    done: z.number().int().nonnegative(),
    pulses: z.number().int().positive(),
  })
  .strict();
export type LabJobView = z.infer<typeof LabJobViewSchema>;

export const LabStateSchema = z
  .object({
    type: z.literal('lab_state'),
    entityId,
    powered: z.boolean(),
    /** Is the lab joined to any of the owner's storage? */
    connected: z.boolean(),
    job: LabJobViewSchema.nullable(),
    blueprints: z.array(LabBlueprintViewSchema).max(200),
    /** The verdict of the action this replies to, if any. */
    message: z.string().max(200).optional(),
    ok: z.boolean().optional(),
  })
  .strict();
export type LabState = z.infer<typeof LabStateSchema>;
