export interface ShipRenderState {
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
}

/**
 * One swarm-channel render entry. Replaces the Phase 1–4 `ObstacleRenderState`:
 * asteroids and drones flow through the binary swarm broadcast and are no
 * longer carried on Colyseus MapSchema. Radius is implied by `kind` (renderer
 * draws asteroids vs drones with their own visuals). Sleeping entries freeze
 * interpolation and stay parked at the last server-shipped pose.
 */
export interface SwarmRenderState {
  /** Latest pose received from the wire. Renderer lerps from `prev*` to this. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  /** Pose from the previous packet — interpolation source. Equal to (x,y,angle) on first packet. */
  prevX: number;
  prevY: number;
  prevAngle: number;
  /** Wall-clock arrival timestamps (performance.now()) for lerp t calculation. */
  prevArrivalMs: number;
  latestArrivalMs: number;
  /** Collision radius. Renderer draws asteroids as circles of this size. */
  radius: number;
  /** 0 = asteroid, 1 = drone. */
  kind: number;
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
