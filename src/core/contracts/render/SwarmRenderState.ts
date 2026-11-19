/**
 * One swarm-channel render entry. Replaces the Phase 1–4 `ObstacleRenderState`:
 * asteroids and drones flow through the binary swarm broadcast and are no
 * longer carried on Colyseus MapSchema. Radius is implied by `kind` (renderer
 * draws asteroids vs drones with their own visuals). Sleeping entries freeze
 * interpolation and stay parked at the last server-shipped pose.
 *
 * Phase 6.5 (jitter mitigation): `poseRing` is the authoritative source of
 * truth for interpolation — a 3-deep circular buffer of recent arrivals,
 * read by `swarmInterpolation` at `now − DISPLAY_DELAY_MS`. The
 * `prev` and `latest` scalars are retained as a bookkeeping shadow of the last
 * two ring writes for callers that still read them directly (e.g. local
 * mode, decoder tests). Renderer code path goes through `interpolateSwarmPose`
 * exclusively — those scalars are no longer read on the hot path.
 */
export interface PoseRingEntry {
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  /** Angular velocity (rad/s). Wire-format v3 — required for client-side AI
   *  lockstep with the server. See `swarmWireFormat.ts` v3 record. */
  angvel: number;
  /** Wall-clock arrival timestamp (performance.now()) of the originating packet. */
  arrivalMs: number;
  /** Server tick of the originating packet — used for ordering when arrivals stack. */
  serverTick: number;
  /** True when the server told us this entity is at rest. */
  sleeping: boolean;
  /** Set to false on initialised slots; true on uninitialised pre-allocated slots. */
  empty: boolean;
}

/** Depth of the per-entity pose ring. Load-bearing invariant: it must hold
 *  ≥ ceil(maxDisplayDelay / minInterArrival) packets + headroom, so the
 *  read point (`now − DISPLAY_DELAY_MS`) always has two *resident*
 *  bracketing arrivals. The binding case is the IN-INTEREST binary
 *  cadence — drones ship ~per server tick (≈ 1000/60 ≈ 16.7 ms), NOT the
 *  50 ms JSON-snapshot rate the old sizing assumed.
 *
 *  Regression history (do NOT shrink this back): the drone
 *  snapshot-interpolation pivot raised `DISPLAY_DELAY_MS` 0 → 100 ms
 *  (Step 4) but left this at 4. ceil(100 / 16.7) = 6, so a 4-deep ring
 *  (~64 ms span) could not reach 100 ms back: `interpolateSwarmPose`
 *  pinned every drone to its stale oldest entry and lurched one
 *  packet-of-motion every 16 ms. Because the kinematic predWorld follower
 *  drives drone COLLISION bodies to that pose inside the player's
 *  prediction world, the player ship jumped and client beam geometry
 *  lagged too — global symptom, this single root cause (smoke cap
 *  2026-05-18T18-56-32-1fc0oe). Locked by the liveness + structural-
 *  invariant tests in `tests/unit/swarmInterpolation.smoothness.test.ts`.
 *
 *  10 = ceil(100 / 16.7)=6 + 4 headroom (arrival jitter + a late packet
 *  not evicting the one still needed). Cheap: ~10 small objects per
 *  entity, pre-allocated once, zero per-packet alloc. Also covers the
 *  adaptive-delay range: the delay only rises toward
 *  ADAPTIVE_DELAY_CEILING_MS when the observed cadence is correspondingly
 *  slower, so the ring still spans it. */
export const POSE_RING_DEPTH = 10;

