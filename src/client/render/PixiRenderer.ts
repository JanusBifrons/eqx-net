import { Application, Graphics, Container } from 'pixi.js';
import { Camera } from './worker/Camera';
import type { IRenderer, RenderMirror, RendererFeedback } from '@core/contracts/IRenderer';
import { interpolateSwarmPose, type InterpolatedPose } from '../net/swarmInterpolation';
import { HaloRadar } from './HaloRadar';
import { DamageNumberManager } from './DamageNumbers';
import { HealthBarManager } from './HealthBars';
import { LabelManager } from './Labels';
import { decideLingeringSpriteAction, decideExplosionPosition } from './spriteUpdateDecisions';
import { MountVisualManager } from './MountVisualManager';
import { BackgroundGrid } from './BackgroundGrid';
import { StarfieldBackground } from './StarfieldBackground';
import { generateAsteroidVertices } from '@core/swarm/asteroidShape';
import { getShipKind, type ShipShape, type WeaponMount } from '../../shared-types/shipKinds';

const WORLD_W = 10000;
const WORLD_H = 10000;
const SERVER_GHOST_COLOR = 0xff4400;
const ASTEROID_COLOR = 0x886644;
const ASTEROID_OUTLINE = 0xbb9966;
const DRONE_FILL_COLOR = 0xff3366;
const DRONE_OUTLINE_COLOR = 0xffaacc;
const DRONE_CORE_COLOR = 0xffeeaa;
const HITBOX_COLOR = 0xff0066;
const BACKGROUND_COLOR = 0x05070f;
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
const LASER_BOLT_OUTER = 0xff2244;
const LASER_BOLT_CORE  = 0xffffff;

/**
 * Convert a `ShipShape` from the catalogue into a Pixi `Graphics`. The polygon
 * is drawn from the shape's points (entity-local space, nose at -y, tail at
 * +y) scaled by `shape.scale`. `tintOverride` lets the caller apply the
 * legacy "local = green, remote = blue" colour scheme on top of the kind's
 * native colour (the local tint is applied as a fill colour override; the
 * kind colour is used otherwise so all three kinds remain visually distinct).
 *
 * The dashed hitbox circle stays kind-agnostic — it always traces the
 * collider radius, which the catalogue keeps in sync with the polygon's
 * visual extent so collisions feel honest.
 */
function buildShipGfxFromShape(shape: ShipShape, tintOverride?: number): Graphics {
  const g = new Graphics();
  const scale = shape.scale;
  g.poly(shape.points.map(([x, y]) => ({ x: x * scale, y: y * scale })));
  g.fill({ color: tintOverride ?? shape.color });
  g.circle(0, 0, SHIP_HITBOX_RADIUS);
  g.stroke({ color: HITBOX_COLOR, width: 1, alpha: 0.6 });
  return g;
}

/** Resolve `ShipRenderState.kind` to a concrete shape, with fallback. */
function shapeForKind(kindId: string | undefined): ShipShape {
  return getShipKind(kindId).shape;
}

/** Drain colour and tilt it grey for the Phase 4 wreck silhouette. Take
 *  ~30 % of the original RGB and mix in a desaturated grey so the wreck
 *  reads as "broken ship of that kind" without screaming the kind's
 *  brand colour. */
function desaturate(color: number): number {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8)  & 0xff;
  const b =  color        & 0xff;
  const grey = Math.round((r + g + b) / 3);
  // 30% original, 70% grey — gives a smoky, drained tone.
  const mix = (c: number) => Math.round(c * 0.30 + grey * 0.70);
  return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}

/**
 * Baseline thrust flame — shown whenever a ship is accelerating, regardless
 * of boost. Two concentric tapered triangles (outer orange, inner yellow-white
 * core). Aligned to the ship's local frame; the renderer inherits the ship's
 * rotation by adding the flame as a child of the sprite.
 */
const THRUST_FLAME_COLOR_OUTER = 0xff7733;
const THRUST_FLAME_COLOR_CORE  = 0xffee99;
function buildThrustFlameGfx(): Graphics {
  const g = new Graphics();
  // Outer plume — tapered triangle pointing astern (local +y in pixi).
  // Ship body extends from y=-16 (nose) to y=10 (tail); flame starts at y=10.
  g.poly([
    { x: -7, y: 10 },
    { x:  7, y: 10 },
    { x:  0, y: 36 },
  ]);
  g.fill({ color: THRUST_FLAME_COLOR_OUTER, alpha: 0.85 });
  // Inner core — brighter, narrower.
  g.poly([
    { x: -3, y: 10 },
    { x:  3, y: 10 },
    { x:  0, y: 24 },
  ]);
  g.fill({ color: THRUST_FLAME_COLOR_CORE, alpha: 0.95 });
  return g;
}

/**
 * Boost exhaust flame — layered ON TOP of the thrust flame while a ship is
 * boosting. Longer, wider, with a bluish-white plasma core to read as
 * "hotter / more energetic" than the baseline thrust flame.
 */
const BOOST_FLAME_COLOR_OUTER  = 0xff5511;
const BOOST_FLAME_COLOR_CORE   = 0xffee99;
const BOOST_FLAME_COLOR_PLASMA = 0x88ccff;
function buildBoostFlameGfx(): Graphics {
  const g = new Graphics();
  // Extended outer plume — wider base, longer tail.
  g.poly([
    { x: -10, y: 10 },
    { x:  10, y: 10 },
    { x:   0, y: 54 },
  ]);
  g.fill({ color: BOOST_FLAME_COLOR_OUTER, alpha: 0.85 });
  // Mid yellow-white layer — bridges outer orange to plasma core.
  g.poly([
    { x: -5, y: 10 },
    { x:  5, y: 10 },
    { x:  0, y: 40 },
  ]);
  g.fill({ color: BOOST_FLAME_COLOR_CORE, alpha: 0.95 });
  // Plasma core — bluish-white spike to suggest extreme heat.
  g.poly([
    { x: -2, y: 10 },
    { x:  2, y: 10 },
    { x:  0, y: 28 },
  ]);
  g.fill({ color: BOOST_FLAME_COLOR_PLASMA, alpha: 0.9 });
  return g;
}

