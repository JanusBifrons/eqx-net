import { z } from 'zod';

/**
 * Click-to-inspect selection-scoped stats channel (structures follow-up
 * Item B5). A small, low-frequency channel — NOT a snapshot/binary addition:
 * there is no `SWARM_WIRE_VERSION` / catalogue bump. While an entity is
 * selected the server emits `entity_stats` for ONLY that one entity, to ONLY
 * the selecting client, at ~5 Hz on its own timer (off the snapshot/tick hot
 * path).
 *
 * Only PLAYER SHIPS and STRUCTURES use this channel — the snapshot deliberately
 * omits remote-ship health and structures carry only build pct, so the live
 * hp/shield must be pushed. Drones + wrecks do NOT use it (the client reads
 * `mirror.swarm.healthFrac` / `mirror.wrecks.health` directly).
 */

/** Client → server: "I selected entity <id> of <kind>; start streaming its
 *  stats to me." `kind` disambiguates the id namespace server-side: a `ship` id
 *  is a playerId; a `structure` id is the numeric swarm `entityId` (as a
 *  string). Strict — no extra keys. */
export const SelectEntitySchema = z
  .object({
    type: z.literal('select_entity'),
    id: z.string().min(1).max(64),
    kind: z.enum(['ship', 'structure']),
  })
  .strict();

/** Client → server: "I deselected; stop streaming." No payload — the
 *  per-connection selection is keyed by sessionId server-side. */
export const DeselectEntitySchema = z
  .object({
    type: z.literal('deselect_entity'),
  })
  .strict();

/** Server → client: live stats for the recipient's currently-selected entity.
 *  Emitted at ~5 Hz while selected; stops on deselect / target death /
 *  disconnect / transit. `shield`/`shieldMax` are omitted for entities without
 *  a shield layer (structures). Defined with zod `.strict()` for parity with
 *  the inbound schemas and to lock the wire shape; the server constructs the
 *  literal directly and the client validates on receive. */
export const EntityStatsSchema = z
  .object({
    type: z.literal('entity_stats'),
    /** Echoes the selected id (same form the client sent) so a stale message
     *  for a just-changed selection can be ignored. */
    id: z.string().min(1),
    kind: z.enum(['ship', 'structure']),
    /** Display name — player name for a ship, structure kind name for a
     *  structure. */
    name: z.string(),
    hp: z.number(),
    hpMax: z.number(),
    shield: z.number().optional(),
    shieldMax: z.number().optional(),
  })
  .strict();

export type SelectEntityMessage = z.infer<typeof SelectEntitySchema>;
export type DeselectEntityMessage = z.infer<typeof DeselectEntitySchema>;
export type EntityStatsMessage = z.infer<typeof EntityStatsSchema>;
