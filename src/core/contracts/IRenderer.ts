export interface ShipRenderState {
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  /** Ship-kind id (`'scout' | 'fighter' | 'heavy' | …`) hydrated from the
   *  Colyseus `ShipState.kind` field. The renderer reads this once when the
   *  Pixi sprite is built and uses the corresponding `ShipKind.shape` to
   *  draw the polygon silhouette + colour. Optional for back-compat with
   *  callers / tests that pre-date the ship-kind feature; the renderer falls
   *  back to the catalogue default when missing. */
  kind?: string;
  /** Player display name (or email fallback). Empty string for anonymous
   *  players; absent for sources that don't carry it. The renderer's
   *  `LabelManager` uses this to render a small text label above remote
   *  ships. The local player's own ship intentionally has no label. */
  displayName?: string;
  /** Per-mount current rotation angle, ship-relative AND already biased
   *  past `mount.baseAngle` (so 0 = barrel at rest, +π/6 = barrel slewed
   *  to +π/6 above its base angle). Indexed by mount-order in the
   *  ship-kind catalogue. Multi-mount/turret refactor (Phase 4b.2):
   *  client-side rotation preview populates this for the local player
   *  only; remote players leave it undefined and the renderer falls
   *  back to baseAngle (static barrels). Phase 4b.3 will populate it
   *  for every ship from server-authoritative snapshot data. */
  mountAngles?: number[];
  /** Effects subsystem (plan `wiggly-puppy` M2): true ⇒ shield down (hull
   *  exposed). Populated by `ColyseusClient.handleSnapshot` from the wire's
   *  per-state `shieldDown` flag (or derived from `shieldPct <= 0`). Mirrors
   *  the existing `swarm[].shieldDown` field — collapses player + drone
   *  shield aura state to "one optional bool per render entry", one
   *  ownership site per renderer-visible state. */
  shieldDown?: boolean;
}

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
  /** 0 = asteroid, 1 = drone. */
  kind: number;
  /** Ship-kind id when `kind === 1` (drone). Drives the drone silhouette +
   *  colour on the renderer; absent for asteroids. Resolved from the wire's
   *  u8 catalogue index by the decoder. */
  shipKind?: string;
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
  /** True when the server told us this entity is at rest. Renderer keeps the sprite static. */
  sleeping: boolean;
  /** Server tick of the most recent packet that included this entity. */
  lastUpdateTick: number;
}

/**
 * Structure grid state (structures plan, Phase 3). Mirrored from
 * `SnapshotMessage.structures[]`, keyed by the same entityId as `swarm` (which
 * holds the pose). Drives the connector web, the scaffolding fill + dim, and the
 * HUD power readout. Pure UI state — no spatial fields (those live in `swarm`).
 */
export interface StructureRenderState {
  /** Component net power ≥ 0 AND reachable to a Capital. */
  powered: boolean;
  /** Component net power (Σ output − Σ consumption over built members). */
  netPower: number;
  /** Connected neighbour entityIds — the web edges. */
  connTo: number[];
  /** True once fully constructed (blueprints render dimmed until then). */
  built: boolean;
  /** Construction fraction [0..1] (1 when built) — drives the fill-bar. */
  buildPct: number;
  /** Deconstruction fraction [0..1] while reclaiming (0 normally). */
  deconstructPct: number;
  /** Phase 4 — asteroid entityId a Miner is extracting from (draws the beam),
   *  or undefined. */
  miningTargetId?: number;
  /** Phase 5 — drone entityId a Turret is aiming at (draws the aim line), or
   *  undefined. */
  turretTargetId?: number;
  /** Batteries plan — current stored power (Battery only; undefined elsewhere). */
  storedPower?: number;
  /** Batteries plan — the Battery's stored-power capacity (readout denominator). */
  storedPowerMax?: number;
  /** Shield-fence plan — the paired pylon's entityId this Shield Pylon projects
   *  a wall span to (undefined when unpaired). Joined to `mirror.swarm` for the
   *  pair's pose to draw + predict the span. */
  shieldWallTo?: number;
  /** Shield-fence plan — whether that wall is currently blocking (active). */
  wallActive?: boolean;
}

