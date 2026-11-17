import { z } from 'zod';
import type { Hold } from '../goods.js';
import type { BeamLinks } from '../beamLinksWire.js';
import { ShellSalvoSchema, type ShellKeyRecord, type ShellSalvo } from './shellEvents.js';
import { MAX_WELCOME_WRECKS, WreckDescriptorSchema, type WreckDescriptor, type WreckSync } from './wreckDescriptor.js';

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
  /** Equinox Phase 5 (WS-3) — join-as-spectator. When `true`, this player
   *  joined the sector as a SPECTATOR: the server spawned their hull through
   *  the normal handshake but PARKED it as a lingering hull at the arrival
   *  flip (so there is no ACTIVE hull), and the client enters `pilotMode =
   *  'spectator'` (free-roam camera + construction; the parked hull is
   *  pilotable via the in-world Pilot dropdown). Absent / `false` ⇒ the
   *  normal pilot join. Back-compat: pre-Phase-5 servers omit it. */
  spectator?: boolean;
  /** Ship scale infrastructure: the server's ship scale and combat profile,
   *  sent only when not the defaults (1, 'A'). The client must run the same
   *  (the catalogue is built from it); a mismatch is logged loudly. */
  shipScale?: number;
  shipTuning?: 'A' | 'B';
  /** Per-kind size overrides (EQX_SHIP_KIND_SCALE), sent only when set. */
  shipKindScale?: string;
  /** The server's naval range mode (`EQX_NAVAL_RANGE`), always sent; absent
   *  ⇒ `legacy` (a server from before real became the default). The client's
   *  must match (combat/navalRange.ts). */
  navalRange?: 'legacy' | 'real';
  /** Shells as events (shell-events.md §7): set only when the server sends
   *  naval shells as `shell_salvo` / `shell_end` (always, since slice 4). */
  shellEvents?: true;
  /** The live shells this ship should see, in salvo form (§5, #16). */
  shellsInFlight?: ShellSalvo[];
  /** Capital destruction: set when this room breaks a dying capital into
   *  wreck pieces (`capitalWrecks`). The client then plays the break-up
   *  explosion at the kill point instead of the hull-sized death blast
   *  (money-shot review). Absent = no wrecks. */
  capitalWrecks?: true;
  /** Sub-capital break-up: set when this room breaks dying sub-capitals into
   *  wreck pieces (`subcapWrecks` / `EQX_SUBCAP_WRECKS`). The client then
   *  holds the dying hull briefly until its pieces are drawn; the ship's
   *  normal death explosion still plays. Absent = no sub-cap wrecks. */
  subcapWrecks?: true;
  /** Sub-capital break-up slice 3 — the FULL set of live wreck descriptors at
   *  join (#16). Snapshots then carry only `wreckAdds` / `wreckRemoves` and a
   *  slow `wreckSync`. Absent = none (or wrecks off). */
  wrecks?: WreckDescriptor[];
  /** Macro terrain v2 (room flag `cutField`): the field seed; the client cuts
   *  the same rocks from it, minus `consumed`: the keys of rocks broken up
   *  (C3; later breaks arrive as `field_consumed`), and `moved`: where each
   *  moved rock was left (C2 deep sleep; later moves arrive as `field_moved`).
   *  `clearings`: the open pockets cut out of the field (galaxy sectors, F4),
   *  absent when none. Absent = no cut field. */
  cutField?: CutFieldWelcome;
}

/** The welcome's cut field (see `WelcomeMessage.cutField`). */
export interface CutFieldWelcome { seed: string; clearings?: FieldClearingWire[]; consumed?: number[]; moved?: FieldRockPose[] }
/** A field clearing on the wire: the same numbers as core `FieldClearing`. */
export interface FieldClearingWire { x: number; y: number; r: number }
/** Clearings a welcome carries at most (a galaxy sector has a handful). */
export const MAX_WELCOME_CLEARINGS = 16;
const FieldClearingSchema = z.object({
  x: z.number().finite(), y: z.number().finite(), r: z.number().finite().positive(),
}).strict();

/** Macro terrain C3: a packed field rock key (`rockKey`, u32). */
const RockKeySchema = z.number().int().min(0).max(0xffff_ffff);
/** Consumed rock keys a welcome carries at most (the oldest first). */
export const MAX_WELCOME_CONSUMED_ROCKS = 16_384;
/** `field_consumed` (server → every client, reliable): cut-field rock `k`
 *  was broken up; never cut it whole again. Welcome + these = the set (#16). */