export interface SwarmRenderState {
  /** Latest pose received from the wire. Mirror of `poseRing[ringHead − 1]`'s pose. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  /** Angular velocity (rad/s). Wire-format v3 — synced from server every
   *  packet so the client's AI sees the same `self.angvel` the server's AI
   *  used. Without this, the AI's `1.5·ω` damping term diverged each tick. */
  angvel: number;
  /** Pose from the previous packet — bookkeeping shadow of `poseRing[ringHead − 2]`. */
  prevX: number;
  prevY: number;
  prevAngle: number;
  /** Wall-clock arrival timestamps (performance.now()) for the prev/latest pair. */
  prevArrivalMs: number;
  latestArrivalMs: number;
  /** Phase 6.5 — fixed 3-deep circular buffer of recent poses, read by the
   *  display-delay interpolator. Entries are pre-allocated; `empty` flag
   *  distinguishes initialised slots from pre-allocated holes. */
  poseRing: PoseRingEntry[];
  /** Index of the next slot to write in `poseRing`. Wraps mod POSE_RING_DEPTH. */
  ringHead: number;
  /** Collision radius. Renderer draws asteroids as circles of this size. */
  radius: number;
  /** 0 = asteroid, 1 = drone, 2 = structure, 3 = scrap, 4 = wreck piece. */
  kind: number;
  /** Ship-kind id when `kind === 1` (drone). Drives the drone silhouette +
   *  colour on the renderer; absent for asteroids. Resolved from the wire's
   *  u8 catalogue index by the decoder. For `kind === 3` (scrap) this carries
   *  the PARENT ship-kind id (the composite the scrap broke off of). */
  shipKind?: string;
  /** Scrap-component index when `kind === 3` (scrap) — selects which scrap
   *  group of the parent ship-kind (`shipKind`) this piece is, i.e. the index
   *  into `shipScrapGroups(shipKind)`. Decoded from the wire's trailing u8;
   *  absent for every other kind. */
  componentIndex?: number;
  /** Capital wreck piece (`kind === 4`, wire v5): the wreck it belongs to — the
   *  key of `RenderMirror.wrecks`. `componentIndex` is its piece index and
   *  `shipKind` the parent capital. Absent for every other kind. */
  wreckId?: number;
  /** P2c — an asteroid's resource ('ice' | 'crystal'; absent ⇒ rock). */
  asteroidResource?: string;
  /** Asteroid (`kind === 0`, wire v6): its u16 shape seed, the one input
   *  (with `radius`) of its outline on both sides. Absent for other kinds. */
  shapeSeed?: number;
  /** An awake cut-field rock (`kind === 0`, wire v7 flag FIELD_ROCK): its
   *  rock key. Its outline is the client's own cut of that rock, not
   *  `shapeSeed`'s. Absent for every other entity. */
  fieldKey?: number;
  /** Phase: shield — true while this drone's shield is down (hull
   *  exposed). Decoded from swarm recordFlags bit 1 and kept consistent
   *  for in-interest drones by the snapshot drones[] loop. */
  shieldDown?: boolean;
  /** True when this drone's AI behaviour currently treats the local player
   *  as a hostile target. Populated each frame by the consumer (e.g.
   *  `ColyseusGameClient.updateMirror` via `AiController.isEntityHostileToPlayer`)
   *  — drives the radar's hostile-vs-idle colouring + glow. Absent on
   *  asteroids and on drones whose AI hasn't been hit yet. */
  isHostileToLocal?: boolean;
  /** Hull health FRACTION (0..1) for this drone, decoded from the snapshot
   *  `drones[].hp` percent (Part C — health-weighted player turret aim /
   *  auto-fire). Absent ⇒ treated as 1 (full): the server omits `hp` for
   *  undamaged drones. Low-cadence (snapshot rate), not per-frame. */
  healthFrac?: number;
  /** Charge-up: bit i set while slot mount i charges (snapshot
   *  `drones[].chargingMask`; 0 / absent = none). Drives the one charge
   *  telegraph. Snapshot cadence. */
  chargingMask?: number;
  /** Server tick the earliest charge began (snapshot `drones[].chargeStartTick`);
   *  the telegraph ramps from it on the game clock. */
  chargeStartTick?: number;
  /** Per-mount starts as ticks after `chargeStartTick`, one per set bit of
   *  `chargingMask` (snapshot `drones[].chargeOffsets`); absent = every
   *  charging mount began on `chargeStartTick`. */
  chargeOffsets?: readonly number[];
  /** This AI ship's pilot holds the boost key (snapshot `drones[].boost`).
   *  Drives the same boost flame a pilot's ship gets. Snapshot cadence. */
  boosting?: boolean;
  /** Living World P4a — a named ELITE's display name (snapshot `drones[].elite`).
   *  Drives the gold label + ring. Snapshot cadence. */
  eliteName?: string;
  /** v4 M2 — a garrison's patrol ship: the faction it flies for (snapshot
   *  `drones[].fac`). The sprite takes the faction's colour. */
  faction?: string;
  /** W2a NPC warp-to (snapshot `drones[].warp`): 1 spool, 2 run (sprite
   *  hidden, departure drawn), 3 just arrived. Same meaning as
   *  `ShipRenderState.warp`; the renderer feeds both to WarpFx. */
  warp?: 1 | 2 | 3;
  /** Mineable resource pool for an asteroid (kind 0), decoded from the snapshot
   *  `asteroids[]` slice (WS-4 Phase 6 / R2.23 enabler). The server emits these
   *  ONLY for MINED in-interest asteroids (`resources < resourcesMax`), so
   *  absent ⇒ untouched/full. Feeds the WS-9 inspector's remaining-fraction
   *  readout. Low-cadence (snapshot rate), not per-frame. */
  resources?: number;
  resourcesMax?: number;
  /** Per-mount rotation angle, ship-relative AND already biased past
   *  `mount.baseAngle`. Indexed by catalogue mount-order. Multi-mount/
   *  turret refactor Phase 4c (2026-05-11): authoritative angles arrive in
   *  the snapshot's `drones[]` slice for in-interest drones with rotating
   *  mounts. Out-of-interest drones leave it undefined (renderer falls
   *  back to baseAngle). Same field shape as `ShipRenderState.mountAngles`. */
  mountAngles?: number[];
  /** The angles to DRAW: `mountAngles` (20 Hz snapshots) carried forward
   *  at the turret's turning rate each frame, so turrets turn smoothly
   *  (client `displayMountAngles.ts`). Renderer prefers it when present. */
  displayMountAngles?: number[];
  /** Follower state for `displayMountAngles` (renderer ignores these). */
  _dmRef?: number[];
  _dmBase?: number[];
  _dmRate?: number[];
  _dmSince?: number;
  _dmInterval?: number;
  /** True when the server told us this entity is at rest. Renderer keeps the sprite static. */
  sleeping: boolean;
  /** Server tick of the most recent packet that included this entity. */
  lastUpdateTick: number;
}