/** Depth of the per-missile pose ring (playtest 2026-06-10 Issue 11). Sized to
 *  cover MISSILE_DISPLAY_DELAY_MS (+ jitter headroom) at the 20 Hz JSON snapshot
 *  cadence (~50 ms): 100 ms back ≈ 2 intervals, +headroom for the 100–200 ms
 *  jitter band the smoke captures showed → 6 keeps two bracketing samples
 *  available so the hot path is a genuine lerp of buffered truth (mirrors the
 *  drone POSE_RING_DEPTH sizing rule). */
export const MISSILE_POSE_RING_DEPTH = 6;

/**
 * Heat-seeking missile render state. Latest authoritative pose plus a per-missile
 * pose RING (playtest 2026-06-10 Issue 11) so the renderer interpolates between
 * BUFFERED authoritative poses at `now − displayDelay` — total immunity to
 * wire-arrival jitter — instead of dead-reckoning a stale velocity past the
 * latest snapshot (which diverged from the homing curve on a tight turn and
 * snapped each packet = the "~20 Hz look"). Same pattern as drones
 * (`swarmInterpolation.ts`), reusing `PoseRingEntry`.
 *
 * One-pose-per-frame contract: any consumer (sprite, trail emitter,
 * camera-shake source) MUST read the resolved `x/y/angle` via
 * `resolveMissileDisplayPose()`, not re-walk the ring. Mirrors the drone
 * one-pose rule in src/client/CLAUDE.md.
 */
export interface MissileRenderState {
  /** Stable per-sector u32 id from the snapshot. */
  id: number;
  /** Latest authoritative pose (the newest ring sample, mirrored for the
   *  count-1 / first-frame fast path + stale reads). */
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  /** Pose ring of recent authoritative arrivals (newest by `arrivalMs`).
   *  `resolveMissileDisplayPose` brackets `now − displayDelay` within it. */
  poseRing: PoseRingEntry[];
  /** Next ring write slot (cycles 0..MISSILE_POSE_RING_DEPTH-1). */
  ringHead: number;
  /** Arrival timestamp (renderer clock) of the latest pose — stale-eviction. */
  latestArrivalMs: number;
  /** Server tick of the latest snapshot — for stale-eviction logic. */
  lastUpdateTick: number;
  /** Owner shooter id (wire form). Renderer routes camera-shake
   *  source-vector to this id if it's the local player. */
  ownerId: string;
  weaponId: 'heat-seeker';
  /** Remaining life as a fraction [0..1]. Renderer fades the trail near
   *  end-of-life. */
  lifePct: number;
}

export interface ProjectileRenderState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ownerId: string;
  /** true for client-predicted ghosts that haven't been server-confirmed yet */
  isGhost?: boolean;
  /** 0–1 opacity for fade-out effect */
  alpha?: number;
  /** When present, render as an instant beam line from (x,y) to (toX,toY) rather than a moving dot. */
  beam?: { toX: number; toY: number };
  /** Weapon catalogue id — drives visual style (e.g. 'laser' → bolt graphic). */
  weaponId?: string;
}

/**
 * Phase 4 — abandoned-ship wreck. Ownerless hull drifting in a sector;
 * destructible, no AI, no player. Identity (kind, health, maxHealth)
 * arrives via the Colyseus schema diff on `state.wrecks`; per-frame
 * pose arrives in `SnapshotMessage.wrecks` and is mirrored here.
 */
export interface WreckRenderState {
  shipInstanceId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  angvel: number;
  kind: string;
  health: number;
  maxHealth: number;
}

