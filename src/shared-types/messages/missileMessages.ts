/**
 * Missile wire messages — server-broadcast events for the missile
 * subsystem. Mirrors `LaserFiredEvent`'s pattern: each event is the
 * cross-process channel from the server-side bus to the client-side bus
 * (per root CLAUDE.md "The bus is per-process. Cross-process propagation
 * happens over a wire ... re-emitted onto the receiver's local bus.").
 *
 * `missile_fired` is broadcast to all clients (cheap, low cadence —
 * cooldownTicks=110 = ~1.8 s per mount). `missile_detonated` is
 * AOI-filtered server-side so distant clients don't pay for explosions
 * they can't see; mirrors the snapshot interest-grid filtering. See
 * `MissileSimulation.detonate` in src/server/rooms/MissileSimulation.ts.
 *
 * The missile pose itself is NOT on these events — it rides
 * `SnapshotMessage.missiles[]` (per-recipient AOI-filtered), and the
 * client renderer interpolates between snapshots. These events drive
 * spawn-VFX, detonate-VFX, and camera shake only.
 *
 * zod schemas live here so the client `safeParse`s before letting the
 * payload into the prediction ledger / VFX queue. The server builds the
 * messages itself and trusts its own shape (same pattern as
 * `LaserFiredEvent`).
 */

import { z } from 'zod';

/** Server → client (broadcast): a missile was launched. */
export interface MissileFiredEvent {
  type: 'missile_fired';
  /** Stable per-sector u32 id. Matches the `id` field on
   *  `SnapshotMessage.missiles[]` entries during the missile's lifetime. */
  missileId: number;
  /** Owner shooter id — wire form (`swarm-${entityId}` for AI shooters,
   *  playerId for players). Lets the client suppress its own launch VFX
   *  if it has a local-fire optimistic preview (none today). */
  ownerId: string;
  /** Spawn position (world coords). */
  x: number;
  y: number;
  /** Spawn heading (radians, Pixi-up = forward at angle 0 → -y). */
  angle: number;
  /** Catalogue weapon id — `'heat-seeker'` today; future variants extend
   *  this union as they ship. */
  weaponId: 'heat-seeker';
}

export const MissileFiredEventSchema = z
  .object({
    type: z.literal('missile_fired'),
    missileId: z.number().int().nonnegative(),
    ownerId: z.string(),
    x: z.number(),
    y: z.number(),
    angle: z.number(),
    weaponId: z.literal('heat-seeker'),
  })
  .strict();

/** Server → client (AOI-filtered broadcast): a missile detonated. */
export interface MissileDetonatedEvent {
  type: 'missile_detonated';
  missileId: number;
  /** Detonation position (world coords). May differ from the missile's
   *  last snapshot pose by up to one tick's worth of travel. */
  x: number;
  y: number;
  /** Splash radius read off the weapon def at detonation time — lets the
   *  client render an explosion sprite sized to match the damage zone
   *  without re-fetching the catalogue. */
  splashRadius: number;
  weaponId: 'heat-seeker';
}

export const MissileDetonatedEventSchema = z
  .object({
    type: z.literal('missile_detonated'),
    missileId: z.number().int().nonnegative(),
    x: z.number(),
    y: z.number(),
    splashRadius: z.number().nonnegative(),
    weaponId: z.literal('heat-seeker'),
  })
  .strict();
