import { Application, Graphics, Container } from 'pixi.js';
import { Viewport } from 'pixi-viewport';
import type { IRenderer, RenderMirror } from '@core/contracts/IRenderer';

const WORLD_W = 10000;
const WORLD_H = 10000;
const LOCAL_SHIP_COLOR = 0x00ff88;
const REMOTE_SHIP_COLOR = 0x4488ff;
const BACKGROUND_COLOR = 0x05070f;
const GRID_CELL = 200;
const GRID_COLOR = 0x1a2040;

function buildGrid(): Graphics {
  const g = new Graphics();
  const half = WORLD_W / 2;
  for (let x = -half; x <= half; x += GRID_CELL) {
    g.moveTo(x, -half).lineTo(x, half);
  }
  for (let y = -half; y <= half; y += GRID_CELL) {
    g.moveTo(-half, y).lineTo(half, y);
  }
  g.stroke({ color: GRID_COLOR, width: 1 });
  return g;
}

function buildShipGfx(color: number): Graphics {
  const g = new Graphics();
  g.poly([
    { x: 0, y: -16 },
    { x: -10, y: 10 },
    { x: 0, y: 5 },
    { x: 10, y: 10 },
  ]);
  g.fill({ color });
  return g;
}

export class PixiRenderer implements IRenderer {
  private app!: Application;
  private viewport!: Viewport;
  private shipContainer!: Container;
  private sprites = new Map<string, Graphics>();
  private initialized = false;

  async init(rawContainer: unknown): Promise<void> {
    const container = rawContainer as HTMLElement;
    this.app = new Application();
    await this.app.init({
      width: container.clientWidth || window.innerWidth,
      height: container.clientHeight || window.innerHeight,
      background: BACKGROUND_COLOR,
      antialias: true,
      resolution: window.devicePixelRatio ?? 1,
      autoDensity: true,
    });
    container.appendChild(this.app.canvas);
    this.initialized = true;

    this.viewport = new Viewport({
      screenWidth: container.clientWidth || window.innerWidth,
      screenHeight: container.clientHeight || window.innerHeight,
      worldWidth: WORLD_W,
      worldHeight: WORLD_H,
      events: this.app.renderer.events,
    });
    this.app.stage.addChild(this.viewport);

    this.viewport.addChild(buildGrid());

    this.shipContainer = new Container();
    this.viewport.addChild(this.shipContainer);

    const resize = (): void => {
      this.app.renderer.resize(container.clientWidth, container.clientHeight);
      this.viewport.resize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener('resize', resize);

    // Store cleanup ref on the app for dispose()
    (this.app as unknown as Record<string, unknown>)['_resizeHandler'] = resize;
  }

  update(mirror: RenderMirror): void {
    const seen = new Set<string>();

    for (const [playerId, ship] of mirror.ships) {
      seen.add(playerId);

      let sprite = this.sprites.get(playerId);
      if (!sprite) {
        const isLocal = playerId === mirror.localPlayerId;
        sprite = buildShipGfx(isLocal ? LOCAL_SHIP_COLOR : REMOTE_SHIP_COLOR);
        this.shipContainer.addChild(sprite);
        this.sprites.set(playerId, sprite);
      }

      sprite.x = ship.x;
      sprite.y = -ship.y; // Rapier Y-up → Pixi Y-down
      sprite.rotation = -ship.angle;
    }

    for (const [playerId, sprite] of this.sprites) {
      if (!seen.has(playerId)) {
        this.shipContainer.removeChild(sprite);
        sprite.destroy();
        this.sprites.delete(playerId);
      }
    }

    const local = mirror.localPlayerId ? this.sprites.get(mirror.localPlayerId) : null;
    if (local) {
      this.viewport.moveCenter(local.x, local.y);
    }
  }

  dispose(): void {
    if (!this.initialized) return;
    const handler = (this.app as unknown as Record<string, unknown>)['_resizeHandler'];
    if (typeof handler === 'function') window.removeEventListener('resize', handler as EventListener);
    this.app.destroy(true, { children: true });
  }
}