export interface RenderMirror {
  ships: Map<string, ShipRenderState>;
  /** Phase 4 — abandoned ship wrecks. Keyed by shipInstanceId UUID. */
  wrecks?: Map<string, WreckRenderState>;
  /** Phase 6b — lingering player hulls (isActive=false on the wire).
   *  These are NOT in `mirror.ships` (which is playerId-keyed and would
   *  collide with a player's currently-piloted hull). The renderer iterates
   *  this map separately and draws with the same grey-ish tint as wrecks
   *  to signal "this hull is parked but still belongs to a real player".
   *  Pose fields populated from `SnapshotMessage.states[*]` entries whose
   *  `isActive === false`; identity (kind, displayName) carried alongside. */
  lingeringShips?: Map<string, ShipRenderState & { ownerPlayerId: string }>;
  /**
   * Swarm entities (asteroids + drones) shipped via the binary swarm channel.
   * Keyed by the server's dense u16 entityId. Sleeping entries remain in the
   * map at their last-shipped pose and the renderer freezes interpolation.
   */
  swarm?: Map<number, SwarmRenderState>;
  /** Structures plan, Phase 3 — slow-moving grid state for placed structures,
   *  keyed by the SAME dense entityId as `swarm` (the structure's POSE lives in
   *  `swarm`; this carries the grid web + power/construction state). Mirrored
   *  from `SnapshotMessage.structures[]`. The renderer joins by entityId to draw
   *  the connector web + scaffolding fill + dim unbuilt blueprints. */
  structures?: Map<number, StructureRenderState>;
  /** Structures plan, Phase 3 — connection flash windows from the discrete
   *  `grid_pulse` event. Key is the sorted entityId pair packed as
   *  `min * 65536 + max` (numeric ⇒ no per-frame string-key allocation in the
   *  renderer); value is the `performance.now()` ms until which the segment
   *  renders "flowing". */
  gridFlashes?: Map<number, number>;
  /** Projectiles: both server-authoritative and client ghost entries. */
  projectiles?: Map<string, ProjectileRenderState>;
  /** In-flight heat-seeking missiles. Server-authoritative pose mirrored
   *  from `SnapshotMessage.missiles[]` (per-recipient AOI-filtered).
   *  Keyed by the stable per-sector missileId. The renderer draws the
   *  missile sprite + trail + reads `lifePct` for end-of-life fade.
   *  Entries are removed when (a) `missile_detonated` arrives, or (b)
   *  the missile vanishes from a full snapshot (eviction). */
  missiles?: Map<number, MissileRenderState>;
  localPlayerId: string | null;
  /** The local player's ACTIVE ship's shipInstanceId (from the `welcome`
   *  message). A displaced player owns BOTH a lingering hull and a new active
   *  ship under the same `playerId`, so own-ship identification must key on
   *  this — NOT just `localPlayerId` — to avoid binding the local view to the
   *  stale lingering hull. Null until welcome. */
  localShipInstanceId?: string | null;
  /** Floating damage numbers to spawn this frame. Drained + cleared each
   *  frame. `targetId` groups hits to the same entity so the renderer's
   *  accumulator can sum them into one floating number (plan: melodic-
   *  engelbart Step 4 — was N parallel numbers, now 1-per-target
   *  growing). `tag` (weapon-hit-prediction Phase 2) is the originating
   *  `clientShotId` for client-PREDICTED numbers, so a later mispredict /
   *  rollback / TTL-expiry can hard-cancel exactly that number's
   *  contribution via `pendingDamageNumberCancels`. Authoritative (server
   *  `DamageEvent`) numbers leave `tag` undefined. Plain strings ⇒
   *  structured-clone-safe across the renderer→worker boundary. */
  pendingDamageNumbers?: Array<{ targetId: string; x: number; y: number; damage: number; tag?: string }>;
  /** Predicted damage-number tags to hard-cancel this frame (weapon-hit-
   *  prediction Phase 2). The renderer drains it and calls
   *  `DamageNumberManager.cancelByTag(tag)` for each — the rollback /
   *  TTL-expiry channel, mirroring the `pendingDamageNumbers` drain
   *  pattern. Cleared + drained each frame. */
  pendingDamageNumberCancels?: string[];
  /** Health bar hit events this frame. Drained + cleared each frame.
   *  `shieldPct` is optional — when present (and the entity has any
   *  shield max > 0), `HealthBarManager` renders a two-segment bar
   *  with shield ABOVE hull so shield damage is visible. Without
   *  this, drones/bots' shield hits look like "zero damage" because
   *  hull stays at 100% while shield absorbs (no per-entity HUD
   *  ShieldHullBar exists for them — the on-hit bar is the only
   *  shield-damage feedback). */
  pendingHealthBarHits?: Array<{ entityId: string; healthPct: number; shieldPct?: number }>;
  /** Remote warp events (`warp_in` / `warp_out` broadcasts from the
   *  server) to play this frame. The renderer drains the array and
   *  fires `triggerWarpIn` at each `(x, y)` — same one-shot flash +
   *  burst ripple for both directions. Cleared + drained each frame. */
  pendingWarpEvents?: Array<{ x: number; y: number }>;
  /** Missile detonations to play this frame. The renderer drains the
   *  array, spawns explosion VFX at each `(x, y)`, sizes the sprite to
   *  `splashRadius`, and triggers a camera shake with magnitude inverse
   *  to distance-from-camera (with a min-distance floor to prevent
   *  divide-by-zero / point-blank shake explosion). Cleared each frame. */
  pendingMissileExplosions?: Array<{
    x: number;
    y: number;
    splashRadius: number;
    missileId: number;
  }>;
  /** Effects subsystem (plan `wiggly-puppy` M2): one-shot effect-trigger
   *  drain queue, populated by `ColyseusClient` (impact sparks via
   *  `handleDamage`, destruction via the existing `explodingShips` drain
   *  path) and consumed by `PixiRenderer.update(mirror)` which forwards
   *  each entry to `IEffects.spawnBurst` / `triggerOneShotFilter`.
   *
   *  CLEAR DISCIPLINE (load-bearing): cleared INSIDE `consumeOneFrameTriggers`
   *  in `src/client/render/perFrameTriggers.ts`, gated on `shouldRender` —
   *  same skip-frame gate as `explodingShips`. A clear without a preceding
   *  `renderer.update(...)` silently drops every trigger in the queue.
   *  Regression lock: `perFrameTriggers.test.ts`. */
  pendingEffectTriggers?: Array<{
    kind:
      | 'impact'
      | 'destruction'
      | 'shield-hit'
      | 'warp-arrive'
      | 'destruction-shock'
      | 'shield-flash';
    worldX: number;
    worldY: number;
    intensity?: number;
    tint?: number;
    entityId?: string;
  }>;
  /**
   * When present, the renderer draws a semi-transparent ghost at this position to
   * show the raw server snapshot position (before client-side prediction replay).
   * Lets you visually confirm whether the server and client are diverging.
   */
  serverGhostPos?: { x: number; y: number } | null;
  /**
   * Structure placement preview (smoke handoff 2026-06-06, Issue 5). When the
   * player is in placement mode the renderer draws a translucent silhouette of
   * the chosen structure kind at the computed ahead-of-ship world pose, and
   * projects that pose to screen for the world-anchored confirm. Spatial data
   * → it lives HERE in the render mirror, NOT Zustand (invariant #2); only the
   * discrete `placementKind` id stays in Zustand. `null`/absent ⇒ no preview.
   * `kind` is a StructureKindId; `x`/`y` are GAME-space (Y-up); `angle` rad.
   * Structured-cloneable (plain object) so it crosses the worker boundary.
   */
  pendingPlacementPreview?: { kind: string; x: number; y: number; angle: number; pending?: boolean } | null;
  /** Ships currently flashing due to recent damage (set of player IDs). */
  damagedShips?: Set<string>;
  /** Ships that just exploded (single-frame trigger). */
  explodingShips?: Set<string>;
  /** Ships currently holding shift-boost AND thrust. Server-authoritative —
   *  rebuilt on every snapshot. Renderer draws an exhaust trail for each. */
  boostingShips?: Set<string>;
  /** Ships currently holding thrust (any acceleration, regardless of boost).
   *  Strict superset of `boostingShips`. Server-authoritative. Renderer
   *  draws a baseline thrust flame for each; the boost flame layers on top
   *  for ships that are also in `boostingShips`. */
  thrustingShips?: Set<string>;
  /**
   * Live hitscan beam state, **per mount**. Carries only the hit distance and
   * target id for each beam; the renderer derives the beam's geometry from
   * the local ship's lerped pose in `ships[localPlayerId]` plus each mount's
   * local offset each frame so beams stay glued to the ship during
   * prediction-correction lerps. Empty (not present in the map) when a mount
   * is not firing this frame. Cleared wholesale when the player releases the
   * fire trigger or switches to a projectile weapon.
   *
   * Multi-mount/turret refactor (Phase 2c, 2026-05-11): replaces the single
   * `liveBeam` field. For legacy single-mount fighter/scout/heavy the map
   * has exactly one entry keyed by `'forward'`.
   */
  liveBeams?: Map<string, { dist: number; hitId?: string }>;
  /** When false, the renderer hides the orange server-ghost diamond. Default true. */
  showServerGhost?: boolean;
  /**
   * Server-authoritative beams from remote shooters (players and drones).
   * Keyed by `shooterId`, with a nested map keyed by `mountId` so multi-mount
   * shooters can carry one entry per barrel simultaneously without each new
   * mount's beam clobbering the previous one (the pre-2c structure was a
   * single beam per shooter, which dropped all-but-the-last on multi-mount
   * fires). For player shooters, the renderer derives geometry from the
   * shooter's live pose in `mirror.ships` plus the firing mount's local
   * offset each frame, so the beam sweeps with rotation; for non-ship
   * shooters (drones — not in `mirror.ships`), the renderer falls back to
   * the server-shipped `fromX/fromY/toX/toY` endpoints.
   *
   * Legacy single-mount ships emit one event with `mountId === 'forward'`
   * (or absent — pre-2c clients accept either and synthesise the same key).
   */
  remoteLasers?: Map<string, Map<string, {
    range: number;
    hit: boolean;
    targetId?: string;
    expiresAt: number;
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
  }>>;
}

