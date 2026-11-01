/**
 * World notices (Living World P4, plan peppy-jumping-pinwheel) — a discrete
 * server → client announcement ("Dread Vexis has been destroyed!"). An
 * ACCELERATOR only (#16): the world state it announces (an elite gone, an
 * event started) is always reconstructible from the snapshot / galaxy map.
 */
import { z } from 'zod';

export const WORLD_NOTICE_KINDS = ['elite_spawned', 'elite_killed', 'event_started', 'event_ended', 'bounty'] as const;
export type WorldNoticeKind = (typeof WORLD_NOTICE_KINDS)[number];

export const WorldNoticeSchema = z
  .object({
    type: z.literal('world_notice'),
    kind: z.enum(WORLD_NOTICE_KINDS),
    message: z.string().max(200),
  })
  .strict();

export type WorldNotice = z.infer<typeof WorldNoticeSchema>;
