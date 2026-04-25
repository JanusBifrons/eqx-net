import { Application, Graphics, Container } from 'pixi.js';
import { Viewport } from 'pixi-viewport';
import type { IRenderer, RenderMirror } from '@core/contracts/IRenderer';

const WORLD_W = 10000;
const WORLD_H = 10000;
const LOCAL_SHIP_COLOR = 0x00ff88;
const REMOTE_SHIP_COLOR = 0x4488ff;
const SERVER_GHOST_COLOR = 0xff4400;
const ASTEROID_COLOR = 0x886644;
const ASTEROID_OUTLINE = 0xbb9966;
const HITBOX_COLOR = 0xff0066;
const BACKGROUND_COLOR = 0x05070f;
const GRID_CELL = 200;
const GRID_COLOR = 0x1a2040;
const SHIP_HITBOX_RADIUS = 12; // must match World.ts SHIP_RADIUS

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
  // Overlay the true collision radius so the player can see where the hitbox is.
  g.circle(0, 0, SHIP_HITBOX_RADIUS);
  g.stroke({ color: HITBOX_COLOR, width: 1, alpha: 0.6 });
  return g;
}

function buildAsteroidGfx(radius: number): Graphics {
  const g = new Graphics();
  g.circle(0, 0, radius);
  g.fill({ color: ASTEROID_COLOR });
  g.circle(0, 0, radius);
  g.stroke({ color: ASTEROID_OUTLINE, width: 1.5 });
  return g;
}

function buildGhostGfx(): Graphics {
  const g = new Graphics();
  // Diamond shape — clearly distinct from the ship triangle.
  g.poly([{ x: 0, y: -14 }, { x: 10, y: 0 }, { x: 0, y: 14 }, { x: -10, y: 0 }]);
  g.fill({ color: SERVER_GHOST_COLOR, alpha: 0.55 });
  g.circle(0, 0, 12);
  g.stroke({ color: SERVER_GHOST_COLOR, width: 1.5, alpha: 0.9 });
  return g;
}

export class PixiRenderer implements IRenderer {
  private app!: Application;
  private viewport!: Viewport;
  private shipContainer!: Container;
  private sprites = new Map<string, Graphics>();
  private serverGhost: Graphics | null = null;
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

    if (mirror.obstacles) {
      for (const [id, obs] of mirror.obstacles) {
        seen.add(id);
        let sprite = this.sprites.get(id);
        if (!sprite) {
          sprite = buildAsteroidGfx(obs.radius);
          this.shipContainer.addChild(sprite);
          this.sprites.set(id, sprite);
        }
        sprite.x = obs.x;
        sprite.y = -obs.y;
        sprite.rotation = -obs.angle;
      }
    }

    for (const [id, sprite] of this.sprites) {
      if (!seen.has(id)) {
        this.shipContainer.removeChild(sprite);
        sprite.destroy();
        this.sprites.delete(id);
      }
    }

    // Server ghost: orange diamond showing where the server's last snapshot
    // put the ship, before any client-side prediction replay.
    if (mirror.serverGhostPos) {
      if (!this.serverGhost) {
        this.serverGhost = buildGhostGfx();
        this.shipContainer.addChild(this.serverGhost);
      }
      this.serverGhost.visible = true;
      this.serverGhost.x = mirror.serverGhostPos.x;
      this.serverGhost.y = -mirror.serverGhostPos.y;
    } else if (this.serverGhost) {
      this.serverGhost.visible = false;
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
