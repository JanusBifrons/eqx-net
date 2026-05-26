import { Application, Graphics, Container } from 'pixi.js';
import { Camera } from './worker/Camera';
import type { IRenderer, RenderMirror, RendererFeedback } from '@core/contracts/IRenderer';
import { type WarpParams, type WarpCenter, type FrameMarkers } from './worker/protocol';
import { WarpFilterChain } from './pixi/WarpFilterChain.js';
import { fillHitTargetSets } from './pixi/hitTargetSets.js';
import { updateShipSprites } from './pixi/shipSpriteUpdater.js';
import { updateSwarmSprites } from './pixi/swarmSpriteUpdater.js';
import { updateProjectileSprites } from './pixi/projectileSpriteUpdater.js';
import { interpolateSwarmPose, type InterpolatedPose } from '../net/swarmInterpolation';
import { HaloRadar } from './HaloRadar';
import { DamageNumberManager } from './DamageNumbers';
import { HealthBarManager } from './HealthBars';
import { LabelManager } from './Labels';
import { decideLingeringSpriteAction, decideExplosionPosition } from './spriteUpdateDecisions';
import { MountVisualManager } from './MountVisualManager';
import { BackgroundGrid } from './BackgroundGrid';
import { StarfieldBackground } from './StarfieldBackground';
import { getShipKind } from '../../shared-types/shipKinds';
import {
  DAMAGE_FLASH_COLOR,
  buildShipGfxFromShape,
  shapeForKind,
  desaturate,
  buildGhostGfx,
  applyMountOffset,
  buildExplosionGfx,
} from './pixi/spriteBuilders.js';

// Most colour + builder constants moved to pixi/spriteBuilders.ts;
// the constants below are PixiRenderer-specific (background tint,
// remote-laser colour used by inline beam draw in update()).
const BACKGROUND_COLOR = 0x05070f;
const REMOTE_LASER_COLOR = 0xff6600;
const LASER_BEAM_COLOR = 0x00eeff;
const LASER_CORE_COLOR = 0xffffff;

/**
 * Load-curtain tween constants. The curtain rises quickly (so the
 * canvas doesn't briefly leak through during the transition into
 * loading) and fades over the same window as `flashDurationMs` so the
 * arrival flash can hide the curtain fade.
 */
// CURTAIN_* + warp helpers now used inside WarpFilterChain.ts.
// Re-exported here so existing test imports keep working.
export {
  shouldDetachWarpVisual,
  warpEventFiresBurst,
  resolveWarpFilterCenter,
  type WarpBurstEvent,
} from './pixi/warpHelpers.js';


