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
     *  authoritative rewound pose. */
    dirAngle: z.number(),
  })
  .strict();

// Phase 8 sub-phase B — transit lifecycle messages.

/** Client → server: "engage hyperspace to <targetSectorKey>". The server
 *  validates that the target is a direct neighbour and starts the
 *  spool-up; the ship stays in the source room and remains damageable. */
export const EngageTransitSchema = z
  .object({
    type: z.literal('engage_transit'),
    targetSectorKey: z.string(),
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

export interface WelcomeMessage {
  type: 'welcome';
  playerId: string;
  /** Server physics tick at the moment the player joined. Client seeds inputTick from this. */
  serverTick: number;
  /** Phase 8 — stable galaxy sector key (e.g. 'sol-prime'), or null in
   *  engineering rooms (test-sector, swarm-soak, etc.) which have no
   *  persistent identity. */
  sectorKey: string | null;
}

/** Phase 8 sub-phase B — server → client transit lifecycle. */
export type TransitStateLabel = 'DOCKED' | 'SPOOLING' | 'IN_TRANSIT' | 'ARRIVED';
export type TransitCancelReason =
  | 'destroyed'
  | 'manual'
  | 'destination_unavailable'
  | 'token_expired'
  | 'not_neighbour';

export interface TransitStateMessage {
  type: 'transit_state';
  state: TransitStateLabel;
  /** Spool duration in ms. Present when `state === 'SPOOLING'`. */
  spoolMs?: number;
  /** Destination sector key. Present from SPOOLING through ARRIVED. */
  targetSectorKey?: string;
  /** When the state collapses to DOCKED via cancellation, why. */
  reason?: TransitCancelReason;
}

/** Authoritative snapshot broadcast by the server at 20 Hz for client-side
 *  reconciliation. Phase 5c: `obstacles` removed — asteroids and drones now
 *  flow through the binary swarm channel (see `client.send('swarm', buf)`)
 *  instead of being carried on every snapshot. */
export interface SnapshotMessage {
  type: 'snapshot';
  serverTick: number;
  /** Authoritative ship states at the time the snapshot was taken.
   *  Stage 3: each entry now carries `lastInput` — the input vector the
   *  worker applied this tick — so remote clients can forward-predict
   *  the body's pose using the same input intent the server is using.
   *  Optional for back-compat with snapshots from pre-Stage-3 servers. */
  states: Record<
    string,
    {
      x: number; y: number; vx: number; vy: number; angle: number; angvel: number;
      lastInput?: {
        thrust: boolean;
        turnLeft: boolean;
        turnRight: boolean;
        boost: boolean;
        reverse: boolean;
      };
    }
  >;
  /** Last client input tick acknowledged by the server for THIS recipient.
   *  Per-recipient (network-discipline P3) — earlier the server broadcast a
   *  full `Record<playerId, number>` to every client, but each client only
   *  reads its own entry, so the rest was O(N²) waste. */
  ackedTick: number;
  /** Set of playerIds currently holding boost (shift). Renderer draws an
   *  exhaust trail for each. Absent / empty when nobody is boosting. */
  boostingIds?: string[];
  /** Set of playerIds currently holding thrust (any acceleration). Strict
   *  superset of `boostingIds` because boost requires thrust. Renderer
   *  draws a baseline thrust flame for each; the boost flame layers on
   *  top when the same id is also in `boostingIds`. Absent / empty when
   *  nobody is thrusting. */
  thrustingIds?: string[];
  /** Live projectiles within the recipient's spatial-interest window. Absent
   *  when none. Wire-discipline P3: projectiles no longer ride MapSchema —
   *  this per-recipient list is the only path. Each entry is an authoritative
   *  pose snapshot at `serverTick`; the client mirrors it into its local
   *  projectile map and lets ghosts (client-side prediction) layer on top. */
  projectiles?: Array<{ id: string; x: number; y: number; vx: number; vy: number; ownerId: string; weaponId?: string }>;
}

/** Server → client (direct): result of a fire request. */
export interface HitAckMessage {
  type: 'hit_ack';
  clientShotId: string;
  hit: boolean;
  targetId?: string;
  /** True only when the server discarded the shot (cooldown or temporal plausibility). */
  rejected?: boolean;
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
}

/** Server → client (broadcast): a ship was destroyed. */
export interface DestroyEvent {
  type: 'destroy';
  targetId: string;
  shooterId: string;
}

/** Server → client (direct): respawn confirmed — new position and server tick to reseed input clock. */
export interface RespawnAckMessage {
  type: 'respawn_ack';
  x: number;
  y: number;
  serverTick: number;
}

/** Server → client (broadcast): a hitscan shot was fired. Sent to ALL clients so
 *  they can render the beam. The endpoint is server-authoritative (lag-comp result). */
export interface LaserFiredEvent {
  type: 'laser_fired';
  shooterId: string;
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
