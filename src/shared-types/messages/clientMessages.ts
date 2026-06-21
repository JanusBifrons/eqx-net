import { z } from 'zod';
import { StructureKindIdSchema } from '../structureKinds.js';
import { SelectEntitySchema, DeselectEntitySchema } from './selectionMessages.js';

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
    // Bounded to cap payload size (S5) — a client-generated correlation id,
    // never longer than a UUID-ish token.
    clientShotId: z.string().min(1).max(64),
    weapon: z.enum(['hitscan', 'laser', 'heat-seeker']).default('hitscan'),
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
    slotId: z.string().min(1).max(64).optional(),
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
    // Bounded (S5) — sector keys are short slugs; the server still validates
    // the value is a real direct-neighbour key.
    targetSectorKey: z.string().min(1).max(64),
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
    shipId: z.string().min(1).max(64).optional(),
  })
  .strict();

/** Client → server: cancel an in-flight spool. No effect once the server
 *  has committed (state is IN_TRANSIT or beyond). */
export const CancelTransitSchema = z
  .object({
    type: z.literal('cancel_transit'),
  })
  .strict();

/** Client → server (plan: crispy-kazoo, Commit 2): "I have finished
 *  bootstrapping (first snapshot applied, predWorld initialised,
 *  renderer first-frame painted, minimum display floor elapsed) — you
 *  may now activate my ship and broadcast the synchronised warp-in."
 *
 *  Idempotent: a second send is silently ignored server-side. No
 *  payload — context (sessionId → playerId) is enough. */
export const ClientReadyMessageSchema = z
  .object({
    type: z.literal('client_ready'),
  })
  .strict();

/** Client → server (structures plan, Phase 2): "place a <kind> blueprint at
 *  world (x, y)". The server validates the kind + clamps the position to
 *  playable sector bounds, then drops a non-operational scaffolding (10 % HP)
 *  that the grid pulse builds up over time (Phase 3). Strict — no extra keys. */
export const PlaceStructureSchema = z
  .object({
    type: z.literal('place_structure'),
    kind: StructureKindIdSchema,
    x: z.number().finite(),
    y: z.number().finite(),
  })
  .strict();

/** Client → server (structures plan, Phase 2): "remove the structure I own
 *  with this id". The server rejects ids the requester doesn't own. */
export const RemoveStructureSchema = z
  .object({
    type: z.literal('remove_structure'),
    id: z.string().min(1).max(64),
  })
  .strict();

/** Client → server (structures plan, Phase 1 issue 6): act on a structure the
 *  requester OWNS, identified by its numeric swarm `entityId` (what the client
 *  has selected). Actions:
 *   - `toggle_deconstruct` — begin/cancel reverse-construction (drains minerals
 *      back to the network, removes when fully reclaimed);
 *   - `reconnect` — re-wire to the nearest legal in-range hub(s);
 *   - `clear_connections` — sever all of this structure's connections.
 *  Owner-gated server-side; foreign / unknown ids are dropped. Strict. */
export const StructureActionSchema = z
  .object({
    type: z.literal('structure_action'),
    id: z.number().int().nonnegative(),
    action: z.enum(['toggle_deconstruct', 'reconnect', 'clear_connections']),
  })
  .strict();

/** Client → server (Phase 4 WS-B4): "upgrade the structure I OWN with this
 *  numeric swarm `entityId`" — a paid level-up. The server validates ownership
 *  (the requester owns the structure) + that it's BUILT, not deconstructing, and
 *  below the level cap, then starts a NEW construction phase (reusing the grid
 *  pulse) whose cost is drained from the owner's Capital bank. On completion the
 *  level increments and the per-level stat grant (HP / turret range+damage /
 *  power output) applies. A foreign / unbuilt / capped / unknown request is a
 *  silent no-op. Strict — no extra keys. */
export const UpgradeStructureSchema = z
  .object({
    type: z.literal('upgrade_structure'),
    entityId: z.number().int().nonnegative(),
  })
  .strict();

/** Client → server (Phase 4 WS-A2): "pilot the OWNED in-sector ship with this
 *  shipInstanceId". The SAME-SECTOR INSTANT swap — the player (a spectator after
 *  death, or piloting another hull) reclaims one of their own lingering hulls
 *  parked in this sector and resumes control of it AT ITS LIVE POSE, with no
 *  spool / curtain. Owner-gated server-side: a shipId that isn't a lingering hull
 *  owned by the requester (or one piloted by someone else) is dropped. The
 *  camera smooth-lerp + self-prediction re-anchor happen client-side off the
 *  fresh `welcome` the server sends on success. Strict. */
export const PilotShipSchema = z
  .object({
    type: z.literal('pilot_ship'),
    shipId: z.string().min(1).max(64),
  })
  .strict();

/** Equinox Phase-5 audit — STOP PILOTING → spectate. The inverse of `pilot_ship`:
 *  the player toggles Spectate while flying an active hull, and the server
 *  DISPLACES that hull into a lingering hull (via `displaceActiveHullToLingering`)
 *  so the just-left ship is parked in-world AND re-appears in the player's own
 *  `lingeringShips` — which is what the in-world Pilot dropdown lists. Without
 *  this, Spectate was a pure client flip, the active hull stayed `isActive=true`
 *  (never in `lingeringShips`), and the Pilot dropdown was always empty ("no
 *  ships to pilot… I just spawned one"). No-op server-side when the player has no
 *  active hull (death-spectator / join-as-spectator). Strict, no payload. */
export const SpectateSchema = z
  .object({
    type: z.literal('spectate'),
  })
  .strict();