export const FieldConsumedSchema = z.object({ k: RockKeySchema }).strict();
export type FieldConsumedMessage = z.infer<typeof FieldConsumedSchema>;
/** Moved rock poses a welcome carries at most. */
export const MAX_WELCOME_MOVED_ROCKS = 16_384;
/** C2 deep sleep: where moved cut-field rock `k` was left: its body centre
 *  (x, y, game space) and angle `a` (rad), the numbers the server saved. */
export interface FieldRockPose { k: number; x: number; y: number; a: number }
export const FieldRockPoseSchema = z.object({
  k: RockKeySchema, x: z.number().finite(), y: z.number().finite(), a: z.number().finite(),
}).strict();
/** `field_moved` (server → every client, reliable): moved rock `k` was saved
 *  at a new pose, or (`clear: true`) has none any more: it is back at its cut
 *  pose. A broken-up rock sends `field_consumed` instead, which clears it too.
 *  Welcome `cutField.moved` + these = the moved poses (#16). */
export const FieldMovedSchema = z.union([
  FieldRockPoseSchema,
  z.object({ k: RockKeySchema, clear: z.literal(true) }).strict(),
]);
export type FieldMovedMessage = z.infer<typeof FieldMovedSchema>;

/** PR 3a (account-bound identity) — sent to a session immediately before the
 *  server disconnects it because the SAME account logged in from another
 *  device / tab (the newest session takes over the account's playerId). The
 *  client must NOT auto-reconnect on this — it would steal the session back. */
export interface SessionReplacedMessage {
  type: 'session_replaced';
}

/** WebSocket close code used for a `session_replaced` disconnect (4000-4999
 *  is the application range). */
export const SESSION_REPLACED_CLOSE_CODE = 4002;

export {
  WRECK_ID_END,
  MAX_WRECK_PIECE_INDEX,
  WreckDescriptorSchema,
  WreckAddsSchema,
  WreckRemovesSchema,
  WreckSyncSchema,
  isWreckId,
  isWreckDescriptor,
} from './wreckDescriptor.js';
export type { WreckDescriptor, WreckSync } from './wreckDescriptor.js';

/** Campaign 6.1 (anti-patterns review C-core 3) — defensive ingest schema for
 *  `welcome`. The server builds this itself (never parses through it); the
 *  CLIENT `safeParse`s on receipt via `parseWelcome` and drops malformed
 *  payloads before they reach prediction anchoring (`inputTick`, clock
 *  anchor) or the Zustand phase machine — invariant #3's parse-and-drop
 *  contract, previously satisfied by a raw cast. Mirrors the hand-written
 *  `WelcomeMessage` interface exactly; the bidirectional `z.infer` ↔
 *  interface assignability lock in `messages.test.ts` fails `pnpm typecheck`
 *  if they drift. String ids carry the S5 inbound bound (max 64). */
export const WelcomeSchema = z
  .object({
    type: z.literal('welcome'),
    playerId: z.string().min(1).max(64),
    serverTick: z.number(),
    sectorKey: z.string().min(1).max(64).nullable(),
    /** Empty string in engineering rooms — so max-only, no min. */
    shipInstanceId: z.string().max(64),
    spectator: z.boolean().optional(),
    shipScale: z.number().positive().optional(),
    shipTuning: z.enum(['A', 'B']).optional(),
    shipKindScale: z.string().max(256).optional(),
    navalRange: z.enum(['legacy', 'real']).optional(),
    shellEvents: z.literal(true).optional(),
    shellsInFlight: z.array(ShellSalvoSchema).max(256).optional(),
    capitalWrecks: z.literal(true).optional(),
    subcapWrecks: z.literal(true).optional(),
    wrecks: z.array(WreckDescriptorSchema).max(MAX_WELCOME_WRECKS).optional(),
    /** Macro terrain v2 (room flag `cutField`): the field seed. The client
     *  cuts the same rocks from it; none of them ride the wire. */
    cutField: z.object({
      seed: z.string().min(1).max(64),
      clearings: z.array(FieldClearingSchema).min(1).max(MAX_WELCOME_CLEARINGS).optional(),
      consumed: z.array(RockKeySchema).max(MAX_WELCOME_CONSUMED_ROCKS).optional(),
      moved: z.array(FieldRockPoseSchema).max(MAX_WELCOME_MOVED_ROCKS).optional(),
    }).strict().optional(),
  })
  .strict();

