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

/** Depth of the per-entity pose ring. Must be ≥ ceil((DISPLAY_DELAY_MS +
 *  one inter-arrival) / inter-arrival) + 1 so the *oldest* arrival the
 *  interpolator might still be lerping FROM is still resident in the ring
 *  when a new arrival lands. With DISPLAY_DELAY_MS=100 and 50ms broadcasts,
 *  depth 3 is the theoretical minimum but offers no margin under jitter — a
 *  late arrival evicts the oldest just as the interpolator still needs it,
 *  producing a single-frame snap. Depth 4 has measured headroom for ±30 ms
 *  arrival jitter. */
export const POSE_RING_DEPTH = 4;

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
  /** True when this drone's AI behaviour currently treats the local player
   *  as a hostile target. Populated each frame by the consumer (e.g.
   *  `ColyseusGameClient.updateMirror` via `AiController.isEntityHostileToPlayer`)
   *  — drives the radar's hostile-vs-idle colouring + glow. Absent on
   *  asteroids and on drones whose AI hasn't been hit yet. */
  isHostileToLocal?: boolean;
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
  /** Projectiles: both server-authoritative and client ghost entries. */
  projectiles?: Map<string, ProjectileRenderState>;
  localPlayerId: string | null;
  /** Floating damage numbers to spawn this frame. Drained + cleared each frame. */
  pendingDamageNumbers?: Array<{ x: number; y: number; damage: number }>;
  /** Health bar hit events this frame. Drained + cleared each frame. */
  pendingHealthBarHits?: Array<{ entityId: string; healthPct: number }>;
  /**
   * When present, the renderer draws a semi-transparent ghost at this position to
   * show the raw server snapshot position (before client-side prediction replay).
   * Lets you visually confirm whether the server and client are diverging.
   */
  serverGhostPos?: { x: number; y: number } | null;
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
  dispose(): void;
}
