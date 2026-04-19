export interface ShipRenderState {
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
}

export interface RenderMirror {
  ships: Map<string, ShipRenderState>;
  localPlayerId: string | null;
}

export interface IRenderer {
  // Container is typed as unknown here so core stays DOM-free.
  // Client implementations narrow it to HTMLElement.
  init(container: unknown): Promise<void>;
  update(mirror: RenderMirror): void;
  dispose(): void;
}
