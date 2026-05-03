import { Application, Graphics, Container } from 'pixi.js';
import { Viewport } from 'pixi-viewport';
import type { IRenderer, RenderMirror } from '@core/contracts/IRenderer';
import { interpolateSwarmPose, type InterpolatedPose } from '../net/swarmInterpolation';

const WORLD_W = 10000;
const WORLD_H = 10000;
const LOCAL_SHIP_COLOR = 0x00ff88;
const REMOTE_SHIP_COLOR = 0x4488ff;
const SERVER_GHOST_COLOR = 0xff4400;
const ASTEROID_COLOR = 0x886644;
const ASTEROID_OUTLINE = 0xbb9966;
const DRONE_FILL_COLOR = 0xff3366;
const DRONE_OUTLINE_COLOR = 0xffaacc;
const DRONE_CORE_COLOR = 0xffeeaa;
const HITBOX_COLOR = 0xff0066;
const BACKGROUND_COLOR = 0x05070f;
const GRID_CELL = 200;
const GRID_COLOR = 0x1a2040;
const SHIP_HITBOX_RADIUS = 12; // must match World.ts SHIP_RADIUS
// Soft pink tint — multiplied with each ship's base colour, this gives a
// legible "I just got hit" flash without crushing the green/blue hull tone.
// (0xff2222 was the original but tinted local-ship green nearly black.)
const DAMAGE_FLASH_COLOR = 0xffaaaa;
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

/**
 * Boost exhaust flame — drawn behind the ship sprite when shift-boosting. Two
 * concentric tapered triangles (outer orange, inner yellow-white core) flicker
 * each frame for life. Aligned to the ship's local frame; the renderer
 * inherits the ship's rotation by adding the flame as a child of the sprite.
 */
