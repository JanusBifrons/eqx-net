/**
 * RTS command layer — client → server fleet command schemas (`fleet_order`,
 * `set_mode`, `set_stance`, `form_squad`, `disband_squad`). Re-exported by
 * `clientMessages.ts` (which keeps the `ClientMessageSchema` union).
 */
import { z } from 'zod';
import { FLEET_ROUTE_MAX, FLEET_STATUS_MODES, FLEET_STATUS_STANCES } from './fleetStatusMessages.js';

/* ── RTS command layer (slice 6a) ─────────────────────────────────────────
 * Fleet command wire schemas, built on the fleet vocabulary tables
 * (`fleetStatusMessages.ts`: `FLEET_STATUS_MODES` / `FLEET_STATUS_STANCES` /
 * `FleetOrder`). Owner-gating of `shipIds` is server-side. */

/** A `FleetMode`. Append-only. */
export const FleetModeSchema = z.enum(FLEET_STATUS_MODES);
/** A `FleetStance`. Append-only. */
export const FleetStanceSchema = z.enum(FLEET_STATUS_STANCES);

const FleetShipIdSchema = z.string().min(1).max(64);
const FleetShipIdsSchema = z.array(FleetShipIdSchema).min(1).max(64);
const FiniteSchema = z.number().finite();

/** Command speed (the speed telegraph, Stop / ⅓ / ⅔ / Full): a fraction of
 *  each ship's own top speed, 0 (stop) to 1 (full). Absent on a move = full,
 *  so an older client moves as before. */
export const FleetSpeedSchema = z.number().finite().min(0).max(1);

/** Client → server: a one-off order (`FleetOrder`) for the given owned ships.
 *  `move` needs finite `x`,`y` (optional `speed`); `attack` needs `targetId`;
 *  `speed` (needs `speed`) re-paces the ships' running Move orders: 0 halts
 *  them in place, keeping the destination. Strict. */
export const FleetOrderSchema = z
  .object({
    type: z.literal('fleet_order'),
    shipIds: FleetShipIdsSchema,
    kind: z.enum(['move', 'attack', 'stop', 'speed']),
    x: FiniteSchema.optional(),
    y: FiniteSchema.optional(),
    targetId: z.string().min(1).max(64).optional(),
    speed: FleetSpeedSchema.optional(),
  })
  .strict()
  .refine((m) => m.kind !== 'move' || (m.x !== undefined && m.y !== undefined), {
    message: 'move requires x and y',
  })
  .refine((m) => m.kind !== 'attack' || m.targetId !== undefined, {
    message: 'attack requires targetId',
  })
  .refine((m) => m.kind !== 'speed' || m.speed !== undefined, {
    message: 'speed requires speed',
  });

/** Client → server: set the standing mode for the given ships.
 *  `route` (patrol waypoints, max 16), `guardRadius` (defend) and `escortId`
 *  (escort) are optional mode parameters. Strict. */
export const SetModeSchema = z
  .object({
    type: z.literal('set_mode'),
    shipIds: FleetShipIdsSchema,
    mode: FleetModeSchema,
    route: z.array(z.tuple([FiniteSchema, FiniteSchema])).max(FLEET_ROUTE_MAX).optional(),
    guardRadius: FiniteSchema.positive().optional(),
    escortId: z.string().min(1).max(64).optional(),
    /** Retreat point, game space (send both or neither; none = back to the post). */
    x: FiniteSchema.optional(),
    y: FiniteSchema.optional(),
  })
  .strict();

/** Client → server: set the fire stance for the given ships. Strict. */
export const SetStanceSchema = z
  .object({
    type: z.literal('set_stance'),
    shipIds: FleetShipIdsSchema,
    stance: FleetStanceSchema,
  })
  .strict();

/** Client → server: group 2..24 owned ships into a squad. Strict. */
export const FormSquadSchema = z
  .object({
    type: z.literal('form_squad'),
    shipIds: z.array(FleetShipIdSchema).min(2).max(24),
  })
  .strict();

/** Client → server: break up a squad. Strict. */
export const DisbandSquadSchema = z
  .object({
    type: z.literal('disband_squad'),
    squadId: z.string().min(1).max(64),
  })
  .strict();