/** RTS command layer (slice 10) — server → client: the server just put this
 *  player into COMMAND view (a `startMode: 'command'` join parked their hull as
 *  an AI-flown lingering hull at the arrival flip). The client drops its local
 *  prediction body and enters command view (`pilotMode = 'spectator'`). Sent
 *  once per such join; the snapshot (own hull inactive + a parked hull in `mirror.ships`)
 *  is the state carrier (#16), this only flips the local mode at once. */
export const ControlModeMessageSchema = z
  .object({
    type: z.literal('control_mode'),
    mode: z.enum(['command', 'fly']),
  })
  .strict();

/** Authoritative snapshot broadcast by the server at 20 Hz for client-side
 *  reconciliation. Phase 5c: `obstacles` removed — asteroids and drones now
 *  flow through the binary swarm channel (see `client.send('swarm', buf)`)
 *  instead of being carried on every snapshot.
 *
 *  ── DELIBERATE invariant-#3 CARVE-OUT (campaign 6.1 documents it): this is
 *  the ONE inbound server→client message the client does NOT zod-parse on
 *  ingest. It arrives at 20 Hz carrying the largest payload on the wire
 *  (states map + drones/missiles/structures slices); a full `safeParse`
 *  every 50 ms would allocate + deep-walk the whole object inside the
 *  message-dispatch frame the snapshot coalescer exists to keep light
 *  (invariant #14). The trust argument: the payload is produced by our own
 *  server's `SnapshotBroadcaster` (same repo, schema drift is caught by the
 *  shared TS interface at compile time), and the translator in
 *  `ColyseusClient.handleSnapshot` does defensive per-field reads (optional
 *  chaining + back-fills) rather than trusting deep structure. Anything
 *  LOW-frequency (welcome, roster, combat events, warp warnings) MUST have a
 *  zod schema — do not cite this carve-out for a new message unless it is
 *  both high-cadence AND translator-guarded. */
