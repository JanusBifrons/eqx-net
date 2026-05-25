import { z } from 'zod';

/** Server → client (direct): result of a fire request. */
export interface HitAckMessage {
  type: 'hit_ack';
  clientShotId: string;
  hit: boolean;
  targetId?: string;
  /** True only when the server discarded the shot (cooldown or temporal plausibility). */
  rejected?: boolean;
  /** Damage the server applied for the closest mount-hit in this salvo
   *  (the hit reported by `targetId`). Present only on `hit:true` acks.
   *  Lets the client-side hit-prediction reconcile path confirm/de-dupe a
   *  predicted number against the authoritative value without waiting for
   *  the broadcast `DamageEvent`. weapon-hit-prediction Phase 0. */
  damage?: number;
}

/** Server → client (broadcast): a ship took damage. */
export interface DamageEvent {
  type: 'damage';
  targetId: string;
  damage: number;
  newHealth: number;
  shooterId: string;
  hitX?: number;
  hitY?: number;
  /** Shield/hull layered model (Phase: shield, plan clever-wombat). The
   *  client uses these instead of a global SHIP_MAX_HEALTH constant.
   *  `newHealth` remains the HULL value (hull == today's health). */
  newShield: number;
  shieldMax: number;
  hullMax: number;
  /** Which layer this hit landed on. */
  hitLayer: 'shield' | 'hull';
}

/** Server → client (broadcast): a ship was destroyed. */
export interface DestroyEvent {
  type: 'destroy';
  targetId: string;
  shooterId: string;
}

/** Server -> client (broadcast): a DISCRETE shield-state transition NOT
 *  carried by a `damage` event. Shield value on every hit rides
 *  DamageEvent.newShield; the regen ramp is NEVER streamed — the client
 *  tweens the bar between these anchors using the deterministic per-kind
 *  regen curve (locked design: no continuous shield traffic on the wire).
 *  phase 'restored' = shield crossed 0 -> >0 (regen began; server swapped
 *  the collider back to the cheap circle). phase 'regen_complete' = shield
 *  reached shieldMax (tween end-anchor). `broke` is intentionally absent:
 *  the damage event that dropped the shield already carries newShield:0. */
export interface ShieldEventMessage {
  type: 'shield';
  targetId: string;
  shield: number;
  shieldMax: number;
  phase: 'restored' | 'regen_complete';
  tick: number;
}

/** Server → client (direct): respawn confirmed — new position and server tick to reseed input clock. */
export interface RespawnAckMessage {
  type: 'respawn_ack';
  x: number;
  y: number;
  serverTick: number;
}

/** Server → client (broadcast): a hitscan shot was fired. Sent to ALL clients so
 *  they can render the beam. The endpoint is server-authoritative (lag-comp result).
 *
 *  Multi-mount/turret refactor (Phase 2c, 2026-05-11): `mountId` identifies
 *  which mount on the firing ship produced this beam. Server iterates the
 *  firing ship's slot mounts and broadcasts one event per mount (introduced
 *  in Phase 2a). Optional for pre-2c clients: when absent the client falls
 *  back to a synthetic `'forward'` mount id so legacy single-mount renders
 *  the same beam as before. */
export interface LaserFiredEvent {
  type: 'laser_fired';
  shooterId: string;
  mountId?: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  hit: boolean;
  targetId?: string;
}

// Stage 2 of the network-feel roadmap (collision event broadcasting).
// The server posts this when its physics worker drains a contact-force
// event above the impulse floor; the client mirrors the post-collision
// velocity to its predWorld immediately, eliminating the ~50 ms wait for
// the next snapshot to land the same correction. zod schema lives here so
// the client can validate inbound payloads defensively against future
// protocol skew — server creates the messages itself and trusts its own
// shape, so it never parses through this schema.

/** Server → client (AOI-filtered): a collision was resolved server-side.
 *  Carries post-collision velocities for both bodies so the client can apply
 *  them to its prediction world without waiting for a snapshot. */
export const CollisionResolvedMessageSchema = z
  .object({
    type: z.literal('collision_resolved'),
    /** Entity ID of the first body in the contact pair. */
    aId: z.string(),
    /** Entity ID of the second body. */
    bId: z.string(),
    /** Post-collision linear velocity of body `a`. */
    vA: z
      .object({
        x: z.number(),
        y: z.number(),
      })
      .strict(),
    /** Post-collision linear velocity of body `b`. */
    vB: z
      .object({
        x: z.number(),
        y: z.number(),
      })
      .strict(),
    /** Magnitude of the contact force (Newtons). Always non-negative. */
    impulse: z.number().nonnegative(),
    /** Server tick when the collision was resolved. Used by the client's
     *  out-of-order guard: events with tick < lastSnapshotServerTick are
     *  dropped (snapshot is authoritative for stale events). */
    tick: z.number().int().nonnegative(),
  })
  .strict();

export type CollisionResolvedMessage = z.infer<typeof CollisionResolvedMessageSchema>;

// weapon-hit-prediction Phase 0 — defensive schemas for the two server →
// client combat messages the client-side hit-prediction now *consumes*
// across the trust boundary. Exactly like `collision_resolved` above: the
// server builds these itself and trusts its own shape, so it never parses
// through them; the client `safeParse`s them on ingest and drops malformed
// packets (invariant #4) before they reach the prediction ledger / HUD.
// The shapes mirror the hand-written `HitAckMessage` / `DamageEvent`
// interfaces exactly — the bidirectional `z.infer` ↔ interface
// assignability lock in `messages.test.ts` fails `pnpm typecheck` if they
// ever drift. The interfaces stay the canonical type names (used
// throughout server + client); these schemas are validation-only, so no
// redundant `z.infer` alias is exported.

/** Server → client (direct): result of a fire request. `damage` rides
 *  only `hit:true` acks (the closest mount-hit's applied damage). */
export const HitAckSchema = z
  .object({
    type: z.literal('hit_ack'),
    clientShotId: z.string(),
    hit: z.boolean(),
    targetId: z.string().optional(),
    /** True only when the server discarded the shot (cooldown / temporal). */
    rejected: z.boolean().optional(),
    /** Applied damage for the `targetId` hit — present only when `hit:true`. */
    damage: z.number().optional(),
  })
  .strict();

/** Server → client (broadcast): a ship took damage. The client-side
 *  hit-prediction de-dupes a confirmed predicted number against this
 *  authoritative event; `handleDamage()` stays the SOLE HP/HUD authority. */
export const DamageEventSchema = z
  .object({
    type: z.literal('damage'),
    targetId: z.string(),
    damage: z.number(),
    newHealth: z.number(),
    shooterId: z.string(),
    hitX: z.number().optional(),
    hitY: z.number().optional(),
    newShield: z.number(),
    shieldMax: z.number(),
    hullMax: z.number(),
    hitLayer: z.enum(['shield', 'hull']),
  })
  .strict();
