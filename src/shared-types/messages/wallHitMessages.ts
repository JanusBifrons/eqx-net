import { z } from 'zod';

/**
 * A shield fence stopped a shot (server → client). Broadcast when a blocking
 * fence absorbs a bolt or a missile, so clients can draw the impact on the
 * wall (fence-hit fix, 2026-11-04). Beams don't need it: their `laser_fired`
 * already ends at the fence (`hit: true`, no `targetId`).
 *
 * An accelerator only (invariant #16): nothing persistent depends on it.
 */
export const WallHitEventSchema = z.object({
  type: z.literal('wall_hit'),
  /** Impact point on the wall, game space. */
  x: z.number().finite(),
  y: z.number().finite(),
  kind: z.enum(['bolt', 'missile']),
});
export type WallHitEvent = z.infer<typeof WallHitEventSchema>;
