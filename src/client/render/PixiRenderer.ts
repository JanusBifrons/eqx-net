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
const DAMAGE_FLASH_COLOR = 0xff2222;
const PROJECTILE_COLOR = 0xffdd44;
const GHOST_PROJECTILE_COLOR = 0xff8800;
const LASER_BEAM_COLOR = 0x00eeff;
const LASER_CORE_COLOR = 0xffffff;
const REMOTE_LASER_COLOR = 0xff6600;

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
  g.poly([{ x: 0, y: -14 }, { x: 10, y: 0 }, { x: 0, y: 14 }, { x: -10, y: 0 }]);
  g.fill({ color: SERVER_GHOST_COLOR, alpha: 0.55 });
  g.circle(0, 0, 12);
  g.stroke({ color: SERVER_GHOST_COLOR, width: 1.5, alpha: 0.9 });
  return g;
}

function buildProjectileGfx(isGhost: boolean): Graphics {
  const g = new Graphics();
  const color = isGhost ? GHOST_PROJECTILE_COLOR : PROJECTILE_COLOR;
  g.circle(0, 0, 4);
  g.fill({ color, alpha: isGhost ? 0.7 : 1 });
  return g;
}

function buildBeamGfx(dx: number, dy: number): Graphics {
  const g = new Graphics();
  // Outer glow
  g.moveTo(0, 0).lineTo(dx, dy);
  g.stroke({ color: LASER_BEAM_COLOR, width: 3, alpha: 0.4 });
  // Bright core
  g.moveTo(0, 0).lineTo(dx, dy);
  g.stroke({ color: LASER_CORE_COLOR, width: 1, alpha: 1 });
  return g;
}

function buildExplosionGfx(): Graphics {
  const g = new Graphics();
  // Simple starburst: 8 lines radiating from center.
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const r = 20;
    g.moveTo(0, 0).lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
  }
  g.stroke({ color: 0xff6600, width: 2, alpha: 0.9 });
  g.circle(0, 0, 8);
  g.fill({ color: 0xffaa00, alpha: 0.8 });
  return g;
}

export class PixiRenderer implements IRenderer {
  private app!: Application;
  private viewport!: Viewport;
  private shipContainer!: Container;
  private sprites = new Map<string, Graphics>();
  private serverGhost: Graphics | null = null;
  private projectileSprites = new Map<string, Graphics>();
  private explosionSprites: Array<{ gfx: Graphics; framesLeft: number }> = [];
  private liveBeamGfx: Graphics | null = null;
  private remoteBeamGfx: Graphics | null = null;
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

    // Pinch (touch) and wheel (desktop) zoom; clamped to a sensible range.
    this.viewport
      .pinch({ noDrag: true })
      .wheel({ smooth: 4 })
      .clampZoom({ minScale: 0.4, maxScale: 3 });

    this.viewport.addChild(buildGrid());

    this.shipContainer = new Container();
    this.viewport.addChild(this.shipContainer);

    const measureSize = (): { w: number; h: number } => {
      const vv = window.visualViewport;
      const w = container.clientWidth || vv?.width || window.innerWidth;
      const h = container.clientHeight || vv?.height || window.innerHeight;
      return { w, h };
    };

    const resize = (): void => {
      const { w, h } = measureSize();
      this.app.renderer.resize(w, h);
      this.viewport.resize(w, h);
    };
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', resize);
    window.visualViewport?.addEventListener('resize', resize);

    // Container-driven resize: catches layout settling on mobile (URL bar,
    // safe-area insets, dvh recalculation) that don't always fire window resize.
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    (this.app as unknown as Record<string, unknown>)['_resizeHandler'] = resize;
    (this.app as unknown as Record<string, unknown>)['_resizeObserver'] = ro;