/**
 * Renderer → main-thread feedback channel.
 *
 * The renderer writes this once per frame at the end of `update()`. The
 * caller reads it synchronously after each `update()` returns. This is
 * a closed-set of fields — adding a new one requires a phase-gate
 * review because every entry expands the worker → main per-frame
 * postMessage payload once the renderer moves off the main thread.
 *
 * **In the worker future** (see plan
 * `~/.claude/plans/humble-strolling-coral.md` Phase 2 / Phase 4):
 * the renderer lives in a Web Worker; this struct travels back to the
 * main thread via a FEEDBACK postMessage each frame and the main-thread
 * proxy caches it. Sync `getFeedback()` reads from the cache.
 *
 * Fields are kept primitive / structured-cloneable so the future
 * postMessage hop costs nothing.
 */
export interface RendererFeedback {
  /**
   * Per-ship mount-sprite count. E2E test attribute `data-mount-count`
   * reads this (looks up the local ship by id). Test-only surface —
   * not consumed by gameplay logic.
   */
  mountCounts: Map<string, number>;
  /**
   * Count of currently-visible off-screen halo arrows (HaloRadar).
   * E2E test attribute `data-haloArrowCount` reads this.
   */
  haloArrowCount: number;
  /**
   * Number of floating damage-number texts currently alive (spawned
   * but lifetime not yet expired). Lets integration tests observe
   * spawn → tick → expiry without needing pixel-level rendering
   * assertions. Lifetime = 60 frames; at the worker's 30 Hz mirror
   * cadence that's 2 s of wall-clock.
   */
  damageNumberActiveCount: number;
  /**
   * Number of currently-mounted wreck sprites. Lets integration tests
   * observe wreck rendering lifecycle (mount when entering mirror.wrecks,
   * unmount when leaving) without needing pixel-level rendering
   * assertions. Mirrors `damageNumberActiveCount` for the wreck
   * sprite path.
   */
  wreckSpriteCount: number;
  /**
   * Latches `true` the first time the renderer's `update()` runs with a
   * non-null `mirror.localPlayerId` AND `mirror.ships.size > 0`. Stays
   * true for the lifetime of the renderer instance.
   *
   * Drives the join-render readiness gate (`useGameReady` + WarpScreen
   * overlay) so the player never sees the partial-mount state between
   * MUI HUD render and the first frame with the local ship at its
   * correct pose. The main thread also observes the false→true
   * transition to fire the `pixi_first_frame` diagnostic event.
   */
  firstFrameRendered: boolean;
  /**
   * World-space origin of the local player's first live hitscan beam as
   * ACTUALLY DRAWN this frame (the `BeamSpritePool` sprite transform),
   * or `null` when no live beam is on screen. E2E test attribute
   * `data-beam-rendered-from-x/y` reads this.
   *
   * Distinct from `data-beam-from-x/y` (which RECOMPUTES the origin from
   * the live ship pose in `gameRafLoop`): that recompute tracks the ship
   * perfectly and passes even when the drawn beam is frozen, so it cannot
   * catch the render-cache detach bug (smoke handoff 2026-06-06, Issue 1
   * Bug #1). Reading the real sprite transform is the only observable that
   * fails when the beam stops being redrawn. Test-only surface — not
   * consumed by gameplay logic.
   */
  liveBeamRenderedFromX: number | null;
  liveBeamRenderedFromY: number | null;
  /**
   * Screen-space (CSS px, canvas-relative) projection of the current structure
   * placement preview pose (`RenderMirror.pendingPlacementPreview`), or `null`
   * when there's no preview / it's off-screen. Lets the world-anchored
   * placement confirm (`StructurePlacementBanner`) sit at the blueprint's
   * on-screen position instead of a fixed HUD slot (smoke handoff 2026-06-06,
   * Issue 5). Published as `data-placement-screen-x/y`. Test-only / UI-position
   * surface — not consumed by gameplay logic.
   */
  placementScreenX: number | null;
  placementScreenY: number | null;
  /**
   * Tap/drag-to-position placement (2026-06-07). The renderer owns the
   * pointer-follow because it holds the camera (`screenToWorld`) and sees
   * pointer events on BOTH the main-thread and worker paths.
   * `placementChosenWorldX/Y` is the GAME-space point the blueprint is being
   * positioned at (pointer-driven; falls back to the ahead-of-ship preview
   * before the player interacts) — read by the Confirm send. `placementStuck`
   * is true once the pointer is released (the ghost is parked) — the Confirm
   * banner is shown only then, so it never sits under a dragging finger.
   * Both `null`/`false` when not in placement mode.
   */
  placementChosenWorldX: number | null;
  placementChosenWorldY: number | null;
  placementStuck: boolean;
  /**
   * Structure placement connection-range preview (structures follow-up Item C).
   * The number of existing structures the placement ghost WOULD connect to if
   * placed at its current position — computed by the `ConnectorRenderer` preview
   * pass with the SAME obstacle-aware `canConnect` the server runs on placement
   * (so the preview matches reality). `0` when there is no active preview or the
   * ghost is out of range / blocked from every hub. Published as
   * `data-placement-preview-conn-count`. Test-only / UI-affordance surface — not
   * consumed by gameplay logic.
   */
  placementPreviewConnectionCount: number;
  /**
   * Click-to-inspect selection (structures follow-up Item B2). The renderer
   * owns the selected entity (set on a gameplay tap that resolves to an
   * entity via `pickEntityAt`, toggled off on re-tap, cleared on empty-space
   * tap) and publishes its id here so the main thread can mirror it into the
   * discrete Zustand `selectedEntityId` (panel visibility). `null` when nothing
   * is selected. The id form matches the `HealthBarManager` lookup convention:
   * `playerId` for a ship, `swarm-<entityId>` for a drone/structure,
   * `shipInstanceId` for a wreck. Non-spatial / UI-affordance surface — not
   * consumed by gameplay logic.
   */
  selectedPickId: string | null;
  /** Kind of the selected entity (drives the stats-channel routing: only
   *  `ship`/`structure` use the server `entity_stats` channel; `drone`/`wreck`
   *  read health from the mirror directly). `null` when nothing is selected. */
  selectedPickKind: 'ship' | 'drone' | 'structure' | 'wreck' | null;
  /**
   * Number of mining beams (`laser_fired` with `mountId === 'drill'`) currently
   * drawn in the DEDICATED amber mining-beam pool (`_miningBeamPool`), as
   * ACTUALLY rendered this frame (the pool's `liveCount`). WS-4 Phase 4 / R2.27.
   *
   * A dedicated pool (separate from the combat `_remoteBeamPool`) is what lets
   * an E2E isolate the mining beam — `liveBeamRenderedFromX` / the shared remote
   * pool can't distinguish a drill beam from a turret/laser beam. Published as
   * `data-mining-beam-count`. Reads the real drawn-sprite count, never a
   * recompute (the "test observable reads actual output" rule). Test-only
   * surface — not consumed by gameplay logic.
   */
  miningBeamCount: number;
}

