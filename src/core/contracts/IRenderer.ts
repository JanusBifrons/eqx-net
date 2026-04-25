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

export interface RenderMirror {
  ships: Map<string, ShipRenderState>;
  /** Optional. When present, renderer draws each entry as a circle matching its collision radius. */
  obstacles?: Map<string, ObstacleRenderState>;
  localPlayerId: string | null;
  /**
   * When present, the renderer draws a semi-transparent ghost at this position to
   * show the raw server snapshot position (before client-side prediction replay).
   * Lets you visually confirm whether the server and client are diverging.
   */
  serverGhostPos?: { x: number; y: number } | null;
}

export interface IRenderer {
  // Container is typed as unknown here so core stays DOM-free.
  // Client implementations narrow it to HTMLElement.
  init(container: unknown): Promise<void>;
  update(mirror: RenderMirror): void;
  dispose(): void;
}
