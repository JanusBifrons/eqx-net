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

// Phase 8 sub-phase B — transit lifecycle messages.

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

export interface WelcomeMessage {
  type: 'welcome';
  playerId: string;
  /** Server physics tick at the moment the player joined. Client seeds inputTick from this. */
  serverTick: number;
  /** Phase 8 — stable galaxy sector key (e.g. 'sol-prime'), or null in
   *  engineering rooms (test-sector, swarm-soak, etc.) which have no
   *  persistent identity. */
  sectorKey: string | null;
  /** Phase 5 (and Phase 6a foundation) — the `player_ships.ship_id` UUID
   *  this connection is bound to. Lets the client identify "the ship I'm
   *  currently piloting" without confusing it with other entries the
   *  server still marks `isActive=true` during the 15-min reconnect
   *  linger window. Empty string in engineering rooms that don't have
   *  a roster row. */
  shipInstanceId: string;
}

/**
 * Phase 2 multi-ship roster — server pushes a player's full roster (up to
 * 10 entries) whenever it changes. The client uses this to drive the
 * ship-list panel on the galaxy map. Per-entry numbers are static-state
 * (last-known position when stored; current pose when active). The
 * canonical x/y for an active ship still flows over the per-frame render
 * mirror — this message is for the discrete card UI.
 */
export interface ShipRosterEntry {
  shipId: string;
  kind: string;
  /** Catalogue version when the entry was last saved server-side.
   *  Returning-player drift handling clamps stale rows to the current
   *  catalogue at hydrate time; this field is informational here. */
  kindVersion: number;
  health: number;
  /** Sector this ship was last seen in (or is currently active in). */
  sectorKey: string;
  /** Last-known world position. For active ships this is updated when
   *  the server flushes pose to persistence (periodic + onLeave). */
  x: number;
  y: number;
  /** True while bound to a sector-room slot (player is connected and
   *  playing this ship, or just disconnected and within the 15-min
   *  linger window). */
  isActive: boolean;
}

export interface ShipRosterMessage {
  type: 'ship_roster';
  ships: ShipRosterEntry[];
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
   *
   *  **Phase 6a: outer key is `shipInstanceId`** (was `playerId` pre-6a).
   *  Each entry carries `playerId` (owner identity) and `isActive`
   *  (true while a session is driving the hull; false for lingering
   *  hulls in Phase 6b+). The client's snapshot translator picks `self`
   *  via `WelcomeMessage.shipInstanceId` and skips `isActive=false`
   *  entries until Phase 6b drops the visibility gate.
   *
   *  Stage 3: each entry carries `lastInput` — the input vector the
   *  worker applied this tick — so remote clients can forward-predict
   *  the body's pose using the same input intent the server is using.
   *  Optional for back-compat with snapshots from pre-Stage-3 servers. */
  states: Record<
    string,
    {
      x: number; y: number; vx: number; vy: number; angle: number; angvel: number;
      /** Phase 6a — owner playerId for this hull. The map key is now
       *  shipInstanceId, so this is how the client recovers "who owns
       *  this ship" for display labels + damage-event correlation. */
      playerId: string;
      /** Phase 6a — true while a session is actively piloting this hull.
       *  Always true in 6a (one active ship per player per sector still
       *  invariant). Phase 6b introduces `isActive=false` for lingering
       *  hulls; client uses this to gate visibility / interaction. */
      isActive: boolean;
      lastInput?: {
        thrust: boolean;
        turnLeft: boolean;
        turnRight: boolean;
        boost: boolean;
        reverse: boolean;
      };
      /** Multi-mount/turret refactor (Phase 4b.3, 2026-05-11). Per-mount
       *  rotation angle in arc-local frame, indexed by mount-order in the
       *  ship-kind catalogue. Authoritative — the server's
       *  WeaponMountController tick computes these and they drive both the
       *  server's hit-test geometry and remote observers' rendered turret
       *  rotation. Absent for ship-kinds with no rotating mounts (the
       *  legacy single-mount fighter/scout/heavy emit nothing). */
      mountAngles?: number[];
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
  /** Phase C (2026-05-09 AI lockstep) — drone reconcile-anchor slice.
   *  In-interest drones at the snapshot's `serverTick`, sourced from the
   *  per-tick `SnapshotRing` so the pose is temporally aligned with the
   *  player states above. The client uses these to seed predWorld drone
   *  bodies before reconciler replay, eliminating the structural lookahead
   *  snap-distance that previously surfaced as visible per-packet jitter
   *  (see `swarm_snap_diagnostics` events). Absent when no drones are
   *  in-interest, or when the recipient is in a sector that hasn't seeded
   *  drones (e.g. a fresh test-sector join before any AI has registered).
   *  `id` is the dense `u16 entityId` matching the binary swarm channel. */
  drones?: Array<{
    id: number;
    x: number; y: number; vx: number; vy: number; angle: number; angvel: number;
    /** Multi-mount/turret refactor (Phase 4c, 2026-05-11). Per-mount slewed
     *  angle in arc-local frame for this drone, indexed by mount-order in
     *  the ship-kind catalogue. Emitted only for in-interest drones whose
     *  kind has at least one rotating mount (legacy fighter/scout/heavy
     *  drones omit the field — their single 'forward' mount has zero arc
     *  so the angle is always 0 and would only add bytes). Out-of-interest
     *  drones never carry mountAngles; their turrets freeze at baseAngle
     *  until they re-enter interest and the next snapshot anchors them. */
    mountAngles?: number[];
  }>;
  /** Phase 4 — abandoned-ship wrecks in this sector. Each entry is the
   *  per-tick pose for a wreck currently owning a SAB slot (the worker
   *  continues to step it; wrecks have inertia and drift). Identity
   *  (kind, current health, maxHealth) is broadcast via the Colyseus
   *  schema diff on `state.wrecks` and correlated by shipInstanceId.
   *  Absent when no wrecks exist in the sector. */
  wrecks?: Array<{
    /** shipInstanceId UUID — matches the key in `SectorState.wrecks`. */
    id: string;
    x: number; y: number; vx: number; vy: number; angle: number; angvel: number;
  }>;
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

/**
 * Server → client (broadcast): a remote ship just warped OUT of this sector.
 * Sent to every occupant of the source sector EXCEPT the leaving player
 * themselves (the local player gets their own warp visual from the
 * `transit_state` SPOOLING/IN_TRANSIT machinery). The client fires a
 * one-shot `triggerWarpIn` (flash + burst ripple) at `(x, y)` so observers
 * see where the ship vanished from.
 *
 * NOTE: the message name is `warp_out` but the client uses the same
 * `triggerWarpIn` API for both directions — the renderer's "burst+flash
 * at a world point" pulse is direction-agnostic.
 */
export interface WarpOutEvent {
  type: 'warp_out';
  playerId: string;
  x: number;
  y: number;
}

/**
 * Server → client (broadcast): a ship just warped INTO this sector.
 * Sent to every existing occupant EXCEPT the joining player themselves
 * (the joiner gets their own arrival visual from the welcome /
 * snapshot flow). The client fires `triggerWarpIn` at the spawn world
 * point so observers see the arrival pulse.
 */
export interface WarpInEvent {
  type: 'warp_in';
  playerId: string;
  x: number;
  y: number;
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
