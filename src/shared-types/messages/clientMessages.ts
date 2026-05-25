import { z } from 'zod';

export const InputMessageSchema = z
  .object({
    type: z.literal('input'),
    tick: z.number().int().nonnegative(),
    thrust: z.boolean(),
    turnLeft: z.boolean(),
    turnRight: z.boolean(),
    /** Shift-held boost — multiplies thrust impulse server-side. Optional for
     *  back-compat with clients that pre-date this field. */
    boost: z.boolean().optional(),
    /** Drifty-arcade reverse — S / Down arrow held. Applies a reduced-magnitude
     *  impulse opposite to the ship's facing. Optional for back-compat with
     *  clients that pre-date the car-physics rework. */
    reverse: z.boolean().optional(),
  })
  .strict();

export const IdentifyMessageSchema = z
  .object({
    type: z.literal('identify'),
    playerId: z.string().uuid().nullable(),
  })
  .strict();

export const FireMessageSchema = z
  .object({
    type: z.literal('fire'),
    tick: z.number().int().nonnegative(),
    clientShotId: z.string(),
    weapon: z.enum(['hitscan', 'laser']).default('hitscan'),
    /** Fire direction in radians, [-π, π]. Replaces the previous 4-number
     *  `rayFromX/Y, rayDirX/Y` payload (network-discipline P5). The server
     *  reconstructs the ray origin from the shooter's lag-compensated pose
     *  at `tick` plus the standard 20u barrel offset along this direction —
     *  same calculation the client used, but anchored to the server's
     *  authoritative rewound pose.
     *
     *  Deprecated by the multi-mount/turret refactor: Phase 2b.2 drops
     *  this field, leaving the server to reconstruct each mount's fire
     *  direction from authoritative ship.angle + mount.baseAngle + the
     *  mount-angle ring (Phase 4b). Still accepted today; pre-2b clients
     *  remain compatible. */
    dirAngle: z.number(),
    /** Active slot id the pilot fired from. Multi-mount/turret refactor
     *  (Phase 2b.1, 2026-05-11). Optional — when absent the server uses
     *  the firing ship-kind's first slot, which is the legacy single-mount
     *  `'primary'` slot for fighter/scout/heavy. The server validates the
     *  id against the ship's kind catalogue and silently falls back to
     *  the first slot if it doesn't resolve, so a misbehaving client can't
     *  pin its fire on a non-existent slot. */
    slotId: z.string().optional(),
  })
  .strict();

// Phase 8 sub-phase B — transit lifecycle messages (client → server entry points).

/** Client → server: "engage hyperspace to <targetSectorKey>". The server
 *  validates that the target is a direct neighbour and starts the
 *  spool-up; the ship stays in the source room and remains damageable.
 *
 *  Optional `arrival` lets the client specify where in the destination
 *  sector the ship should land. Absent ⇒ server uses the departure pose
 *  (current default). Present ⇒ server clamps to playable bounds and
 *  uses the result. PC has no UI for this and never sends it; mobile
 *  may send it via the Galaxy drawer arrival picker. */
export const EngageTransitSchema = z
  .object({
    type: z.literal('engage_transit'),
    targetSectorKey: z.string(),
    arrival: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
      })
      .strict()
      .optional(),
    /** Phase 5 multi-ship roster — when present, the destination room binds
     *  the named roster entry instead of letting the current ship continue.
     *  Validated server-side via `PlayerShipStore.get(shipId).playerId ===
     *  <requesting player>` (rejects foreign / unknown ids with
     *  `destination_unavailable`). Absent ⇒ legacy behaviour: the source
     *  ship's pose hydrates into the destination room. Min-length 1 so an
     *  empty string can't sneak past validation as "absent". */
    shipId: z.string().min(1).optional(),
  })
  .strict();

/** Client → server: cancel an in-flight spool. No effect once the server
 *  has committed (state is IN_TRANSIT or beyond). */
export const CancelTransitSchema = z
  .object({
    type: z.literal('cancel_transit'),
  })
  .strict();

export const ClientMessageSchema = z.discriminatedUnion('type', [
  InputMessageSchema,
  IdentifyMessageSchema,
  FireMessageSchema,
  EngageTransitSchema,
  CancelTransitSchema,
]);

export type InputMessage = z.infer<typeof InputMessageSchema>;
export type IdentifyMessage = z.infer<typeof IdentifyMessageSchema>;
export type FireMessage = z.infer<typeof FireMessageSchema>;
export type EngageTransitMessage = z.infer<typeof EngageTransitSchema>;
export type CancelTransitMessage = z.infer<typeof CancelTransitSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