const BOOST_FLAME_COLOR_OUTER = 0xff7733;
const BOOST_FLAME_COLOR_CORE  = 0xffee99;
function buildBoostFlameGfx(): Graphics {
  const g = new Graphics();
  // Outer plume — tapered triangle pointing astern (local +y in pixi).
  // Ship body extends from y=-16 (nose) to y=10 (tail); flame starts at y=10.
  g.poly([
    { x: -7, y: 10 },
    { x:  7, y: 10 },
    { x:  0, y: 36 },
  ]);
  g.fill({ color: BOOST_FLAME_COLOR_OUTER, alpha: 0.85 });
  // Inner core — brighter, narrower.
  g.poly([
    { x: -3, y: 10 },
    { x:  3, y: 10 },
    { x:  0, y: 24 },
  ]);
  g.fill({ color: BOOST_FLAME_COLOR_CORE, alpha: 0.95 });
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

/**
 * Drone visual — angular dart pointing along the body's forward direction
 * (`(-sin θ, cos θ)` per the World forward convention; renderer rotates by
 * `-angle` so the dart's local +y nose maps to world forward). Distinct
 * magenta-pink so drones never read as asteroids.
 */
function buildDroneGfx(radius: number): Graphics {
  const g = new Graphics();
  // Outer dart silhouette, nose pointing local up (-y in pixi).
  g.poly([
    { x: 0, y: -radius },
    { x: radius * 0.85, y: radius * 0.7 },
    { x: 0, y: radius * 0.35 },
    { x: -radius * 0.85, y: radius * 0.7 },
  ]);
  g.fill({ color: DRONE_FILL_COLOR });
  g.poly([
    { x: 0, y: -radius },
    { x: radius * 0.85, y: radius * 0.7 },
    { x: 0, y: radius * 0.35 },
    { x: -radius * 0.85, y: radius * 0.7 },
  ]);
  g.stroke({ color: DRONE_OUTLINE_COLOR, width: 1.5 });
  // Glowing core dot so they remain visible at small radii.
  g.circle(0, 0, Math.max(2, radius * 0.25));
  g.fill({ color: DRONE_CORE_COLOR });
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
  /** Per-ship boost-exhaust flame, parented to the ship sprite. Visible only
   *  while the ship is in `mirror.boostingShips`. Pooled — created on first
   *  boost, hidden when not active, destroyed with the ship sprite. */
  private boostFlames = new Map<string, Graphics>();
  private serverGhost: Graphics | null = null;
  private projectileSprites = new Map<string, Graphics>();
  private explosionSprites: Array<{ gfx: Graphics; framesLeft: number }> = [];
  private liveBeamGfx: Graphics | null = null;
  private remoteBeamGfx: Graphics | null = null;
  private initialized = false;
  /** Reused per-frame so swarm interpolation doesn't allocate. */
  private readonly swarmPoseScratch: InterpolatedPose = { x: 0, y: 0, angle: 0 };

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
      // Late-fire guard: a queued `requestAnimationFrame(resize)` and the
      // ResizeObserver can both fire AFTER dispose() has destroyed the Pixi
      // application, leaving `this.app.renderer` null. Bailing on
      // !this.initialized is enough — dispose() flips that flag.
      if (!this.initialized || !this.app?.renderer) return;
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

      // Boost flame — child of the ship sprite so it inherits rotation. Lazily
      // created on first boost; left as a hidden child afterwards so toggling
      // shift doesn't churn the scene graph.
      const isBoosting = mirror.boostingShips?.has(playerId) ?? false;
      let flame = this.boostFlames.get(playerId);
      if (isBoosting) {
        if (!flame) {
          flame = buildBoostFlameGfx();
          sprite.addChild(flame);
          this.boostFlames.set(playerId, flame);
        }
        flame.visible = true;
        // Cheap per-frame flicker so the plume reads as fire, not a static
        // arrow. Two ranges feed scaleY (length) and alpha (intensity).
        flame.scale.y = 0.85 + Math.random() * 0.4;
        flame.alpha   = 0.75 + Math.random() * 0.25;
      } else if (flame) {
        flame.visible = false;
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

    // Phase 5c: swarm entities (asteroids + drones) — keyed by `swarm-${entityId}`
    // in the sprite map so they can't collide with playerIds. Sleeping entries
    // simply stop receiving pose updates; the sprite stays parked at the last
    // server-shipped pose (no client-side dead reckoning).
    if (mirror.swarm) {
      const now = performance.now();
      for (const [entityId, entry] of mirror.swarm) {
        const spriteKey = `swarm-${entityId}`;
        seen.add(spriteKey);
        let sprite = this.sprites.get(spriteKey);
        if (!sprite) {
          sprite = entry.kind === 1 ? buildDroneGfx(entry.radius) : buildAsteroidGfx(entry.radius);
          this.shipContainer.addChild(sprite);
          this.sprites.set(spriteKey, sprite);
        }
        // Phase 5c-stabilise: lerp between the prev and latest received pose
        // (entity interpolation) so frame-to-frame motion is smooth even when
        // the wire delivers packets at irregular cadence.
        const lerped = interpolateSwarmPose(entry, now, this.swarmPoseScratch);
        sprite.x = lerped.x;
        sprite.y = -lerped.y;
        sprite.rotation = -lerped.angle;
        // Damage flash takes priority over the active-beam hit tint so a
        // drone clearly registers a hit even when no beam is currently on it.
        if (mirror.damagedShips?.has(spriteKey)) {
          sprite.tint = DAMAGE_FLASH_COLOR;
        } else if ((mirror.liveBeam?.hitId === spriteKey) || remoteHitTargets.has(spriteKey)) {
          sprite.tint = DAMAGE_FLASH_COLOR;
        } else {
          sprite.tint = 0xffffff;
        }
        // Sleeping entries stop interpolating; their pose is whatever the
        // server last shipped. (Mark visually muted in 5d if needed.)
      }
    }

    for (const [id, sprite] of this.sprites) {
      if (!seen.has(id)) {
        this.shipContainer.removeChild(sprite);
        // Boost flame is a child — destroy({ children: true }) frees it too,
        // but we still drop the map entry so a respawn rebuilds cleanly.
        sprite.destroy({ children: true });
        this.sprites.delete(id);
        this.boostFlames.delete(id);
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
    // `showServerGhost` defaults to true when undefined so older mirrors and
    // the LocalGameClient diagnostic surface keep working.
    const ghostEnabled = mirror.showServerGhost !== false;
    if (ghostEnabled && mirror.serverGhostPos) {
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
        // Hold full brightness while shooter is actively firing; fade only in the
        // last 150 ms of TTL (i.e. after they stop shooting).  With WEAPON_COOLDOWN
        // = 167 ms and TTL = 400 ms, each new shot resets expiresAt well before the
        // fade window, so the beam is solid-on while space is held.
        const ttlRemaining = laser.expiresAt - now;
        const alpha = ttlRemaining > 150 ? 1.0 : Math.max(0, ttlRemaining / 150);

        // Player shooters track their live ship pose; the beam sweeps with the
        // ship's rotation between fire events. AI shooters track their
        // mirror.swarm pose for the same reason — drones move every tick, so
        // a wire-frozen beam origin would re-anchor on each fire (visible
        // jump). Falls back to the wire endpoints if the shooter isn't found
        // (defensive — e.g. ID mapping mismatch).
        const shooter = mirror.ships.get(shooterId);
        let swarmShooter: { x: number; y: number; angle: number; radius: number } | null = null;
        if (!shooter && shooterId.startsWith('swarm-')) {
          const entityId = parseInt(shooterId.slice('swarm-'.length), 10);
          if (!Number.isNaN(entityId)) {
            const sw = mirror.swarm?.get(entityId);
            if (sw) {
              // Use the SAME interpolated pose the sprite is drawn at, so the
              // beam origin lines up exactly with the drone's visual position.
              const lerped = interpolateSwarmPose(sw, now, this.swarmPoseScratch);
              swarmShooter = { x: lerped.x, y: lerped.y, angle: lerped.angle, radius: sw.radius };
            }
          }
        }

        let fromX: number;
        let fromY: number;
        let toX: number;
        let toY: number;
        if (shooter) {
          const fwdX = -Math.sin(shooter.angle);
          const fwdY =  Math.cos(shooter.angle);
          fromX = shooter.x + fwdX * 20;
          fromY = shooter.y + fwdY * 20;
          toX = fromX + fwdX * laser.range;
          toY = fromY + fwdY * laser.range;
        } else if (swarmShooter) {
          // Origin at the drone's nose (radius offset along its facing).
          const fwdX = -Math.sin(swarmShooter.angle);
          const fwdY =  Math.cos(swarmShooter.angle);
          fromX = swarmShooter.x + fwdX * (swarmShooter.radius + 2);
          fromY = swarmShooter.y + fwdY * (swarmShooter.radius + 2);
          toX = fromX + fwdX * laser.range;
          toY = fromY + fwdY * laser.range;
        } else {
          fromX = laser.fromX;
          fromY = laser.fromY;
          toX = laser.toX;
          toY = laser.toY;
        }
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

    // Live hitscan beam — derive geometry from the local ship's lerped pose in
    // mirror.ships each frame so the beam stays glued to the ship sprite even
    // during a server-correction lerp. (Mirrors the remote-beam pattern above —
    // single source of truth: "where the ship is visually right now".)
    const localShip = mirror.localPlayerId ? mirror.ships.get(mirror.localPlayerId) : null;
    if (mirror.liveBeam && localShip) {
      if (!this.liveBeamGfx) {
        this.liveBeamGfx = new Graphics();
        this.shipContainer.addChild(this.liveBeamGfx);
      }
      const fwdX = -Math.sin(localShip.angle);
      const fwdY =  Math.cos(localShip.angle);
      const fromX = localShip.x + fwdX * 20;
      const fromY = localShip.y + fwdY * 20;
      const toX = fromX + fwdX * mirror.liveBeam.dist;
      const toY = fromY + fwdY * mirror.liveBeam.dist;
      this.liveBeamGfx.clear();
      // Outer glow
      this.liveBeamGfx.moveTo(fromX, -fromY).lineTo(toX, -toY);
      this.liveBeamGfx.stroke({ color: LASER_BEAM_COLOR, width: 3, alpha: 0.4 });
      // Bright core
      this.liveBeamGfx.moveTo(fromX, -fromY).lineTo(toX, -toY);
      this.liveBeamGfx.stroke({ color: LASER_CORE_COLOR, width: 1, alpha: 1 });
      this.liveBeamGfx.visible = true;
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
    // Flip the flag FIRST so any rAF / ResizeObserver callback that fires
    // between here and the actual destroy() short-circuits cleanly. Without
    // this, the queued requestAnimationFrame(resize) at the end of init()
    // could land post-destroy and read a null renderer.
    this.initialized = false;
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
