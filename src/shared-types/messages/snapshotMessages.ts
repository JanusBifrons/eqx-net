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

/** Authoritative snapshot broadcast by the server at 20 Hz for client-side
 *  reconciliation. Phase 5c: `obstacles` removed — asteroids and drones now
 *  flow through the binary swarm channel (see `client.send('swarm', buf)`)
 *  instead of being carried on every snapshot. */
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
  /** Placed structures' slow-moving grid state (structures plan, Phase 3).
   *  Slim + low-cadence (rebuilt at the 1 Hz pulse, not per tick); the same
   *  array reference is attached to every recipient. POSE is NOT here — a
   *  structure is a kind=2 swarm entity, so its x/y/radius/subtype flow on the
   *  binary swarm channel. This slice carries only what the binary wire can't:
   *  the connector web + power/construction state. Absent when no structures
   *  exist (zero cost otherwise). `id` is the dense `u16 entityId` matching the
   *  binary swarm channel — so the client joins this slice to the swarm mirror
   *  (which carries the pose) by entityId. */
  structures?: Array<{
    id: number;
    /** Component net power ≥ 0 AND reachable to a Capital. */
    powered: boolean;
    /** Component net power (Σ output − Σ consumption over built members). */
    netPower?: number;
    /** Connected neighbour entityIds — draws the web on the client. */
    connTo?: number[];
    /** Minerals currently stored (Capital bank; omitted when 0). */
    minerals?: number;
    /** True once fully constructed. */
    built?: boolean;
    /** Construction fraction [0..1]; sent ONLY while `!built` (drives the
     *  scaffolding fill-bar), omitted once complete to keep the slice small. */
    buildPct?: number;
    /** Deconstruction fraction [0..1] while reclaiming; omitted otherwise. */
    deconstructPct?: number;
    /** Phase 4 — the asteroid entityId a Miner is extracting from (draws the
     *  mining beam). Present only on actively-mining miners. */
    miningTargetId?: number;
    /** Phase 5 — the drone entityId a Turret is aiming at (draws the aim line;
     *  the fire beam itself arrives as a discrete `laser_fired`). */
    turretTargetId?: number;
    /** Batteries plan — current stored power (Battery only; omitted on every
     *  other kind). Drives the inspector charge readout. */
    storedPower?: number;
    /** Batteries plan — the Battery's `powerStorageCapacity` (the readout
     *  denominator). Present only alongside `storedPower`. */
    storedPowerMax?: number;
  }>;
}