export interface SnapshotMessage {
  type: 'snapshot';
  serverTick: number;
  /** Server-side `performance.now()` at the moment `client.send('snapshot', ...)`
   *  is called. Client logs this alongside its own `performance.now()` at recv
   *  time so we can directly compute:
   *
   *    networkInTransitMs = clientRecvPerfNow - serverSendPerfNow - clockSkewMs
   *
   *  where `clockSkewMs` is constant per session (uncalibrated but stable).
   *  During a `recv_gap_long` window the right diagnostic question is whether
   *  the gap is **network in-transit** (server kept sending, packets were held
   *  somewhere — WiFi, TCP buffer, OS) or **server side** (server didn't send
   *  for the duration of the gap, then resumed). A burst of post-gap packets
   *  with monotonically-decreasing latencies is network buffering; a single
   *  packet with constant latency after the gap is server-side silence.
   *
   *  plan: imperative-taco-r2 §evidence-instrumentation. Optional for back-
   *  compat (back-fills to 0 on the client's read path). */
  serverSendPerfNow?: number;
  /** Server-side underlying WebSocket `bufferedAmount` (bytes queued at
   *  the WS layer but not yet handed to the OS network stack), sampled
   *  IMMEDIATELY BEFORE `client.send(...)` is called. Diagnostic for the
   *  router-vs-phone question raised after capture 5vjj4e: a non-zero
   *  value during a recv_gap_long event = laptop's WS layer is queueing
   *  (TCP send blocked or slow), so the bottleneck includes the path
   *  from the laptop's network adapter onwards. A zero value during the
   *  same event = packets left the laptop fine, the buffering is
   *  DOWNSTREAM (router/AP/phone). Cheap single-integer field; back-
   *  fills to 0 if absent. */
  wsBufferedAmountBytes?: number;
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
      /** Present on EVERY snapshot while any bit is held; absent = idle
       *  (RTS Part A S1, server `shouldIncludeLastInput`, client
       *  `preResetRemoteShips`). Never deduped: the client drops snapshots. */
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
      /** Weapons/energy/AI overhaul (2026-06-01 §3.2). The ship's current
       *  energy pool, emitted ONLY on the recipient's OWN ship entry (energy
       *  is the local player's predicted resource — remote ships never need
       *  it). Integer-quantised. Absent on every other ship + all remote
       *  recipients (notepack skips `undefined`, same trick as `lastInput` /
       *  `mountAngles`). The client hard-sets `predEnergy` from this on each
       *  snapshot; `energyMax` (the bar denominator) is read from the kind
       *  catalogue client-side, never on the wire. */
      energy?: number;
      /** WS-12 / R2.32 — true when this hull's shield is DOWN (hull exposed).
       *  Emitted for BOTH active AND lingering hulls so the client can render
       *  the shield aura on a parked lingering hull (previously the lingering
       *  mirror entry carried no shield state, so it never showed an aura).
       *  Emit-when-true only (notepack skips `undefined`); absent ⇒ shield up.
       *  Byte-additive — an undamaged sector pays zero extra bytes. */
      shieldDown?: boolean;
      /** Phase 4 (Leveling & XP, WS-0) — this hull's PUBLIC level (≥ 1). Drives
       *  the small level badge rendered on the ship (visible to all) + in the
       *  roster. Emit-only-if-changed (the same emit-if-changed discipline as
       *  `energy`; the broadcaster wiring is owned by WS-B1) — absent ⇒ the
       *  client treats the hull as level 1, so undamaged/un-levelled sectors pay
       *  zero extra bytes. Integer; no `SWARM_WIRE_VERSION` bump (a slim JSON
       *  field on the snapshot states map, like `energy`/`mountAngles`). */
      level?: number;
      /** Phase 4 (Leveling & XP, WS-B2) — the hull's per-instance spent stat
       *  allocation (`statId → points`). Emitted ONLY on the recipient's OWN ship
       *  entry (like `energy`) AND only when non-empty (un-upgraded hulls + every
       *  remote ship omit it — zero byte cost). The client derives the PHYSICS
       *  multipliers from this and re-anchors its predWorld `setStatMultipliers`
       *  so prediction scales movement identically to the server (risk #1 — the
       *  authoritative re-anchor; the `ship_upgrade_applied` echo is just UI
       *  confirmation). No `SWARM_WIRE_VERSION` bump (slim JSON field). */
      statAlloc?: Record<string, number>;
      /** Living World P1a (plan peppy-jumping-pinwheel) — the hull's carried
       *  HOLD (goods / credits / blueprints). OWN active ship only, and only when
       *  non-empty (zero bytes otherwise). This is the AUTHORITATIVE cargo
       *  carrier (invariant #16) — the `loot_collected` message is only a UI
       *  accelerator. Shared reference, replaced only on a discrete transfer.
       *  No `SWARM_WIRE_VERSION` bump (slim JSON field). */
      cargo?: Hold;
      /** Economy v2 W1 — the OWN player's wallet balance (credits are virtual,
       *  one balance per player; emitted on the own active ship's entry). */
      wallet?: number;
      /** v4 T2 — bumped when a teleporter moved this (own, active) hull;
       *  emitted when > 0. A change makes the client re-seed its prediction
       *  at the snapshot pose instead of reconciling a long jump. */
      poseEpoch?: number;
      /** v4 A — this (own, active) ship is DISABLED by an alien gate for this
       *  many more ms (engines and weapons offline); emitted when > 0. */
      disabledMs?: number;
      /** Phase 4 warp-to — 1 spooling, 2 on the run, 3 just dropped out;
       *  absent = idle. PUBLIC (#16): every client draws the build-up and the
       *  arrival. A ship on its run (2) is out of the world: other clients hide
       *  it and drop its collision body; only its own pilot keeps flying it. */
      warp?: 1 | 2 | 3;
      /** Living World P5 — the OWN active ship's fitted blueprint ids (emit-when-
       *  non-empty). Drives the cargo capacity + the upgrade modal's weapon gate. */
      fitted?: string[];
      /** Living World P1a-2 — auto-deposit progress 0..100 (own active ship only;
       *  absent ⇒ not depositing). Drives the HUD deposit ring. */
      depositing?: number;
      /** Fire control (exp/fire-control) — the OWN active pilot's weapon groups:
       *  id, mode (m: 0 auto / 1 manual) and lock queue (t: target key,
       *  s: stage 0 failsafe / 1 acquiring / 2 locked, p: progress 0..100).
       *  Absent ⇒ not a fire-control pilot (or no groups). */
      groups?: Array<{ id: string; m: 0 | 1; l: Array<{ t: string; s: number; p: number; r?: 1; c?: 1; f?: number }> }>;
      /** Fire control — NPCs locking this pilot: `t` = `s:<entityId>`,
       *  `s` 1 acquiring / 2 locked, `p` 0..100. Own pilot only; absent ⇒ none.
       *  At most `LOCKED_BY_WIRE_ROWS` rows: completed locks first, then nearest. */
      lockedBy?: Array<{ t: string; s: 1 | 2; p: number }>;
      /** Fire control — how many NPCs lock this pilot in all, sent only when
       *  more than the `lockedBy` rows (absent ⇒ the rows are everyone). The
       *  HUD banner's count. No `SWARM_WIRE_VERSION` bump (slim JSON field). */
      lockedByN?: number;
      /** Fire control — how many of those hold a COMPLETED lock, sent only
       *  when some are off the `lockedBy` rows (absent ⇒ the locked rows are
       *  all of them). The banner's exact locked count. Slim JSON field. */
      lockedByL?: number;
      /** Phase 4 (Dynamic weapon mounts, WS-B3) — the hull's ACTIVATED latent
       *  mount slots (`{ slotId, weaponId }[]`). PUBLIC (unlike `statAlloc`):
       *  emitted for EVERY ship (active + lingering) that has ≥ 1 activated
       *  mount, so OTHER players see (and the renderer draws) the extra turrets.
       *  Emit-when-non-empty only — un-upgraded hulls omit it (zero byte cost).
       *  The activated mounts' GEOMETRY is looked up CLIENT-SIDE by
       *  `(shipKind, slotId)` from the catalogue — only this slim id/weapon pair
       *  rides the wire (the scrap-collider trick). The per-instance mount list
       *  is `[...kind.mounts, ...activated]`, so `mountAngles[]` (already
       *  variable-length) carries the activated slots' angles WITHOUT a
       *  `SWARM_WIRE_VERSION` bump (it's a slim JSON field on the states map). */
      mounts?: Array<{ slotId: string; weaponId: string }>;
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
  /** Slim per-drone turret + shield slice for in-interest drones (drone-
   *  snapshot-interpolation pivot, 2026-05-18). Drone POSE is NOT here —
   *  it flows exclusively on the binary swarm channel and is rendered via
   *  time-based `interpolateSwarmPose` (no client AI re-sim, no predWorld
   *  reconcile anchor). This slice carries only the non-pose fields that
   *  ride the JSON snapshot: per-mount turret angles and the shield-down
   *  flag. Absent when no in-interest drone has anything to report. `id`
   *  is the dense `u16 entityId` matching the binary swarm channel. */
  drones?: Array<{
    id: number;
    /** Phase: shield — true while this drone's shield is down. Single
     *  channel with the binary recordFlags bit; the client applies the
     *  collider swap from ONE site (syncSwarmIntoPredWorld). */
    shieldDown?: boolean;
    /** Campaign 2.1 (invariant #16) — true while this drone is hostile TO
     *  THE RECIPIENT (the slice is per-recipient, so the bit is viewer-
     *  relative, matching the render tint semantics). The SNAPSHOT BACKSTOP
     *  for the discrete `bot_aggro` accelerant: a mid-wave joiner or a
     *  dropped packet still converges to the correct hostility from the
     *  snapshot stream alone. Emit-when-true — neutral drones add zero
     *  bytes; absence does NOT force-clear (the client ledger's time-decay
     *  owns forgetting, exactly as with the event path). */
    hostile?: boolean;
    /** Charge-up: bit i set while slot mount i charges a CHARGE weapon (or
     *  holds a completed 'when-bearing' charge); the client draws each
     *  weapon's telegraph (`chargeTelegraph`). Emit-when-non-zero; absence
     *  means "not charging". Read from the one server store
     *  (`WeaponMountTicker.charges`). */
    chargingMask?: number;
    /** The server tick the earliest charging mount began charging (present
     *  with `chargingMask`). The telegraph ramps from it on the game clock,
     *  so a late joiner sees the charge at its true progress (#16). */
    chargeStartTick?: number;
    /** Per-mount charge starts (railgun battleships: several main turrets
     *  charging from different ticks): one entry per SET bit of
     *  `chargingMask`, lowest bit first, each that mount's start in ticks
     *  AFTER `chargeStartTick` (0..65535). Emit-when-non-default: absent when
     *  every charging mount began on `chargeStartTick` (a lone charge always). */
    chargeOffsets?: number[];
    /** Take 12 — true while this AI ship's pilot holds the boost key: the
     *  client draws the same boost flame a pilot's ship gets (#16).
     *  Emit-when-true; absence means "not boosting". */
    boost?: boolean;
    /** Living World P4a — a named ELITE's display name (sent every snapshot
     *  while the elite is in interest; absent for ordinary NPCs). */
    elite?: string;
    /** v4 M2 — a garrison's patrol ship: the faction it flies for (clients
     *  tint it). Absent for every other NPC. */
    fac?: string;
    /** W2a NPC warp-to (flagship fleets): 1 spooling, 2 on the run (drawn
     *  hidden, the departure effect plays), 3 just dropped out (the arrival
     *  effect). Absent = not warping. */
    warp?: 1 | 2 | 3;
    /** Hull health PERCENT (0-100 integer) for health-weighted player turret
     *  aim (Part C — the player turret + auto-fire focus the wounded). Emitted
     *  only for DAMAGED in-interest drones (full-HP omit it → client treats
     *  absent as 100 %), so undamaged sectors pay zero extra bytes. Pose still
     *  flows on the binary channel; this is a slim non-pose field like
     *  `shieldDown`/`mountAngles`. */
    hp?: number;
    /** Multi-mount/turret refactor (Phase 4c, 2026-05-11). Per-mount slewed
     *  angle in arc-local frame for this drone, indexed by mount-order in
     *  the ship-kind catalogue. Emitted only for in-interest drones whose
     *  kind has at least one rotating mount (legacy fighter/scout/heavy
     *  drones omit the field — their single 'forward' mount has zero arc
     *  so the angle is always 0 and would only add bytes). Out-of-interest
     *  drones never carry mountAngles; their turrets render at baseAngle
     *  until they re-enter interest and the next snapshot updates them. */
    mountAngles?: number[];
  }>;
  /** WS-4 Phase 6 (R2.23 enabler) — slim resource slice for in-interest MINED
   *  asteroids. POSE/physics flow on the binary swarm channel; this carries only
   *  the finite resource pool the binary wire can't. Emitted ONLY for asteroids
   *  with `resources < resourcesMax` (actively being extracted) so untouched
   *  sectors pay zero bytes — the same emit-when-changed discipline as
   *  `drones[].hp`. NO `SWARM_WIRE_VERSION` bump (JSON slice). `id` is the dense
   *  u16 entityId matching the binary swarm channel; the client joins it to the
   *  swarm mirror by entityId. `mass` is RESERVED (optional) for the WS-9
   *  inspector — the broadcaster doesn't carry body mass today, so it is omitted
   *  for now; resources/resourcesMax are the load-bearing inspector data. */
  asteroids?: Array<{
    id: number;
    resources?: number;
    resourcesMax?: number;
    mass?: number;
  }>;
  /** Heat-seeking missiles in flight within the recipient's spatial-interest
   *  window. Absent when none. Per-recipient AOI-filtered server-side so
   *  distant missiles don't pay for clients who can't see them. Each entry
   *  is an authoritative pose snapshot at `serverTick`; the client mirrors
   *  it into its local missile map and the renderer reads the most recent
   *  two entries for interpolation. Pose flows on this slice (NOT on a
   *  binary channel today — see docs/architecture/missile-simulation.md
   *  "Future: binary promotion" for the upgrade path if wire load grows). */
  missiles?: Array<{
    /** Stable per-sector u32 id; matches `MissileFiredEvent.missileId`. */
    id: number;
    x: number; y: number; vx: number; vy: number; angle: number;
    /** SIGNED angular velocity (rad/s) — `(newAngle − oldAngle) / DT` on the
     *  server tick. Missiles STEER (homing), so linear dead-reckoning of
     *  `vx/vy` between the 20 Hz snapshots flies STRAIGHT while the server
     *  curves → a snap on every ~50 ms arrival (the never-fixed "~20 Hz look",
     *  WS-C #5). The client's MissileMirror integrates `angle += angvel·dt`
     *  during interpolation/extrapolation and RECOMPUTES vx/vy from the curved
     *  angle, so the rendered path tracks the server's homing arc. Optional for
     *  back-compat (back-fills to 0 → identical to the old linear path). */
    angvel?: number;
    /** Owner shooter id (wire form). Lets the renderer route the missile
     *  trail to the correct player/drone for camera-shake source. */
    ownerId: string;
    /** Catalogue weapon id. Discriminator for sprite/trail selection. */
    weaponId: 'heat-seeker';
    /** Remaining life as a fraction [0..1]; 0 = about to expire. Lets the
     *  renderer fade the trail near end-of-life without round-tripping
     *  catalogue lookups. */
    lifePct: number;
  }>;
  /** Plan soft-leaping-truffle v2, A2 — structure grid state moved to ROOM
   *  STATE (`SectorState.structures`: join payload + delta patches); the
   *  snapshot keeps only the fast cosmetics, as flat triples
   *  `[structureEntityId, turretTargetEntityId, miningTargetEntityId]` (-1 =
   *  none) for structures that currently have a target. Absent when none. See
   *  src/shared-types/structureStateWire.ts. Salvage plan PR 11: the one
   *  beam-links encoding, so ship tractor links ride here too, after the
   *  structure triples (src/shared-types/beamLinksWire.ts). */
  structureTargets?: BeamLinks;
  /** Coastal defences (plan coastal-defences) — the server's slewed turret
   *  angles for defence structures that are off their rest bearing, as flat
   *  runs `[structureEntityId, mountCount, q0, q1, …]` with each angle in
   *  milliradians (arc-local, catalogue order). The server is the only writer
   *  (#12); the client eases its drawn barrels toward these. Absent when every
   *  turret rests. See `encodeStructureMountAngles` in structureStateWire.ts. */
  structureMountAngles?: number[];
  /** Shells as events (shell-events.md §5): in-flight shell keyframe records,
   *  round-robin over what this recipient was sent, at most
   *  `SHELL_KEY_PER_SNAPSHOT`. Absent when nothing is due. */
  shellKey?: ShellKeyRecord[];
  /** Wreck descriptors as DELTAS (sub-capital break-up slice 3;
   *  docs/architecture/capital-destruction.md "Wreck descriptors on the
   *  wire"). The full set rides the welcome (`WelcomeMessage.wrecks`). A
   *  snapshot carries the descriptors added within the last
   *  `WRECK_DELTA_WINDOW` broadcasts (one per wreck; a recycled id carries
   *  its new descriptor)... */
  wreckAdds?: WreckDescriptor[];
  /** ...the wreck ids gone within that window (never also in `wreckAdds`)... */
  wreckRemoves?: number[];
  /** ...and, on one snapshot in `WRECK_RESYNC_EVERY`, a resync chunk: the
   *  live wrecks with `lo <= wreckId < hi` are EXACTLY `d` (a client drops
   *  any other id it holds in that range). The chunks walk the id space, so
   *  a client that missed an add or a remove converges (#16). Apply order:
   *  sync, then removes, then adds (deltas are never older than the chunk).
   *  All three are absent-means-no-change: a coalescer that drops a
   *  snapshot must carry them forward. No vertex is on the wire: the client
   *  rebuilds pieces with the shared `wreckPieceGeometry`. */
  wreckSync?: WreckSync;
  /** Game time scale (per sector): this sector's speed and the server tick
   *  it took effect from. Emitted only while the speed isn't 1 (#16: a late
   *  joiner converges from the snapshot alone). Shared object, never copied. */
  timeScale?: TimeScaleKeyframe;
}

/** A sector's game speed keyframe (time scale stream). */
export interface TimeScaleKeyframe {
  /** Speed, 0.25–4. */
  s: number;
  /** Server tick from which `s` applies. */
  fromTick: number;
  /** While the speed is gliding (the dimmer): where it is heading. The client
   *  extrapolates the glide with the shared `glideToward` so its clock moves
   *  in step with the server's. Absent = not gliding. */
  t?: number;
}