function buildAsteroidGfx(entityId: number, radius: number): Graphics {
  const g = new Graphics();
  // Same generator the server uses to build the convex-hull collider — both
  // sides seed from the same entityId, so the rendered silhouette matches the
  // physics shape exactly. Vertices are emitted in math-space (Y-up); the
  // sprite is rendered in Pixi screen space (Y-down) and rotated by `-angle`.
  // For symmetric polygons (ship/drone) the y-flip is invisible, but an
  // asymmetric polygon mismatches its collision hull as it rotates unless
  // every vertex's y is negated for drawing only.
  const mathVerts = generateAsteroidVertices(entityId, radius);
  const screenVerts = mathVerts.map((v) => ({ x: v.x, y: -v.y }));
  g.poly(screenVerts);
  g.fill({ color: ASTEROID_COLOR });
  g.poly(screenVerts);
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

function buildLaserBoltGfx(): Graphics {
  const g = new Graphics();
  // Outer glow — short bright line
  g.moveTo(0, -12).lineTo(0, 12);
  g.stroke({ color: LASER_BOLT_OUTER, width: 5, alpha: 0.5 });
  // Inner white core
  g.moveTo(0, -10).lineTo(0, 10);
  g.stroke({ color: LASER_BOLT_CORE, width: 2, alpha: 1 });
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

/** Compute the world position of a mount's pivot given the host ship's pose.
 *  Multi-mount/turret refactor (Phase 2c). For legacy single-mount ships
 *  mount.localX/Y = (0, 0), so the result is just (shipX, shipY) — same as
 *  the pre-refactor "fire from ship centre" path. `mount` may be undefined
 *  when a pre-2c server omits `mountId` from a `laser_fired` event; in that
 *  case we fall back to ship centre (no offset). */
function applyMountOffset(
  shipX: number,
  shipY: number,
  shipAngle: number,
  mount: WeaponMount | undefined,
): { x: number; y: number } {
  if (!mount) return { x: shipX, y: shipY };
  const cosA = Math.cos(shipAngle);
  const sinA = Math.sin(shipAngle);
  return {
    x: shipX + (mount.localX * cosA - mount.localY * sinA),
    y: shipY + (mount.localX * sinA + mount.localY * cosA),
  };
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
  /**
   * World Container — replaces `pixi-viewport`'s `Viewport`. Holds all
   * gameplay sprites (ships, swarm, projectiles, beams, wrecks,
   * lingering hulls, background grid, etc.). Pan / zoom / momentum are
   * driven by the `Camera` controller below.
   */
  private world!: Container;
  /** Camera controller — owns world's transform via pointer/wheel events. */
  private camera!: Camera;
  private shipContainer!: Container;
  private sprites = new Map<string, Graphics>();
  /** Phase 4 — sprites for abandoned-ship wrecks. Keyed by shipInstanceId.
   *  Drawn with a desaturated kind colour; updated each frame from
   *  `mirror.wrecks`. Removed when the wreck disappears from the mirror. */
  private wreckSprites = new Map<string, Graphics>();
  /** Per-ship boost-exhaust flame, parented to the ship sprite. Visible only
   *  while the ship is in `mirror.boostingShips`. Pooled — created on first
   *  boost, hidden when not active, destroyed with the ship sprite. */
  private boostFlames = new Map<string, Graphics>();
  /** Per-ship turret sprites + aim lines (multi-mount/turret refactor,
   *  Phase 3). Parented to each ship's main `sprite` so the cluster inherits
   *  the ship's world transform; the cluster's own children sit at their
   *  mount-local offset and baseAngle rotation. */
  private mountVisuals = new MountVisualManager();
  /** Per-ship baseline thrust flame, parented to the ship sprite. Visible
   *  while the ship is in `mirror.thrustingShips` (any acceleration). Boost
   *  flame layers on top. Pooled — same lifecycle as `boostFlames`. */
  private thrustFlames = new Map<string, Graphics>();
  private serverGhost: Graphics | null = null;
  private projectileSprites = new Map<string, Graphics>();
  private explosionSprites: Array<{ gfx: Graphics; framesLeft: number }> = [];
  private liveBeamGfx: Graphics | null = null;
  private remoteBeamGfx: Graphics | null = null;
  private initialized = false;
  /** Reused per-frame so swarm interpolation doesn't allocate. */
  private readonly swarmPoseScratch: InterpolatedPose = { x: 0, y: 0, angle: 0 };
  private readonly halo = new HaloRadar();
  private damageNumbers: DamageNumberManager | null = null;
  private healthBars: HealthBarManager | null = null;
  private labels: LabelManager | null = null;
  private backgroundGrid: BackgroundGrid | null = null;
  private starfield: StarfieldBackground | null = null;
  /**
   * Renderer → main-thread feedback (see `RendererFeedback`). Populated
   * at the tail of every `update()` call; consumers read via
   * `getFeedback()` after `update()` returns.
   *
   * Mutated in place each frame rather than reallocated — avoids
   * per-frame GC pressure. The Map is cleared + repopulated; the outer
   * object identity is stable.
   */
  private readonly feedback: RendererFeedback = {
    mountCounts: new Map<string, number>(),
    haloArrowCount: 0,
  };

  async init(rawContainer: unknown): Promise<void> {
    // Two init modes:
    //   - DOM context (main thread): rawContainer is an HTMLElement —
    //     we create a <canvas>, append it, size from clientWidth/Height.
    //     Install window resize + canvas event listeners.
    //   - Worker context (OffscreenCanvas): rawContainer is a
    //     `{ canvas: OffscreenCanvas; width; height; dpr }` bag — use
    //     the transferred canvas, size from the bag, no DOM listeners.
    //
    // The selector below is structural — checks for `transferControlToOffscreen`
    // on the host (DOM canvas has it; OffscreenCanvas itself does not).
    const isDom = typeof window !== 'undefined' && rawContainer instanceof HTMLElement;
    let initialW: number;
    let initialH: number;
    let initialDpr: number;
    let canvas: HTMLCanvasElement | OffscreenCanvas | undefined;
    let domContainer: HTMLElement | null = null;

    if (isDom) {
      domContainer = rawContainer as HTMLElement;
      initialW = domContainer.clientWidth || window.innerWidth;
      initialH = domContainer.clientHeight || window.innerHeight;
      initialDpr = window.devicePixelRatio ?? 1;
      // No `canvas:` option — Pixi creates one and we append it.
    } else {
      const bag = rawContainer as { canvas: OffscreenCanvas; width: number; height: number; dpr: number };
      canvas = bag.canvas;
      initialW = bag.width;
      initialH = bag.height;
      initialDpr = bag.dpr;
    }

    this.app = new Application();
    await this.app.init({
      ...(canvas ? { canvas: canvas as unknown as HTMLCanvasElement } : {}),
      width: initialW,
      height: initialH,
      background: BACKGROUND_COLOR,
      antialias: true,
      resolution: initialDpr,
      autoDensity: isDom,
    });
    if (domContainer) {
      domContainer.appendChild(this.app.canvas);
    }
    this.initialized = true;

    // Pixi v8 perf: disable per-sprite hit-test traversal on every
    // native pointer move (pixijs/pixijs#6515). Pre-refactor with
    // pixi-viewport, this was a major contention source. Skip in worker
    // context — `events.features` isn't initialised without a DOM event
    // source and the call would throw.
    if (isDom && this.app.renderer.events) {
      Object.assign(this.app.renderer.events.features, { globalMove: false });
    }

    // Starfield attached to app.stage BEFORE the world so it z-orders
    // below all gameplay (Pixi insertion-order z).
    this.starfield = new StarfieldBackground();
    this.starfield.attach(this.app);

    // World container hosts all camera-tracked gameplay. Pixi's
    // event-system traversal is opt-out (`eventMode='none'`) for the
    // gameplay subtree — see pixijs/pixijs#6515. Game-side taps are
    // routed via the Camera (which the App.tsx forwards canvas events
    // into), not Pixi's event system.
    this.world = new Container();
    this.world.eventMode = 'none';
    this.app.stage.addChild(this.world);

    this.camera = new Camera(this.world, { minScale: 0.4, maxScale: 3 });
    this.camera.setScreenSize(initialW, initialH);

    this.backgroundGrid = new BackgroundGrid();
    this.backgroundGrid.attach(this.camera);

    this.shipContainer = new Container();
    this.camera.addChild(this.shipContainer);

    this.halo.init(this.camera);
    this.damageNumbers = new DamageNumberManager(this.world);
    this.healthBars = new HealthBarManager(this.world);
    this.labels = new LabelManager(this.world);

    // Drive Camera momentum + follow each frame (works in both contexts).
    this.app.ticker.add(() => {
      this.camera.tick();
    });

    if (isDom && domContainer) {
      // Install canvas pointer/wheel listeners → camera state machine.
      // Camera replaces pixi-viewport's automatic event subscription.
      // Worker context: events arrive via postMessage and the worker
      // scaffolding (renderer.worker.ts) calls forwardPointerEvent /
      // forwardWheelEvent directly — no DOM listener path.
      this.installCanvasEventListeners(this.app.canvas);

      const measureSize = (): { w: number; h: number } => {
        const vv = window.visualViewport;
        const w = domContainer.clientWidth || vv?.width || window.innerWidth;
        const h = domContainer.clientHeight || vv?.height || window.innerHeight;
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
        this.camera.setScreenSize(w, h);
        this.starfield?.resize(w, h);
      };
      window.addEventListener('resize', resize);
      window.addEventListener('orientationchange', resize);
      window.visualViewport?.addEventListener('resize', resize);

      // Container-driven resize: catches layout settling on mobile (URL bar,
      // safe-area insets, dvh recalculation) that don't always fire window resize.
      const ro = new ResizeObserver(resize);
      ro.observe(domContainer);

      (this.app as unknown as Record<string, unknown>)['_resizeHandler'] = resize;
      (this.app as unknown as Record<string, unknown>)['_resizeObserver'] = ro;

      // Force one resize after the next frame to capture post-mount layout.
      requestAnimationFrame(resize);
    }
  }

  /**
   * Worker-context entry point. The renderer worker calls this when it
   * receives a RESIZE message — replicates the DOM resize() handler for
   * the OffscreenCanvas path.
   */
  resize(width: number, height: number): void {
    if (!this.initialized || !this.app?.renderer) return;
    this.app.renderer.resize(width, height);
    this.camera.setScreenSize(width, height);
    this.starfield?.resize(width, height);
  }

  /**
   * Worker-context entry point for synthesised pointer events forwarded
   * from the main thread. The Camera consumes via its state machine.
   */
  forwardPointerEvent(e: { type: string; pointerId: number; offsetX: number; offsetY: number; stamp: number }): void {
    switch (e.type) {
      case 'pointerdown':
        this.camera.onPointerDown(e.pointerId, e.offsetX, e.offsetY, e.stamp);
        break;
      case 'pointermove':
        this.camera.onPointerMove(e.pointerId, e.offsetX, e.offsetY);
        break;
      case 'pointerup':
        this.camera.onPointerUp(e.pointerId, e.offsetX, e.offsetY, e.stamp);
        break;
      case 'pointercancel':
      case 'pointerleave':
        this.camera.onPointerCancel(e.pointerId);
        break;
    }
  }

  /** Worker-context wheel forwarding. */
  forwardWheelEvent(deltaY: number, offsetX: number, offsetY: number): void {
    this.camera.onWheel(deltaY, offsetX, offsetY);
  }

  /**
   * Install pointer/wheel/touch listeners on the canvas and forward
   * them into the Camera. Replaces pixi-viewport's automatic
   * `events: app.renderer.events` subscription. Touch hijacking is
   * suppressed via `{ passive: false }` + `preventDefault`.
   */
  private readonly canvasListeners: Array<{ type: string; handler: EventListener; options?: AddEventListenerOptions }> = [];
  private installCanvasEventListeners(canvas: HTMLCanvasElement): void {
    const onPointer = (e: PointerEvent): void => {
      const stamp = Date.now();
      switch (e.type) {
        case 'pointerdown':
          this.camera.onPointerDown(e.pointerId, e.offsetX, e.offsetY, stamp);
          break;
        case 'pointermove':
          this.camera.onPointerMove(e.pointerId, e.offsetX, e.offsetY);
          break;
        case 'pointerup':
          this.camera.onPointerUp(e.pointerId, e.offsetX, e.offsetY, stamp);
          break;
        case 'pointercancel':
        case 'pointerleave':
          this.camera.onPointerCancel(e.pointerId);
          break;
      }
    };
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      this.camera.onWheel(e.deltaY, e.offsetX, e.offsetY);
    };
    const onTouchMove = (e: TouchEvent): void => {
      e.preventDefault();
    };
    const add = (type: string, handler: EventListener, options?: AddEventListenerOptions): void => {
      canvas.addEventListener(type, handler, options);
      this.canvasListeners.push({ type, handler, options });
    };
    add('pointerdown', onPointer as EventListener);
    add('pointermove', onPointer as EventListener);
    add('pointerup', onPointer as EventListener);
    add('pointercancel', onPointer as EventListener);
    add('pointerleave', onPointer as EventListener);
    add('wheel', onWheel as EventListener, { passive: false });
    add('touchmove', onTouchMove as EventListener, { passive: false });
  }

  update(mirror: RenderMirror): void {
    const seen = new Set<string>();

    // Precompute the sets of entities hit by any active beam this frame —
    // remote (other shooters' beams) and local (any mount on the local
    // player's ship). Multi-mount/turret refactor (Phase 2c): both
    // `mirror.remoteLasers` and `mirror.liveBeams` are now per-mount, so we
    // flatten across all mounts to drive the damage-flash tint logic.
    const remoteHitTargets = new Set<string>();
    if (mirror.remoteLasers) {
      for (const perShooter of mirror.remoteLasers.values()) {
        for (const laser of perShooter.values()) {
          if (laser.targetId) remoteHitTargets.add(laser.targetId);
        }
      }
    }
    const localHitTargets = new Set<string>();
    if (mirror.liveBeams) {
      for (const beam of mirror.liveBeams.values()) {
        if (beam.hitId) localHitTargets.add(beam.hitId);
      }
    }

    for (const [playerId, ship] of mirror.ships) {
      seen.add(playerId);

      let sprite = this.sprites.get(playerId);
      if (!sprite) {
        // Sprite is built once per ship from the catalogue's polygon + colour.
        // Local-vs-remote is communicated by the camera-follow rather than a
        // colour override, so all three kinds stay visually distinct.
        sprite = buildShipGfxFromShape(shapeForKind(ship.kind));
        this.shipContainer.addChild(sprite);
        this.sprites.set(playerId, sprite);
      }
      // Multi-mount/turret refactor (Phase 3): attach turret sprites + aim
      // lines per mount in this ship's catalogue entry. Idempotent — re-uses
      // the existing cluster if `ship.kind` hasn't changed. Legacy single-
      // mount ships render an invisible 0-offset 0-baseAngle stub that sits
      // beneath the body silhouette.
      this.mountVisuals.ensureForShip(playerId, ship.kind, sprite);
      // Phase 4b.2: apply this ship's current mount-rotation angles. The
      // local player's `tickLocalMountAim` populated `mirror.ships
      // .get(localId).mountAngles` last tick; remote players leave it
      // undefined (until Phase 4b.3 ships the snapshot anchor) and the
      // helper falls back to baseAngle, i.e. static barrels.
      const shipKind = getShipKind(ship.kind ?? null);
      const shipMounts = shipKind.mounts ?? [];
      if (shipMounts.length > 0) {
        this.mountVisuals.applyMountAngles(playerId, shipMounts, ship.mountAngles);
      }

      sprite.x = ship.x;
      sprite.y = -ship.y;
      sprite.rotation = -ship.angle;

      // Damage flash takes priority; beam hit tint is secondary.
      if (mirror.damagedShips?.has(playerId)) {
        sprite.tint = DAMAGE_FLASH_COLOR;
      } else if (localHitTargets.has(playerId) || remoteHitTargets.has(playerId)) {
        sprite.tint = 0xff2222;
      } else {
        sprite.tint = 0xffffff;
      }

      // Thrust flame — baseline, shown for ANY acceleration. Child of the
      // ship sprite so it inherits rotation. Lazy-created on first thrust.
      // Added BEFORE the boost flame so the boost plume layers visually on top.
      const isThrusting = mirror.thrustingShips?.has(playerId) ?? false;
      let thrustFlame = this.thrustFlames.get(playerId);
      if (isThrusting) {
        if (!thrustFlame) {
          thrustFlame = buildThrustFlameGfx();
          sprite.addChild(thrustFlame);
          this.thrustFlames.set(playerId, thrustFlame);
        }
        thrustFlame.visible = true;
        // Per-frame flicker so the plume reads as fire, not a static arrow.
        thrustFlame.scale.y = 0.85 + Math.random() * 0.4;
        thrustFlame.alpha   = 0.75 + Math.random() * 0.25;
      } else if (thrustFlame) {
        thrustFlame.visible = false;
      }

      // Boost flame — layered ON TOP of thrust when both are active. Lazily
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
        // Slightly stronger flicker range than baseline thrust for "intensity".
        flame.scale.y = 0.9 + Math.random() * 0.5;
        flame.alpha   = 0.8 + Math.random() * 0.2;
      } else if (flame) {
        flame.visible = false;
      }
    }

    // Explosion sprites spawned this frame for destroyed ships.
    // 2026-05-13 — look up the targetId across ALL three sprite maps
    // (active ships by playerId, lingering hulls + wrecks by
    // shipInstanceId). Previously this only checked `this.sprites`
    // (active-only) and defaulted to (0,0) when a lingering hull or
    // wreck was destroyed — the user's "explosion appeared at zero
    // zero" bug. Helper is in `spriteUpdateDecisions.ts` and is
    // unit-tested there.
    if (mirror.explodingShips) {
      // Wrap the lingering-sprite cache to expose just the {x, y}
      // pose the helper expects. The cache value also carries `kind`
      // which the helper doesn't need.
      const lingeringPosesView = new Map<string, { x: number; y: number }>();
      for (const [id, entry] of this.lingeringSprites) {
        lingeringPosesView.set(id, { x: entry.sprite.x, y: entry.sprite.y });
      }
      for (const targetId of mirror.explodingShips) {
        const pose = decideExplosionPosition({
          targetId,
          activeShipsByPlayerId: this.sprites,
          lingeringShipsByShipInstanceId: lingeringPosesView,
          wrecksByShipInstanceId: this.wreckSprites,
        });
        if (!pose) continue; // ship not in any map — skip the VFX
        const expl = buildExplosionGfx();
        expl.x = pose.x;
        expl.y = pose.y;
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
          if (entry.kind === 1) {
            // Drones use the same procedural shape as player ships of that
            // kind, so a Heavy drone visibly reads as a Heavy. Falls back to
            // the legacy magenta dart silhouette when the wire didn't carry a
            // kind (older snapshots / pre-v2 packets).
            sprite = entry.shipKind
              ? buildShipGfxFromShape(shapeForKind(entry.shipKind))
              : buildDroneGfx(entry.radius);
          } else {
            sprite = buildAsteroidGfx(entityId, entry.radius);
          }
          this.shipContainer.addChild(sprite);
          this.sprites.set(spriteKey, sprite);
        }
        // Drones (kind=1) post Phase 3 reset (2026-05-09): rendered from
        // `entry.x/y/angle`, which `ColyseusClient.updateMirror` rewrites
        // each frame to the predWorld pose. predWorld has AI-integrated
        // smooth motion matching the server; rendering at that pose
        // eliminates the per-snapshot snap that produced visible jolt
        // when the previous dead-reckoning path got the velocity-direction
        // change one packet late.
        //
        // Asteroids (kind=0) stay on `interpolateSwarmPose` — they're
        // locked in predWorld and only change pose on collision events,
        // where the packet-to-packet lerp is the right thing.
        if (entry.kind === 1) {
          sprite.x = entry.x;
          sprite.y = -entry.y;
          sprite.rotation = -entry.angle;
          // Phase 4c (2026-05-11) — drones get the same mount cluster
          // treatment as player ships: turret sprites parented to the
          // drone body, rotated per-mount via the snapshot-anchored
          // `entry.mountAngles`. Legacy single-mount drone kinds have
          // zero-arc mounts so applyMountAngles is essentially a no-op
          // (sets rotation to -baseAngle, same as the static Phase-3
          // path); multi-mount kinds (interceptor / gunship drones)
          // now visibly slew their wing/rear turrets to track players.
          if (entry.shipKind) {
            this.mountVisuals.ensureForShip(spriteKey, entry.shipKind, sprite);
            const swarmKind = getShipKind(entry.shipKind);
            const swarmMounts = swarmKind.mounts ?? [];
            if (swarmMounts.length > 0) {
              this.mountVisuals.applyMountAngles(spriteKey, swarmMounts, entry.mountAngles);
            }
          }
        } else {
          const lerped = interpolateSwarmPose(entry, now, this.swarmPoseScratch);
          sprite.x = lerped.x;
          sprite.y = -lerped.y;
          sprite.rotation = -lerped.angle;
        }
        // Damage flash takes priority over the active-beam hit tint so a
        // drone clearly registers a hit even when no beam is currently on it.
        if (mirror.damagedShips?.has(spriteKey)) {
          sprite.tint = DAMAGE_FLASH_COLOR;
        } else if (localHitTargets.has(spriteKey) || remoteHitTargets.has(spriteKey)) {
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
        // Boost flame and mount-visual cluster are children — destroy({
        // children: true }) frees them too, but we still drop the map
        // entries so a respawn rebuilds cleanly.
        this.mountVisuals.removeShip(id);
        sprite.destroy({ children: true });
        this.sprites.delete(id);
        this.boostFlames.delete(id);
        this.thrustFlames.delete(id);
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
          } else if (proj.weaponId === 'laser') {
            ps = buildLaserBoltGfx();
          } else {
            ps = buildProjectileGfx(proj.isGhost ?? false);
          }
          this.shipContainer.addChild(ps);
          this.projectileSprites.set(projId, ps);
        }
        ps.x = proj.x;
        ps.y = -proj.y;
        ps.alpha = proj.alpha ?? 1;
        // Rotate laser bolts to face their velocity heading.
        if (proj.weaponId === 'laser' && !proj.beam) {
          ps.rotation = -Math.atan2(proj.vy, proj.vx) + Math.PI / 2;
        }
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
    // server-acked shot events (every ~167ms).
    //
    // Multi-mount/turret refactor (Phase 2c): `mirror.remoteLasers` is now
    // `Map<shooterId, Map<mountId, laser>>`. We iterate the nested map and
    // resolve each mount's local offset from the shooter's ship-kind catalogue
    // entry, so multi-mount ships emit beams from the correct barrel positions
    // (not all stacked at the ship centre). Legacy single-mount ships have
    // mount.localX/Y = (0, 0) and baseAngle = 0, so the geometry collapses to
    // the pre-refactor "ship.pos + 20 u forward" path.
    if (mirror.remoteLasers && mirror.remoteLasers.size > 0) {
      if (!this.remoteBeamGfx) {
        this.remoteBeamGfx = new Graphics();
        this.shipContainer.addChild(this.remoteBeamGfx);
      }
      this.remoteBeamGfx.clear();
      const now = performance.now();
      for (const [shooterId, perShooter] of mirror.remoteLasers) {
        // Player shooters track their live ship pose; the beam sweeps with the
        // ship's rotation between fire events. AI shooters track their
        // mirror.swarm pose for the same reason — drones move every tick, so
        // a wire-frozen beam origin would re-anchor on each fire (visible
        // jump). Falls back to the wire endpoints if the shooter isn't found
        // (defensive — e.g. ID mapping mismatch).
        const shooter = mirror.ships.get(shooterId);
        let swarmShooter: { x: number; y: number; angle: number; radius: number; shipKind?: string } | null = null;
        if (!shooter && shooterId.startsWith('swarm-')) {
          const entityId = parseInt(shooterId.slice('swarm-'.length), 10);
          if (!Number.isNaN(entityId)) {
            const sw = mirror.swarm?.get(entityId);
            if (sw) {
              // Use the SAME pose the sprite is drawn at — drones (kind=1)
              // render from `entry.x/y/angle` directly post-2026-05-09 reset
              // (predWorld pose synced into the mirror each frame). Asteroids
              // stay on the lerp path for parity with their sprite render.
              if (sw.kind === 1) {
                swarmShooter = { x: sw.x, y: sw.y, angle: sw.angle, radius: sw.radius, shipKind: sw.shipKind };
              } else {
                const lerped = interpolateSwarmPose(sw, now, this.swarmPoseScratch);
                swarmShooter = { x: lerped.x, y: lerped.y, angle: lerped.angle, radius: sw.radius, shipKind: sw.shipKind };
              }
            }
          }
        }

        const shooterKindId = shooter?.kind ?? swarmShooter?.shipKind ?? null;
        const shooterKind = getShipKind(shooterKindId);

        for (const [mountId, laser] of perShooter) {
          // Hold full brightness while shooter is actively firing; fade only
          // in the last 150 ms of TTL (i.e. after they stop shooting). With
          // WEAPON_COOLDOWN = 167 ms and TTL = 400 ms, each new shot resets
          // expiresAt well before the fade window, so the beam is solid-on
          // while space is held.
          const ttlRemaining = laser.expiresAt - now;
          const alpha = ttlRemaining > 150 ? 1.0 : Math.max(0, ttlRemaining / 150);

          // Resolve the mount's ship-local offset from the catalogue. Falls
          // back to a zero-offset zero-baseAngle stub for unknown mount ids
          // so a pre-2c server (no mountId in the wire) still renders.
          // Phase 4b.2: pick up the shooter's per-mount slewed angle from
          // `mirror.ships.get(id).mountAngles` (player shooters); Phase 4c
          // adds the same for drone shooters via `mirror.swarm.get(id).
          // mountAngles` (snapshot-anchored, in-interest drones only).
          const mount = shooterKind.mounts?.find((m) => m.id === mountId);
          const mountIdx = shooterKind.mounts?.findIndex((m) => m.id === mountId) ?? -1;
          let currentMountAngle = 0;
          if (shooter && mount && mountIdx >= 0) {
            currentMountAngle = shooter.mountAngles?.[mountIdx] ?? 0;
          } else if (swarmShooter && mount && mountIdx >= 0) {
            // Pull the drone's per-mount angle out of the swarm mirror —
            // ColyseusClient writes it from `snap.drones[].mountAngles`
            // when the drone is in-interest. Out-of-interest → undefined
            // → currentMountAngle stays 0 (barrel at baseAngle, no rotation).
            const entityId = parseInt(shooterId.slice('swarm-'.length), 10);
            if (!Number.isNaN(entityId)) {
              const sw = mirror.swarm?.get(entityId);
              currentMountAngle = sw?.mountAngles?.[mountIdx] ?? 0;
            }
          }

          let fromX: number;
          let fromY: number;
          let toX: number;
          let toY: number;
          if (shooter) {
            const origin = applyMountOffset(shooter.x, shooter.y, shooter.angle, mount);
            const fireAngle = shooter.angle + (mount?.baseAngle ?? 0) + currentMountAngle;
            const fwdX = -Math.sin(fireAngle);
            const fwdY =  Math.cos(fireAngle);
            fromX = origin.x + fwdX * 20;
            fromY = origin.y + fwdY * 20;
            toX = fromX + fwdX * laser.range;
            toY = fromY + fwdY * laser.range;
          } else if (swarmShooter) {
            const origin = applyMountOffset(swarmShooter.x, swarmShooter.y, swarmShooter.angle, mount);
            const fireAngle = swarmShooter.angle + (mount?.baseAngle ?? 0) + currentMountAngle;
            const fwdX = -Math.sin(fireAngle);
            const fwdY =  Math.cos(fireAngle);
            // Drone barrel offset is `radius + 2` along the mount's fire
            // direction (no mount → centre of drone). Matches the
            // pre-refactor visual where the beam clears the drone hull.
            const barrelOffset = mount ? 20 : swarmShooter.radius + 2;
            fromX = origin.x + fwdX * barrelOffset;
            fromY = origin.y + fwdY * barrelOffset;
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
      }
      this.remoteBeamGfx.visible = true;
    } else if (this.remoteBeamGfx) {
      this.remoteBeamGfx.visible = false;
    }

    // Live hitscan beams — one per mount in the local ship's active slot.
    // Derive geometry from the local ship's lerped pose in mirror.ships each
    // frame so beams stay glued to the ship sprite even during a server-
    // correction lerp. (Mirrors the remote-beam pattern above — single source
    // of truth: "where the ship is visually right now".)
    //
    // Multi-mount/turret refactor (Phase 2c): `mirror.liveBeams` is now a
    // per-mount map. Legacy single-mount fighter/scout/heavy has exactly one
    // entry keyed by `'forward'`; multi-mount kinds (Phase 3) get one entry
    // per barrel and each draws independently.
    const localShip = mirror.localPlayerId ? mirror.ships.get(mirror.localPlayerId) : null;
    if (mirror.liveBeams && mirror.liveBeams.size > 0 && localShip) {
      if (!this.liveBeamGfx) {
        this.liveBeamGfx = new Graphics();
        this.shipContainer.addChild(this.liveBeamGfx);
      }
      this.liveBeamGfx.clear();
      const localKind = getShipKind(localShip.kind ?? null);
      const localMounts = localKind.mounts ?? [];
      for (const [mountId, beam] of mirror.liveBeams) {
        const mountIdx = localMounts.findIndex((m) => m.id === mountId);
        const mount = mountIdx >= 0 ? localMounts[mountIdx] : undefined;
        // Phase 4b.2: add the per-mount slewed angle so the beam emerges
        // in the same direction as the visibly-rotated barrel sprite.
        const currentMountAngle = mountIdx >= 0 ? (localShip.mountAngles?.[mountIdx] ?? 0) : 0;
        const origin = applyMountOffset(localShip.x, localShip.y, localShip.angle, mount);
        const fireAngle = localShip.angle + (mount?.baseAngle ?? 0) + currentMountAngle;
        const fwdX = -Math.sin(fireAngle);
        const fwdY =  Math.cos(fireAngle);
        const fromX = origin.x + fwdX * 20;
        const fromY = origin.y + fwdY * 20;
        const toX = fromX + fwdX * beam.dist;
        const toY = fromY + fwdY * beam.dist;
        // Outer glow
        this.liveBeamGfx.moveTo(fromX, -fromY).lineTo(toX, -toY);
        this.liveBeamGfx.stroke({ color: LASER_BEAM_COLOR, width: 3, alpha: 0.4 });
        // Bright core
        this.liveBeamGfx.moveTo(fromX, -fromY).lineTo(toX, -toY);
        this.liveBeamGfx.stroke({ color: LASER_CORE_COLOR, width: 1, alpha: 1 });
      }
      this.liveBeamGfx.visible = true;
    } else {
      if (this.liveBeamGfx) this.liveBeamGfx.visible = false;
    }

    const local = mirror.localPlayerId ? this.sprites.get(mirror.localPlayerId) : null;
    if (local) {
      this.camera.moveCenter(local.x, local.y);
    }

    // Background layers — run AFTER moveCenter so they use this frame's
    // camera position (otherwise stars and grid lag by one frame).
    this.starfield?.update(this.camera);
    this.backgroundGrid?.update(this.camera);

    // Drain pending damage numbers and spawn floating text.
    if (this.damageNumbers && mirror.pendingDamageNumbers) {
      for (const dn of mirror.pendingDamageNumbers) {
        this.damageNumbers.spawn(dn.x, dn.y, dn.damage);
      }
      mirror.pendingDamageNumbers.length = 0;
      this.damageNumbers.update();
    }

    // Drain pending health bar hits and update bars.
    if (this.healthBars && mirror.pendingHealthBarHits) {
      for (const hb of mirror.pendingHealthBarHits) {
        this.healthBars.onHit(hb.entityId, hb.healthPct);
      }
      mirror.pendingHealthBarHits.length = 0;
      this.healthBars.update(mirror);
    }

    // Phase 1 — name labels above remote ships and drones (skip self).
    this.labels?.update(mirror);

    // Phase 4 — render / update / sweep wrecks. Wrecks are drawn with
    // the ship-kind silhouette desaturated and slightly transparent to
    // sell "broken hull, no pilot". No mount aim lines, no name label,
    // no exhaust. Y-flip matches the rest of the renderer.
    this.updateWrecks(mirror);
    this.updateLingeringShips(mirror);

    // Halo arrows for off-screen POIs. Runs after moveCenter so the visibility
    // test uses this frame's viewport bounds, not last frame's.
    this.halo.update(mirror);

    // ---------- RendererFeedback (end-of-frame, main-thread readable) ----------
    // Populate the feedback struct that main reads after update() returns.
    // Today this is sync-mutate (renderer and main share a process).
    // Phase 4 of the worker migration will replace this with a FEEDBACK
    // postMessage from the renderer worker; the contract surface stays
    // the same (caller does `renderer.getFeedback()`).
    this.feedback.mountCounts.clear();
    for (const shipId of mirror.ships.keys()) {
      const count = this.mountVisuals.mountCountForShip(shipId);
      if (count > 0) this.feedback.mountCounts.set(shipId, count);
    }
    this.feedback.haloArrowCount = this.halo.getDebugVisibleArrowCount();
  }

  /** Phase 6b — parallel to `updateWrecks`. Lingering hulls (players who
   *  disconnected within the 15-min linger window OR whose ships have
   *  been displaced from `playerToSlot` by a fresh spawn) are drawn with
   *  the SAME silhouette + colour as the live ship (NOT the desaturated
   *  wreck tint — they still belong to a real player), with a slight
   *  alpha drop (0.75) as a visual cue for "this hull is parked, the
   *  pilot isn't currently flying it".
   *
   *  Phase A3: the create-vs-rebuild-vs-reposition decision is delegated
   *  to `decideLingeringSpriteAction` (pure, unit-tested). The previous
   *  inline version's `if (!ship.kind) continue` skip left lingering
   *  hulls permanently invisible when the schema diff was late; the
   *  extracted helper makes the fallback-kind behaviour an explicit
   *  contract and prevents regression. */
  private readonly lingeringSprites = new Map<string, { sprite: Container; kind: string }>();
  private updateLingeringShips(mirror: RenderMirror): void {
    if (!mirror.lingeringShips || mirror.lingeringShips.size === 0) {
      if (this.lingeringSprites.size > 0) {
        for (const entry of this.lingeringSprites.values()) entry.sprite.destroy();
        this.lingeringSprites.clear();
      }
      return;
    }
    const seen = new Set<string>();
    for (const [shipInstanceId, ship] of mirror.lingeringShips) {
      seen.add(shipInstanceId);
      const decision = decideLingeringSpriteAction({
        cached: this.lingeringSprites.get(shipInstanceId),
        currentKind: ship.kind,
        fallbackKind: 'fighter',
      });
      let entry = this.lingeringSprites.get(shipInstanceId);
      if (decision.action === 'rebuild') {
        entry!.sprite.destroy();
        this.lingeringSprites.delete(shipInstanceId);
        entry = undefined;
      }
      if (decision.action === 'create' || decision.action === 'rebuild') {
        const shape = shapeForKind(decision.kind);
        const sprite = buildShipGfxFromShape(shape, shape.color);
        sprite.alpha = 0.75;
        this.shipContainer.addChild(sprite);
        entry = { sprite, kind: decision.kind };
        this.lingeringSprites.set(shipInstanceId, entry);
      }
      // 'skip' is reserved for wreck-kind-missing diagnostics; not
      // produced by the lingering decision today. Be defensive anyway.
      if (decision.action === 'skip' || !entry) continue;
      entry.sprite.x = ship.x;
      entry.sprite.y = -ship.y;
      entry.sprite.rotation = -ship.angle;
    }
    for (const [id, entry] of this.lingeringSprites) {
      if (!seen.has(id)) {
        entry.sprite.destroy();
        this.lingeringSprites.delete(id);
      }
    }
  }

  private updateWrecks(mirror: RenderMirror): void {
    if (!mirror.wrecks) {
      for (const g of this.wreckSprites.values()) g.destroy();
      this.wreckSprites.clear();
      return;
    }
    const seen = new Set<string>();
    for (const [shipInstanceId, w] of mirror.wrecks) {
      seen.add(shipInstanceId);
      let sprite = this.wreckSprites.get(shipInstanceId);
      if (!sprite) {
        const shape = shapeForKind(w.kind);
        sprite = buildShipGfxFromShape(shape, desaturate(shape.color));
        sprite.alpha = 0.55;
        this.shipContainer.addChild(sprite);
        this.wreckSprites.set(shipInstanceId, sprite);
      }
      sprite.x = w.x;
      sprite.y = -w.y;
      sprite.rotation = -w.angle;

      // Phase 4 — wreck visual feedback when taking damage. The
      // damage-flash machinery is keyed by the wire targetId (which is
      // `wreck-${shipInstanceId}` for wrecks); `mirror.damagedShips`
      // gets that id from handleDamage so we can flash here too.
      const wreckEntityId = `wreck-${shipInstanceId}`;
      const flashing = mirror.damagedShips?.has(wreckEntityId) ?? false;
      sprite.tint = flashing ? DAMAGE_FLASH_COLOR : 0xffffff;
    }
    for (const [id, sprite] of this.wreckSprites) {
      if (!seen.has(id)) {
        sprite.destroy();
        this.wreckSprites.delete(id);
      }
    }
  }

  /**
   * Attach a screen-space overlay container to the stage, **above** the
   * viewport. Used by the in-game galaxy-map overlay (Map B): the consumer
   * constructs a `GalaxyMapLayer` (a Pixi `Container`) and hands it here.
   * Layered above `viewport` so it doesn't pan/zoom with the world camera.
   */
  addOverlayContainer(overlay: unknown): void {
    if (!this.initialized) return;
    this.app.stage.addChild(overlay as Container);
  }

  /**
   * Cap the Pixi ticker. Three modes:
   *   - `undefined` → remove any cap (Pixi default — uncapped vsync).
   *   - `number` (e.g. 30) → throttle to that max FPS.
   *   - `null` → **pause the ticker entirely** (no callbacks fire).
   *
   * Used by `GameSurface` to manage CPU contention while the
   * AdvancedDrawer / GalaxyOverviewScreen is open:
   *   - For real users: throttle to 30 fps so the gameplay underneath
   *     the drawer remains visible/animated. Drawer is partial-width;
   *     the canvas is still on-screen.
   *   - Under Playwright automation (`navigator.webdriver === true`):
   *     pause entirely. CDP roundtrip otherwise climbs to ~500 ms
   *     median (measured 2026-05-14 via
   *     `tests/e2e/drawer-cdp-starvation-probe.spec.ts`), which makes
   *     interactive drawer specs flake at the boundary of 120 s test
   *     budgets. Pausing frees the main thread entirely; gameplay
   *     state still updates via the React rAF loop / Colyseus apply,
   *     just the Pixi draw is suspended. Invisible to a focused user;
   *     test-only behavior.
   *
   * See `docs/LESSONS.md` 2026-05-13 §6 carry-forward.
   */
  setTickerMaxFPS(fps: number | null | undefined): void {
    if (!this.initialized) return;
    if (fps === null) {
      this.app.ticker.stop();
      return;
    }
    if (!this.app.ticker.started) this.app.ticker.start();
    this.app.ticker.maxFPS = fps ?? 0;
  }

  /**
   * Read the most recent feedback the renderer wrote at the tail of its
   * last `update()` call. See `IRenderer.getFeedback` / `RendererFeedback`
   * — the contract surface for both today (sync mutate) and the future
   * worker-renderer path (postMessage cache).
   */
  getFeedback(): RendererFeedback {
    return this.feedback;
  }

  /**
   * Test-only — number of currently-visible halo arrows.
   * @deprecated Read `getFeedback().haloArrowCount` instead. Kept for
   * backward-compat with any external consumer; the production read
   * site (`App.tsx`) uses `getFeedback()`.
   */
  getDebugHaloArrowCount(): number {
    return this.feedback.haloArrowCount;
  }

  /**
   * Multi-mount/turret refactor (Phase 3) — number of mount sprites
   * currently parented to the given ship's main Pixi sprite. Test-only;
   * exposed via the `data-mount-count` attribute in `App.tsx` so E2E
   * specs can assert that multi-mount ship kinds wire visible turrets.
   * @deprecated Read `getFeedback().mountCounts.get(shipId) ?? 0` instead.
   */
  mountCountForShip(shipId: string): number {
    return this.feedback.mountCounts.get(shipId) ?? 0;
  }

  dispose(): void {
    if (!this.initialized) return;
    // Flip the flag FIRST so any rAF / ResizeObserver callback that fires
    // between here and the actual destroy() short-circuits cleanly. Without
    // this, the queued requestAnimationFrame(resize) at the end of init()
    // could land post-destroy and read a null renderer.
    this.initialized = false;
    // Remove canvas pointer / wheel / touch listeners so an in-flight
    // event doesn't reach a destroyed Camera.
    const canvas = this.app?.canvas;
    if (canvas) {
      for (const { type, handler, options } of this.canvasListeners) {
        canvas.removeEventListener(type, handler, options);
      }
    }
    this.canvasListeners.length = 0;
    const handler = (this.app as unknown as Record<string, unknown>)['_resizeHandler'];
    if (typeof handler === 'function') {
      window.removeEventListener('resize', handler as EventListener);
      window.removeEventListener('orientationchange', handler as EventListener);
      window.visualViewport?.removeEventListener('resize', handler as EventListener);
    }
    const ro = (this.app as unknown as Record<string, unknown>)['_resizeObserver'];
    if (ro instanceof ResizeObserver) ro.disconnect();
    this.damageNumbers?.destroy();
    this.healthBars?.destroy();
    this.labels?.destroy();
    this.mountVisuals.disposeAll();
    this.halo.destroy();
    this.backgroundGrid?.destroy();
    this.starfield?.destroy();
    this.app.destroy(true, { children: true });
  }
}