// Sprite/Graphics builders moved to ./pixi/spriteBuilders.ts — pure
// constructors of Pixi Graphics instances, no class state. The
// orchestrator below imports them from that module.

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
  /**
   * Warp-mode render state — the "loading screen" rendered ON the same
   * canvas as gameplay (no separate Pixi Application). When `warpActive`
   * is true the renderer attaches a stack of `ShockwaveFilter` instances
   * to `app.stage`. Each filter advances its `time` uniform on a phase
   * offset so multiple concentric ripples expand from screen centre
   * simultaneously, growing in amplitude as warp progress ramps up.
   *
   * `warpIntensity` ∈ [0, 1] is the **fade-out scalar** — 1 while warp
   * is armed and steady, ramping to 0 over `fadeOutMs` after
   * `setWarpMode(false)`. The amplitude **ramp-up** is separately driven
   * by `warpStartedAt` over `warpParams.rampMs`.
   *
   * Filter array is built lazily on first `setWarpMode(true)` and
   * preserved across re-entry. Tunable params live in `warpParams`
   * (defaults from `DEFAULT_WARP_PARAMS`); the visual-effects sandbox
   * spike posts `SET_WARP_PARAMS` to mutate them live for iteration.
   *
   * Why ShockwaveFilter-only: prior 3-filter chain (OldFilm + Shockwave
   * + RGBSplit) was expensive on mobile because OldFilm regenerates
   * procedural noise + scratches per-frame. ShockwaveFilter is a single
   * radial-displacement pass (cheap), so stacking 4 of them costs less
   * than the prior chain while producing the rippling effect more
   * directly. GlitchFilter remains unusable in worker context — see
   * `WarpParams` doc in `worker/protocol.ts`.
   */
  /** Warp visual chain (shockwave + bloom + flash + load curtain).
   *  Extracted to `pixi/WarpFilterChain.ts`. Constructed in `init()`. */
  private warp!: WarpFilterChain;
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
  /** 2026-05-25 heap-growth gate step 6 — persistent scratches for the
   *  five containers `update()` allocated per frame (60-90 Hz). Each
   *  is `.clear()`'d at the start of `update()` and refilled. The
   *  `lingeringPosesView` Map's per-entry `{x, y}` literals are also
   *  pooled via `_explosionPoseEntries` (grow-once, reused thereafter).
   *  Pre-fix: 5 containers + N{x,y} entries per frame = real allocator
   *  pressure under combat (see capture lnnkkh, 2026-05-25). */
  private readonly _updateSeenScratch = new Set<string>();
  private readonly _updateRemoteHitTargetsScratch = new Set<string>();
  private readonly _updateLocalHitTargetsScratch = new Set<string>();
  private readonly _updateLingeringPosesView = new Map<string, { x: number; y: number }>();
  private readonly _updateLingeringPoseEntries: { x: number; y: number }[] = [];
  private readonly _updateProjSeenScratch = new Set<string>();
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
    damageNumberActiveCount: 0,
    wreckSpriteCount: 0,
    firstFrameRendered: false,
  };

  /**
   * F1 instrumentation — per-frame worker-side sub-costs (warp-spool
   * perf investigation, `docs/HANDOFF-warp-spool-perf-followup.md`).
   * Mutated in place at the tail of `update()` (no per-frame alloc); the
   * worker reads it via `getFrameMarkers()` after `update()` returns and
   * posts a `FRAME_MARKERS` message ONLY when diagnostics are enabled.
   * `warpTickMs` / `filterCount` are written by the `tickWarpShockwaves`
   * ticker callback (a separate Pixi ticker, not part of `update()`), so
   * each `FRAME_MARKERS` carries the most recent warp-tick cost.
   *
   * This is deliberately NOT on `RendererFeedback` — that's a
   * phase-gated closed-set DI contract (see `IRenderer.ts` /
   * `src/client/CLAUDE.md`); a separate gated channel keeps the
   * contract untouched and the production cost at zero.
   */
  private readonly frameMarkers: FrameMarkers = {
    rendererUpdateMs: 0,
    spriteCount: 0,
    warpTickMs: 0,
    filterCount: 0,
    warpFiltersAttached: false,
    warpBurstAgeMs: -1,
    gridLabelSpecMs: 0,
    gridTextCreateMs: 0,
    gridCleanupMs: 0,
    gridLabelCount: 0,
  };

  /** Read the most recent per-frame sub-cost markers. See `FrameMarkers`
   *  + `getFeedback()` for the parallel (but contract-gated) channel. */
  getFrameMarkers(): FrameMarkers {
    return this.frameMarkers;
  }

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

    // followLerpFactor=1 → instant follow each Pixi tick (60 Hz). This
    // matches pre-migration pixi-viewport's `viewport.moveCenter(x, y)`
    // every frame, but driven by the Pixi ticker rather than the per-
    // `update(mirror)` cadence. Decoupling from MIRROR_UPDATE eliminates
    // the wheel-zoom vibration that throttled mirror updates introduced
    // (camera was snapping between zoom-target and centered position
    // every other frame).
    this.camera = new Camera(this.world, {
      minScale: 0.4,
      maxScale: 3,
      followLerpFactor: 1,
    });
    this.camera.setScreenSize(initialW, initialH);

    // Warp visual chain — extracted to `pixi/WarpFilterChain.ts`.
    // Lazy-builds its stage on first setWarpMode/triggerWarpIn/setLoadCurtain.
    this.warp = new WarpFilterChain(
      this.app,
      this.world,
      this.camera,
      (entityId) => {
        const s = this.sprites.get(entityId);
        return s ? { x: s.x, y: s.y } : undefined;
      },
      this.frameMarkers,
    );

    this.backgroundGrid = new BackgroundGrid();
    this.backgroundGrid.attach(this.camera);

    this.shipContainer = new Container();
    this.camera.addChild(this.shipContainer);

    this.halo.init(this.camera);
    // Damage numbers attach to the world (pan with camera, anchored at
    // impact world coord) but counter-scale per frame so they stay
    // legible at any zoom — Camera ref needed for the per-frame
    // counter-scale.
    this.damageNumbers = new DamageNumberManager(this.world, this.camera);
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
      case 'pointerup': {
        const result = this.camera.onPointerUp(e.pointerId, e.offsetX, e.offsetY, e.stamp);
        // Confirmed tap (single pointer, short duration, small distance):
        // route to the registered tap-handler. The worker uses this to
        // hit-test the GalaxyMapLayer (since Pixi's event subsystem
        // isn't initialised without a DOM event source).
        if (result.wasTap && this.onTap) {
          this.onTap(e.offsetX, e.offsetY);
        }
        break;
      }
      case 'pointercancel':
      case 'pointerleave':
        this.camera.onPointerCancel(e.pointerId);
        break;
    }
  }

  /**
   * Register a confirmed-tap handler. Fired by `forwardPointerEvent`
   * when Camera resolves a tap (short, low-distance pointer cycle).
   * Coords passed in are the canvas-local pixel position of the tap
   * (DPR-scaled per `WorkerRendererClient.serialisePointer`).
   *
   * Worker-only — DOM-mode Pixi uses its native event system instead.
   */
  private onTap: ((screenX: number, screenY: number) => void) | null = null;
  setOnTap(handler: ((screenX: number, screenY: number) => void) | null): void {
    this.onTap = handler;
  }

  /**
   * Add a screen-space galaxy-map overlay to the stage and register a
   * tap handler. Convenience wrapper for the worker path: the worker
   * constructs the layer, hands it here, and supplies the
   * "what to do on tap" lambda (which posts OVERLAY_TAPPED back to
   * main thread).
   */
  addGalaxyOverlay(layer: Container, onTapInside: (screenX: number, screenY: number) => void): void {
    if (!this.initialized) return;
    this.app.stage.addChild(layer);
    this.setOnTap(onTapInside);
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
    // F1 — bracket the whole update() for `rendererUpdateMs`. Single
    // exit point (the method has no early `return`), so a start-stamp +
    // tail-write is exact. Sub-µs, unconditional (markers-off baseline =
    // production cost). See `frameMarkers` / `FrameMarkers`.
    const updateStart = performance.now();
    // 2026-05-25 heap-growth gate step 6: reuse persistent scratch
    // containers instead of `new Set<string>()` per frame.
    const seen = this._updateSeenScratch;
    seen.clear();

    // Per-frame hit-target sets — see pixi/hitTargetSets.ts.
    const remoteHitTargets = this._updateRemoteHitTargetsScratch;
    const localHitTargets = this._updateLocalHitTargetsScratch;
    fillHitTargetSets(mirror, remoteHitTargets, localHitTargets);

    // Active-ship sprite update — sprite creation, pose, tint, thrust
    // + boost flames. See pixi/shipSpriteUpdater.ts.
    updateShipSprites(mirror, {
      shipContainer: this.shipContainer,
      sprites: this.sprites,
      thrustFlames: this.thrustFlames,
      boostFlames: this.boostFlames,
      mountVisuals: this.mountVisuals,
      remoteHitTargets,
      localHitTargets,
      seenScratch: seen,
    });

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
      // 2026-05-25 heap-growth gate step 6: persistent Map + pooled
      // {x,y} entries (peak == lingering-sprite count; grow-once).
      const lingeringPosesView = this._updateLingeringPosesView;
      lingeringPosesView.clear();
      const lingeringPoseEntries = this._updateLingeringPoseEntries;
      let lingeringPoseIdx = 0;
      for (const [id, entry] of this.lingeringSprites) {
        let pose = lingeringPoseEntries[lingeringPoseIdx];
        if (!pose) {
          pose = { x: 0, y: 0 };
          lingeringPoseEntries[lingeringPoseIdx] = pose;
        }
        pose.x = entry.sprite.x;
        pose.y = entry.sprite.y;
        lingeringPosesView.set(id, pose);
        lingeringPoseIdx++;
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

    // Phase 5c swarm sprites (asteroids + drones) — see
    // pixi/swarmSpriteUpdater.ts.
    updateSwarmSprites(mirror, {
      shipContainer: this.shipContainer,
      sprites: this.sprites,
      mountVisuals: this.mountVisuals,
      swarmPoseScratch: this.swarmPoseScratch,
      remoteHitTargets,
      localHitTargets,
      seenScratch: seen,
    });

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

    // Projectile + ghost-projectile sprites — see pixi/projectileSpriteUpdater.ts.
    updateProjectileSprites(mirror, {
      shipContainer: this.shipContainer,
      projectileSprites: this.projectileSprites,
      projSeenScratch: this._updateProjSeenScratch,
    });

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
      // `follow` (not `moveCenter`) — the camera's per-tick interpolator
      // applies this target every Pixi frame (60 Hz), independent of
      // `update()` cadence. With `followLerpFactor: 1` the follow is
      // instant — matches the original every-frame `moveCenter` feel
      // but runs at ticker speed not MIRROR_UPDATE speed. See Camera
      // construction in init() for the rationale.
      this.camera.follow({ x: local.x, y: local.y });
    }

    // Background layers — run AFTER moveCenter so they use this frame's
    // camera position (otherwise stars and grid lag by one frame).
    this.starfield?.update(this.camera);
    this.backgroundGrid?.update(this.camera);

    // Drain pending damage numbers and spawn floating text. update()
    // must be OUTSIDE the spawn-drain block — sub-managers need to
    // tick every frame to advance lifetime + counter-scale.
    if (this.damageNumbers && mirror.pendingDamageNumbers) {
      for (const dn of mirror.pendingDamageNumbers) {
        this.damageNumbers.spawn(dn.x, dn.y, dn.damage, dn.tag);
      }
      mirror.pendingDamageNumbers.length = 0;
    }
    // weapon-hit-prediction Phase 2 — hard-cancel mispredicted / TTL-expired
    // predicted numbers by tag. Drained AFTER the spawn pass (a predict +
    // rollback in the same frame nets to nothing) and BEFORE update() (a
    // cancelled number gets zero frames of life).
    if (this.damageNumbers && mirror.pendingDamageNumberCancels) {
      for (const tag of mirror.pendingDamageNumberCancels) {
        this.damageNumbers.cancelByTag(tag);
      }
      mirror.pendingDamageNumberCancels.length = 0;
    }
    this.damageNumbers?.update();

    if (this.healthBars && mirror.pendingHealthBarHits) {
      for (const hb of mirror.pendingHealthBarHits) {
        this.healthBars.onHit(hb.entityId, hb.healthPct);
      }
      mirror.pendingHealthBarHits.length = 0;
    }
    this.healthBars?.update(mirror);

    // Drain remote-warp events (warp_in / warp_out broadcasts from the
    // server). Each entry fires the same direction-agnostic one-shot
    // flash + burst ripple at the world point so observers see where
    // the remote ship arrived / departed. Local-player warps are never
    // here (server filters with `except: client`).
    //
    // Render-jitter-fix Phase 1b (2026-05-21) — only fire ONE warp
    // visual per RAF, AND only when a burst is not already in flight.
    // Each `triggerWarpIn` attaches the warp filter chain (shockwave +
    // bloom + zoom-blur) to `app.stage.filters` and resets
    // `warpBurstStartedAt`. The 1.5 s burst duration only tears those
    // filters down via `shouldDetachWarpVisual` IF `warpBurstStartedAt`
    // ages past `burstDurationMs`. Without this guard, Living World
    // bot migrations push 1-2 warp events per second; each restarts
    // the burst timer; filters stay attached indefinitely; GPU runs
    // the multi-pass filter chain every frame → frame rate collapses
    // (the late-onset spiral pattern in captures `af742v` / `ecat41`).
    if (mirror.pendingWarpEvents && mirror.pendingWarpEvents.length > 0) {
      const burstInFlight = this.warp.isBurstInFlight();
      if (!burstInFlight) {
        // Fire ONLY the first queued event this frame. Subsequent
        // events get visually skipped — at 1-2 warps/sec from drones
        // plus a 1.5 s burst window, the visible duty cycle is close
        // to 100 % anyway, so dropping 1-2 visuals is invisible to the
        // player but bounds GPU cost.
        const first = mirror.pendingWarpEvents[0]!;
        this.triggerWarpIn({ kind: 'world', worldX: first.x, worldY: first.y });
      }
      mirror.pendingWarpEvents.length = 0;
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
    this.feedback.damageNumberActiveCount = this.damageNumbers?.getActiveCount() ?? 0;
    this.feedback.wreckSpriteCount = this.wreckSprites.size;
    // Join-render readiness signal: latch true once we've painted at
    // least one frame that includes the LOCAL player's mirror entry
    // (not just any ship). The main thread reads this via
    // `getFeedback()`, fires the `pixi_first_frame` diagnostic, and
    // drives `gameReady`/`<WarpScreen>` off it. Requiring `mirror.
    // ships.has(localPlayerId)` (not just `size > 0`) is what makes
    // this a true "the player can see themselves" signal — strict
    // enough that idle sectors with only remote ships visible don't
    // flip the gate early.
    if (!this.feedback.firstFrameRendered
        && mirror.localPlayerId !== null
        && mirror.ships.has(mirror.localPlayerId)) {
      this.feedback.firstFrameRendered = true;
    }

    // ---------- F1 frame markers (end-of-frame, worker→main diag) ----------
    // Fold in the grid label-churn split that `BackgroundGrid.update()`
    // recorded earlier this frame (called at ~L1310 via
    // `this.backgroundGrid?.update(this.camera)`). `warpTickMs` /
    // `filterCount` are written by the separate `tickWarpShockwaves`
    // ticker callback. `rendererUpdateMs` closes the bracket opened at
    // method entry. The worker posts these only when diagnostics are on.
    const grid = this.backgroundGrid?.lastFrameMarkers;
    if (grid) {
      this.frameMarkers.gridLabelSpecMs = grid.labelSpecMs;
      this.frameMarkers.gridTextCreateMs = grid.textCreateMs;
      this.frameMarkers.gridCleanupMs = grid.cleanupMs;
      this.frameMarkers.gridLabelCount = grid.labelCount;
    } else {
      this.frameMarkers.gridLabelSpecMs = 0;
      this.frameMarkers.gridTextCreateMs = 0;
      this.frameMarkers.gridCleanupMs = 0;
      this.frameMarkers.gridLabelCount = 0;
    }
    this.frameMarkers.spriteCount = this.sprites.size;
    this.frameMarkers.rendererUpdateMs = performance.now() - updateStart;
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
   * Toggle warp-mode render state. See `IRenderer.setWarpMode`.
   *
   * On `active === true`: lazily build a stack of `ShockwaveFilter`
   * instances and attach to `app.stage`. Records `warpStartedAt` so
   * the per-frame tick can ramp amplitude from `amplitudeMin` →
   * `amplitudeMax` over `warpParams.rampMs`. Snaps `warpIntensity` to
   * 1 (the fade-out scalar).
   *
   * On `active === false`: starts the fade-out — `warpIntensity` ramps
   * to 0 over `warpParams.fadeOutMs`, scaling every filter's amplitude
   * down in lockstep. When intensity hits 0, filters are detached and
   * the warp stage hidden (kept around for re-entry).
   *
   * Cheap re-entry: subsequent `setWarpMode(true)` calls reuse the
   * same `ShockwaveFilter` instances.
   */
  setWarpMode(active: boolean): void {
    if (!this.initialized) return;
    this.warp.setMode(active);
  }

  triggerWarpIn(center: WarpCenter | null): void {
    if (!this.initialized) return;
    this.warp.triggerWarpIn(center);
  }

  setWarpParams(partial: Partial<WarpParams>): void {
    this.warp.setWarpParams(partial);
  }

  setWarpCenter(center: WarpCenter | null): void {
    this.warp.setWarpCenter(center);
  }

  setLoadCurtain(active: boolean): void {
    if (!this.initialized) return;
    this.warp.setLoadCurtain(active);
  }

  /**
   * Move the camera so the given world point sits at screen centre.
   * Used by the visual-effects sandbox to anchor world (0, 0) without
   * needing a local-player ship to follow.
   */
  setCameraCenter(worldX: number, worldY: number): void {
    if (!this.initialized) return;
    this.camera.moveCenter(worldX, worldY);
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
    // Tear down the warp filter chain (removes its ticker handler).
    this.warp.destroy();
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
    // Warp stage + filters live on app.stage so `app.destroy({ children: true })`
    // tears them down. warp.destroy() already removed the ticker handler.
    this.app.destroy(true, { children: true });
  }
}