    // Force one resize after the next frame to capture post-mount layout.
    requestAnimationFrame(resize);
  }

  update(mirror: RenderMirror): void {
    const seen = new Set<string>();

    // Precompute the set of entities hit by any active remote beam this frame.
    const remoteHitTargets = new Set<string>();
    if (mirror.remoteLasers) {
      for (const laser of mirror.remoteLasers.values()) {
        if (laser.targetId) remoteHitTargets.add(laser.targetId);
      }
    }

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
      sprite.y = -ship.y;
      sprite.rotation = -ship.angle;

      // Damage flash takes priority; beam hit tint is secondary.
      if (mirror.damagedShips?.has(playerId)) {
        sprite.tint = DAMAGE_FLASH_COLOR;
      } else if (mirror.liveBeam?.hitId === playerId || remoteHitTargets.has(playerId)) {
        sprite.tint = 0xff2222;
      } else {
        sprite.tint = 0xffffff;
      }
    }

    // Explosion sprites spawned this frame for destroyed ships.
    if (mirror.explodingShips) {
      for (const targetId of mirror.explodingShips) {
        const shipSprite = this.sprites.get(targetId);
        const x = shipSprite?.x ?? 0;
        const y = shipSprite?.y ?? 0;
        const expl = buildExplosionGfx();
        expl.x = x;
        expl.y = y;
        this.shipContainer.addChild(expl);
        this.explosionSprites.push({ gfx: expl, framesLeft: 30 });
      }
    }

    // Advance and remove expired explosion sprites.
    for (let i = this.explosionSprites.length - 1; i >= 0; i--) {
      const e = this.explosionSprites[i]!;
      e.framesLeft--;
      e.gfx.alpha = e.framesLeft / 30;
      e.gfx.scale.set(1 + (1 - e.framesLeft / 30) * 1.5);
      if (e.framesLeft <= 0) {
        this.shipContainer.removeChild(e.gfx);
        e.gfx.destroy();
        this.explosionSprites.splice(i, 1);
      }
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
        sprite.tint = (mirror.liveBeam?.hitId === id || remoteHitTargets.has(id)) ? 0xff2222 : 0xffffff;
      }
    }

    for (const [id, sprite] of this.sprites) {
      if (!seen.has(id)) {
        this.shipContainer.removeChild(sprite);
        sprite.destroy();
        this.sprites.delete(id);
      }
    }

    // Projectiles and ghost projectiles.
    if (mirror.projectiles) {
      const projSeen = new Set<string>();
      for (const [projId, proj] of mirror.projectiles) {
        projSeen.add(projId);
        let ps = this.projectileSprites.get(projId);
        if (!ps) {
          if (proj.beam) {
            const dx = proj.beam.toX - proj.x;
            const dy = -(proj.beam.toY - proj.y); // Y-flip for Pixi
            ps = buildBeamGfx(dx, dy);
          } else {
            ps = buildProjectileGfx(proj.isGhost ?? false);
          }
          this.shipContainer.addChild(ps);
          this.projectileSprites.set(projId, ps);
        }
        ps.x = proj.x;
        ps.y = -proj.y;
        ps.alpha = proj.alpha ?? 1;
      }
      for (const [projId, ps] of this.projectileSprites) {
        if (!projSeen.has(projId)) {
          this.shipContainer.removeChild(ps);
          ps.destroy();
          this.projectileSprites.delete(projId);
        }
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

    // Remote beams from other players — orange, continuously tracking shooter rotation.
    // Uses shooter's current angle from mirror.ships so the beam sweeps smoothly between
    // server-acked shot events (every ~167ms). One Map entry per shooter — no flicker.
    if (mirror.remoteLasers && mirror.remoteLasers.size > 0) {
      if (!this.remoteBeamGfx) {
        this.remoteBeamGfx = new Graphics();
        this.shipContainer.addChild(this.remoteBeamGfx);
      }
      this.remoteBeamGfx.clear();
      const now = performance.now();
      for (const [shooterId, laser] of mirror.remoteLasers) {
        const shooter = mirror.ships.get(shooterId);
        if (!shooter) continue;
        // Hold full brightness while shooter is actively firing; fade only in the
        // last 150 ms of TTL (i.e. after they stop shooting).  With WEAPON_COOLDOWN
        // = 167 ms and TTL = 400 ms, each new shot resets expiresAt well before the
        // fade window, so the beam is solid-on while space is held.
        const ttlRemaining = laser.expiresAt - now;
        const alpha = ttlRemaining > 150 ? 1.0 : Math.max(0, ttlRemaining / 150);
        // Derive direction from shooter's current angle so it sweeps in real time.
        const fwdX = -Math.sin(shooter.angle);
        const fwdY =  Math.cos(shooter.angle);
        const fromX = shooter.x + fwdX * 20;
        const fromY = shooter.y + fwdY * 20;
        const toX = fromX + fwdX * laser.range;
        const toY = fromY + fwdY * laser.range;
        // Outer glow
        this.remoteBeamGfx.moveTo(fromX, -fromY).lineTo(toX, -toY);
        this.remoteBeamGfx.stroke({ color: REMOTE_LASER_COLOR, width: 3, alpha: alpha * 0.4 });
        // Bright core
        this.remoteBeamGfx.moveTo(fromX, -fromY).lineTo(toX, -toY);
        this.remoteBeamGfx.stroke({ color: 0xffaa44, width: 1, alpha });
      }
      this.remoteBeamGfx.visible = true;
    } else if (this.remoteBeamGfx) {
      this.remoteBeamGfx.visible = false;
    }

    // Live hitscan beam — redrawn every frame so it tracks ship rotation.
    if (mirror.liveBeam) {
      if (!this.liveBeamGfx) {
        this.liveBeamGfx = new Graphics();
        this.shipContainer.addChild(this.liveBeamGfx);
      }
      const b = mirror.liveBeam;
      const dx = b.toX - b.fromX;
      const dy = -(b.toY - b.fromY); // Y-flip for Pixi
      this.liveBeamGfx.clear();
      // Outer glow
      this.liveBeamGfx.moveTo(b.fromX, -b.fromY).lineTo(b.toX, -b.toY);
      this.liveBeamGfx.stroke({ color: LASER_BEAM_COLOR, width: 3, alpha: 0.4 });
      // Bright core
      this.liveBeamGfx.moveTo(b.fromX, -b.fromY).lineTo(b.toX, -b.toY);
      this.liveBeamGfx.stroke({ color: LASER_CORE_COLOR, width: 1, alpha: 1 });
      this.liveBeamGfx.visible = true;
      void dx; void dy;
    } else {
      if (this.liveBeamGfx) this.liveBeamGfx.visible = false;
    }

    const local = mirror.localPlayerId ? this.sprites.get(mirror.localPlayerId) : null;
    if (local) {
      this.viewport.moveCenter(local.x, local.y);
    }
  }

  dispose(): void {
    if (!this.initialized) return;
    const handler = (this.app as unknown as Record<string, unknown>)['_resizeHandler'];
    if (typeof handler === 'function') {
      window.removeEventListener('resize', handler as EventListener);
      window.removeEventListener('orientationchange', handler as EventListener);
      window.visualViewport?.removeEventListener('resize', handler as EventListener);
    }
    const ro = (this.app as unknown as Record<string, unknown>)['_resizeObserver'];
    if (ro instanceof ResizeObserver) ro.disconnect();
    this.app.destroy(true, { children: true });
  }
}
