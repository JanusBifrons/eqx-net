export interface ShipRenderState {
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
}

export interface ObstacleRenderState extends ShipRenderState {
  /** World-unit collision radius. Renderer draws a circle of this exact size so
   *  collisions visually line up with the simulation. */
  radius: number;
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
  /** Optional. When present, renderer draws each entry as a circle matching its collision radius. */
  obstacles?: Map<string, ObstacleRenderState>;
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
  /** Live hitscan beam, drawn every frame while fire is held. Null when not firing. */
  liveBeam?: { fromX: number; fromY: number; toX: number; toY: number; hitId?: string } | null;
}

export interface IRenderer {
  // Container is typed as unknown here so core stays DOM-free.
  // Client implementations narrow it to HTMLElement.
  init(container: unknown): Promise<void>;
  update(mirror: RenderMirror): void;
  dispose(): void;
}
