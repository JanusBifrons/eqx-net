/** Client → server testMode-only showcase triggers (split out of `clientMessages.ts`, whose union lists them). */
import { z } from 'zod';

/** testMode only (showcase): warp every ship in the room to (x, y), keeping
 *  their formation (the NPC warp, W2a), so a shot can film a capital fleet
 *  spooling and jumping on cue. */
export const TestFleetWarpSchema = z
  .object({
    type: z.literal('test_fleet_warp'),
    x: z.number().finite(),
    y: z.number().finite(),
  })
  .strict();

/** testMode only (showcase, salvage plan PR 11b): hold a tractor beam from
 *  the sender's first mount on swarm entity `target` for `ticks` game ticks,
 *  as if that mount carried the tractor (no ship carries one until the
 *  barge, PR 15), so a shot can show the beam. */
export const TestTractorSchema = z
  .object({
    type: z.literal('test_tractor'),
    target: z.number().int().nonnegative(),
    ticks: z.number().int().min(1).max(36_000),
  })
  .strict();

/** testMode only (cargo pods look gate): drop one loot pod of each size
 *  class in a row ahead of the sender's ship, each with a different beacon. */
export const TestDropPodsSchema = z
  .object({
    type: z.literal('test_drop_pods'),
  })
  .strict();
