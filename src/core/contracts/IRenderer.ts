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
}

export interface RenderMirror {
  ships: Map<string, ShipRenderState>;
  /**
   * Swarm entities (asteroids + drones) shipped via the binary swarm channel.
   * Keyed by the server's dense u16 entityId. Sleeping entries remain in the
   * map at their last-shipped pose and the renderer freezes interpolation.
   */
  swarm?: Map<number, SwarmRenderState>;
  /** Projectiles: both server-authoritative and client ghost entries. */
  projectiles?: Map<string, ProjectileRenderState>;
  localPlayerId: string | null;
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
   * Live hitscan beam state. Carries only the hit distance and target id; the
   * renderer derives the beam's geometry from the local ship's lerped pose in
   * `ships[localPlayerId]` each frame so the beam visually stays glued to the
   * ship sprite during prediction-correction lerps. Null when not firing.
   */
  liveBeam?: { dist: number; hitId?: string } | null;
  /** When false, the renderer hides the orange server-ghost diamond. Default true. */
  showServerGhost?: boolean;
  /**
   * Server-authoritative beams from remote shooters (players and drones). Keyed
   * by shooterId; a new shot replaces the previous entry so there's no flicker.
   * For player shooters, the renderer derives geometry from the shooter's live
   * pose in `mirror.ships` so the beam sweeps with rotation. For non-ship
   * shooters (drones — not in `mirror.ships`), the renderer falls back to the
   * server-shipped `fromX/fromY/toX/toY` endpoints.
   */
  remoteLasers?: Map<string, {
    range: number;
    hit: boolean;
    targetId?: string;
    expiresAt: number;
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
  }>;
}

export interface IRenderer {
  // Container is typed as unknown here so core stays DOM-free.
  // Client implementations narrow it to HTMLElement.
  init(container: unknown): Promise<void>;
  update(mirror: RenderMirror): void;
  dispose(): void;
}