export interface IRenderer {
  // Container is typed as unknown here so core stays DOM-free.
  // Client implementations narrow it to HTMLElement.
  init(container: unknown): Promise<void>;
  update(mirror: RenderMirror): void;
  /**
   * Attach a screen-space overlay layer to the renderer's stage, above the
   * world viewport. Used by the in-game galaxy-map overlay (Map B) — a
   * Pixi `Container` of hex graphics that the consumer constructs and hands
   * to the renderer at bootstrap. The renderer simply parents the container;
   * it never imports galaxy code, preserving the DI seam.
   *
   * `overlay` is typed as `unknown` so this contract stays Pixi-free; the
   * concrete `PixiRenderer` narrows it to `Container`.
   */
  addOverlayContainer(overlay: unknown): void;
  /**
   * Read the most recent feedback the renderer wrote at the end of its
   * last `update()` call. See `RendererFeedback`.
   *
   * Today: backed by an in-renderer field (sync update). Future
   * (worker migration): backed by a main-thread cache populated by
   * FEEDBACK postMessage from the renderer worker.
   */
  getFeedback(): RendererFeedback;
  /**
   * Pixi ticker FPS cap.
   *  - `undefined` ⇒ uncapped (production default).
   *  - finite number ⇒ throttle to that FPS.
   *  - `null` ⇒ pause the ticker entirely. Used by `App.tsx` under
   *    Playwright (`navigator.webdriver`) when a UI overlay covers the
   *    game surface, so the renderer stops competing with the CDP loop
   *    for the main thread.
   */
  setTickerMaxFPS(fps: number | null | undefined): void;
  /**
   * Toggle the "warp mode" render state. While `active === true`, the
   * renderer paints an over-the-top FTL-warp visual ON THE SAME canvas
   * as gameplay — heavy blur + green color shift on the world
   * container plus animated radial streaks drawn directly on stage.
   *
   * Driven by `useGameReady`: enabled the moment `renderer.init()`
   * resolves; disabled when the player can see themselves
   * (`rendererFirstFrameRendered` latches). The renderer animates a
   * 500 ms fade-out internally — callers just flip the bool.
   *
   * Single canvas, single Pixi `Application` — no separate overlay
   * surface. This is the "render state, not a screen" model.
   */
  setWarpMode(active: boolean): void;
  /**
   * Anchor the warp centre to a specific point so the burst + ripple
   * + flash emanate from there instead of screen centre. World-space
   * anchors are re-projected each frame so the centre stays glued to
   * the world point as the camera moves; screen-space anchors are
   * used raw. `null` reverts to screen centre.
   *
   * Per-event in production: the local player's own warp anchor is
   * set to their ship's world pose; remote-warp broadcasts (other
   * ships leaving / arriving) carry the world coord directly.
   */
  setWarpCenter(center: WarpCenter | null): void;
  /**
   * Fire the "warp-in" companion effect — a single flash + big ripple
   * at the supplied centre, no preceding spool/climax. Used when a
   * remote ship arrives at OR leaves the local sector (both directions
   * use this same direction-agnostic one-shot pulse).
   */
  triggerWarpIn(center: WarpCenter | null): void;
  /**
   * Show or hide the load curtain — an opaque overlay above the world
   * but below the React HUD. Hides the canvas during the join +
   * transit load periods so the player doesn't see ship-at-(0,0)
   * ghost frames or partial mirror state. The renderer alpha-tweens
   * between target states internally; callers just flip the bool.
   */
  setLoadCurtain(active: boolean): void;
  /**
   * Effects subsystem (plan `wiggly-puppy` M9): drop per-entity
   * continuous emitters + in-flight bursts on sector handoff. Called
   * from `ColyseusClient.resetPredictionState()`'s sibling-line in the
   * `transit_ready` handler — same discipline as `rearmJoinReadiness`.
   * Optional behaviour: no-op if the renderer has no `EffectsService`
   * (e.g. when `?effects=0` is set or when running headless tests).
   */
  resetEffectsForSectorHandoff(): void;
  dispose(): void;
}