/** Stat-pool ids spendable by the upgrade modal (Phase 4 WS-B2). Mirrors
 *  `STAT_IDS` in `src/core/leveling/shipStats.ts` — kept as a local zod enum so
 *  `src/shared-types/` stays self-contained (the parity is asserted in
 *  `messages.test.ts`). Append-only: add a new id at the END, never reorder. */
export const StatIdSchema = z.enum(['hull', 'energy', 'damage', 'topSpeed', 'turnRate', 'shield']);

/** A spent stat allocation on the wire — `statId → points (≥ 0 integer)`.
 *  Bounded server-side against the ship instance's point budget (the budget
 *  can't be exceeded); per-entry capped at 64 so a malformed map can't bloat. */
export const StatAllocSchema = z
  .record(StatIdSchema, z.number().int().min(0).max(64))
  .refine((a) => Object.keys(a).length <= 6, { message: 'too many stat entries' });

/** Client → server (Phase 4 WS-B2): "spend my ship instance's upgrade points
 *  across the stat pool with this allocation". FREE allocation — the player may
 *  re-distribute any way they like within the point BUDGET (`level - 1`). The
 *  server validates ownership + the budget (`isAllocValid`), persists the alloc
 *  on the roster row, applies the per-instance multipliers (physics + combat),
 *  and echoes a `ship_upgrade_applied`. An over-budget / foreign / unknown ship
 *  is dropped. Strict — no extra keys. */
export const ApplyShipUpgradeSchema = z
  .object({
    type: z.literal('apply_ship_upgrade'),
    shipId: z.string().min(1).max(64),
    alloc: StatAllocSchema,
  })
  .strict();

/** Client → server (Phase 4 WS-B2): "respec my ship instance — refund every
 *  spent point back to the pool". Resets the roster `statAlloc` to `{}` and the
 *  multipliers to neutral, then echoes a `ship_upgrade_applied` with the empty
 *  alloc. A resource cost (D11 — optional) is a future balance knob; v1 is free.
 *  Owner-gated; a foreign / unknown ship is dropped. Strict. */
export const RespecShipSchema = z
  .object({
    type: z.literal('respec_ship'),
    shipId: z.string().min(1).max(64),
  })
  .strict();

/** Catalogue-id of the weapon to bind to an activated latent mount (Phase 4
 *  WS-B3). Mirrors `MountWeaponIdSchema` in `shipKinds/types.ts` (kept local so
 *  this module stays self-contained); parity asserted by `messages.test.ts`'s
 *  weapon-catalogue checks. Append-only. */
export const ActivateMountWeaponIdSchema = z.enum(['hitscan', 'laser', 'heat-seeker']);

/** Client → server (Phase 4 WS-B3, plan: effervescent-umbrella): "activate the
 *  latent mount slot `slotId` on my ship instance + bind `weaponId` to it". The
 *  dynamic-weapon-mounts upgrade — the server validates ownership + that
 *  `slotId` names a real `ShipKind.latentMounts` hardpoint + that the slot isn't
 *  already active, persists the `{ slotId, weaponId }` in the roster `mounts`
 *  JSON, mirrors it onto the live `ShipState.mounts`, and echoes a
 *  `mount_activated`. The activated mount's GEOMETRY is looked up CLIENT-SIDE by
 *  `(shipKind, slotId)` from the catalogue — never on the wire. A foreign /
 *  unknown / already-active / non-latent request is a silent no-op. Strict. */
export const ActivateMountSchema = z
  .object({
    type: z.literal('activate_mount'),
    shipId: z.string().min(1).max(64),
    slotId: z.string().min(1).max(64),
    weaponId: ActivateMountWeaponIdSchema,
  })
  .strict();

export const ClientMessageSchema = z.discriminatedUnion('type', [
  InputMessageSchema,
  IdentifyMessageSchema,
  FireMessageSchema,
  EngageTransitSchema,
  CancelTransitSchema,
  ClientReadyMessageSchema,
  PlaceStructureSchema,
  RemoveStructureSchema,
  StructureActionSchema,
  UpgradeStructureSchema,
  PilotShipSchema,
  SpectateSchema,
  ApplyShipUpgradeSchema,
  RespecShipSchema,
  ActivateMountSchema,
  SelectEntitySchema,
  DeselectEntitySchema,
]);

export type InputMessage = z.infer<typeof InputMessageSchema>;
export type IdentifyMessage = z.infer<typeof IdentifyMessageSchema>;
export type FireMessage = z.infer<typeof FireMessageSchema>;
export type EngageTransitMessage = z.infer<typeof EngageTransitSchema>;
export type CancelTransitMessage = z.infer<typeof CancelTransitSchema>;
export type ClientReadyMessage = z.infer<typeof ClientReadyMessageSchema>;
export type PlaceStructureMessage = z.infer<typeof PlaceStructureSchema>;
export type RemoveStructureMessage = z.infer<typeof RemoveStructureSchema>;
export type StructureActionMessage = z.infer<typeof StructureActionSchema>;
export type UpgradeStructureMessage = z.infer<typeof UpgradeStructureSchema>;
export type PilotShipMessage = z.infer<typeof PilotShipSchema>;
export type SpectateMessage = z.infer<typeof SpectateSchema>;
export type StatId = z.infer<typeof StatIdSchema>;
export type WireStatAlloc = z.infer<typeof StatAllocSchema>;
export type ApplyShipUpgradeMessage = z.infer<typeof ApplyShipUpgradeSchema>;
export type RespecShipMessage = z.infer<typeof RespecShipSchema>;
export type ActivateMountMessage = z.infer<typeof ActivateMountSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