/**
 * Anchor for warp filters.
 *
 * - `entity` — the renderer re-resolves the centre to the ship with
 *   `entityId`'s live sprite position EVERY FRAME. The correct anchor
 *   for ANY ship's own warp (local, remote, or bot): the effect stays
 *   glued to the ship while it keeps moving through the multi-second
 *   spool→climax→burst. A frozen `world` snapshot taken at spool-start
 *   drifts away (2026-05-15 diagnostic: ~539u over a 3.6s spool — the
 *   "did the effect where I started charging, not where I was" bug).
 *   Not local-specific — that was the architectural smell the user
 *   flagged. Sidesteps the game→Pixi Y flip too (the live sprite is
 *   already correctly placed). Falls back to screen centre if the
 *   entity has no live sprite (not spawned / despawned mid-warp).
 * - `world` — a fixed game-space point with NO live entity to track.
 *   Currently only remote warp-OUT broadcasts (`pendingWarpEvents`):
 *   the ship has already despawned, so a fixed "where it left from"
 *   point is the correct anchor. Projected each frame (camera pans).
 * - `screen` — raw screen px, used as-is (sandbox click-to-place).
 *
 * Mirrored from `src/client/render/worker/protocol.ts` so the
 * contract is self-contained and doesn't reach into a zone-specific
 * module.
 */
export type WarpCenter =
  | { kind: 'entity'; entityId: string }
  | { kind: 'world'; worldX: number; worldY: number }
  | { kind: 'screen'; screenX: number; screenY: number };
