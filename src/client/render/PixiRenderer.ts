import { Application, Container, RenderLayer } from 'pixi.js';
import { Camera } from './worker/Camera';
import { DEFAULT_GRAPHICS_QUALITY, renderResolution, type GraphicsQuality } from './graphicsQuality';
import type { FleetOverlayModel, FleetPickKindWire, IRenderer, RenderMirror, RendererFeedback } from '@core/contracts/IRenderer';
import { GameClock } from '@core/clock/GameClock';
import { GalaxyMapLayer } from './galaxy/GalaxyMapLayer';
import { type FrameMarkers } from './worker/protocol';
import { DyingHullHold } from './pixi/dyingHullHold.js';
import { ConnectorRenderer } from './pixi/ConnectorRenderer.js';
import { createWarpFxCtx, type WarpFxCtx } from './pixi/warpFxUpdater.js';
import { createEngineShieldFxCtx, type EngineShieldFxCtx } from './pixi/engineShieldFxUpdater.js';
import { createHitEventCtx, type HitEventCtx } from './pixi/hitEventUpdater.js';
import { createHudDrainCtx, type HudDrainCtx } from './pixi/hudDrainUpdater.js';
import { createPlacementGhostCtx, type PlacementGhostCtx } from './pixi/placementGhostUpdater.js';
import { createLitSceneCtx, type LitSceneCtx } from './pixi/litSceneUpdater.js';
import { createTurretShotCtx, type TurretShotCtx } from './pixi/turretShotUpdater.js';
import { resolveInitTarget, initRendererApp, buildWorldScene, createGameplayCamera } from './pixi/rendererSetup/initScene.js';
import { createRendererInitState, initSceneAndOverlays, type RendererInitState } from './pixi/rendererSetup/initWiring.js';
import { inputDepsView, probeStateView, rekeyRefsView, cameraDepsView, frameRefsView, teardownRefsView, spriteFnsView, type RendererSpriteFns, type RendererViewHost } from './pixi/rendererSetup/rendererViews.js';
import { installRendererDomListeners, resizeRenderer } from './pixi/rendererSetup/initDomListeners.js';
import { disposeRenderer, resetEffectsForSectorHandoff, type RendererTeardownRefs } from './pixi/rendererSetup/teardown.js';
import { installFrameTicker, setTickerMaxFPS } from './pixi/rendererSetup/initTicker.js';
import { createRendererFrameCtx, type RendererFrameCtx } from './pixi/frameCtx.js';
import { runFramePasses } from './pixi/framePasses.js';
import { createRendererFeedback, createFrameMarkers } from './pixi/frameFeedbackUpdater.js';
import { RendererInputController, type ForwardedPointerEvent } from './pixi/rendererInputController.js';
import { RendererCameraDirector } from './pixi/cameraDirector.js';
import { artStats, backdropStats, shipVisualProbe, debugEngine, cameraCenterGame, worldToScreenGame, createFleetRingProbe, fleetRingProbe, type FleetRingProbeState, type FleetRingReading, type ArtStats, type BackdropStats, RendererPerfProbe, type RendererProbeState, type ShipVisualProbe } from './pixi/rendererProbes.js';
import { HaloRadar, type RadarDebugIcon } from './HaloRadar';
import { IncomingFireWarning } from './incoming/IncomingFireWarning.js';
import { HelmCourseMarker } from './helm/HelmCourseMarker.js';
import type { RadarInsets, RadarPrefs } from '../../shared-types/settings/radar.js';
import { EffectsService } from '../effects/EffectsService';
import { readFxKillSwitches, type FxKillSwitches } from './fxKillSwitches';
import { litPass } from './art/litPass.js';
import { FarZoomIcons } from './pixi/FarZoomIcons';
import { ART_OFF, type ArtOptions } from './art/artMode.js';
import { type ShipArtCtx } from './art/shipArtSprites.js';
import { type BeamView } from './BeamSpritePool';
import type { CameraCue } from '@core/contracts/cameraScript';
import { MountVisualManager } from './MountVisualManager';
import { CutFieldLayer } from './field/CutFieldLayer';
import { StarfieldBackground } from './StarfieldBackground';
import { type ShipRekeyRefs } from './shipRekey.js';
import type { RenderPerfReading, PerfProbeOp } from '@core/contracts/IRenderer';

// Per-frame Pixi stroke-style scratches. The renderer redraws beams
// every RAF (60–90 Hz) via clear() + moveTo + lineTo + stroke(...). Pre-
// fix the style literals were allocated per stroke call (2 strokes/mount
// × N mounts × per RAF); Pixi consumes the style synchronously and never
// retains the reference, so a single reusable object per style is safe.
// Mutate `alpha` for remote beams (TTL-based fade); local glow/core
// styles are constant.
// Beam rendering moved to `BeamSpritePool` (post-2026-06-01) — no
// per-frame `clear() + moveTo + lineTo + stroke()` cycle. Sprite tint
// + width are passed at pool construct time; see `init()`.

// Sprite/Graphics builders moved to ./pixi/spriteBuilders.ts — pure
// constructors of Pixi Graphics instances, no class state. The
// orchestrator below imports them from that module.

export class PixiRenderer implements IRenderer {
  /** True on touch devices (Equinox P6.1). The placement ghost seeds at
   *  screen-centre on touch (vs ahead-of-ship + hover-follow on desktop) so the
   *  blueprint is visible on select instead of hidden under the speed-dial.
   *  Threaded from `selectRenderer` (main-thread) / the `BOOT` message (worker);
   *  `isTouchDevice()` is unreliable in a worker (no `window.matchMedia`). */
  private readonly _isTouch: boolean;

  /** Which look to draw (resolved on the main thread; default today's look). */
  private readonly _artOpts: ArtOptions;

  /** FX kill switches handed in by the worker BOOT (resolved on the main
   *  thread — the worker has no `window`). Absent ⇒ read the URL at init. */
  private readonly _fxKillSwitches: FxKillSwitches | undefined;

  constructor(isTouch = false, art: ArtOptions = ART_OFF, fxKillSwitches?: FxKillSwitches) {
    this._isTouch = isTouch;
    this._placementGhostCtx = createPlacementGhostCtx({ isTouch, input: this._input, feedback: this.feedback });
    this._artOpts = art; this._cutField.setOreStyle(art.ore ?? 'veins');
    this.quality = art.quality ?? DEFAULT_GRAPHICS_QUALITY;
    this._fxKillSwitches = fxKillSwitches;
    this.halo = new HaloRadar(isTouch);
  }

  /** Graphics quality (edge smoothing, render scale, texture softening). */
  private readonly quality: GraphicsQuality;

  /** The renderer resolution for a screen at `dpr`: its density × the render scale. */
  private resolutionFor(dpr: number, w: number, h: number): number {
    return renderResolution(dpr, this.quality.renderScale, w, h);
  }

  private app!: Application;
  /**
   * World Container — replaces `pixi-viewport`'s `Viewport`. Holds all
   * gameplay sprites (ships, swarm, projectiles, beams,
   * lingering hulls, background grid, etc.). Pan / zoom / momentum are
   * driven by the `Camera` controller below.
   */
  private world!: Container;
  /** The world's node on the stage: `world` itself, or the unmoved host
   *  that carries the FXAA pass (graphics quality `?aa=fxaa|max`). */
  private worldHost!: Container;
  /** Camera controller — owns world's transform via pointer/wheel events. */
  private camera!: Camera;
  /** Structure placement ghost ctx (pixi/placementGhostUpdater.ts), built in the constructor (it needs `_isTouch`). */
  private readonly _placementGhostCtx: PlacementGhostCtx;
  /** Phase 4 WS-A1 — spectator/construction free-roam camera. While true,
   *  `update()` does NOT re-issue the local-ship follow, so the camera holds
   *  wherever the player panned it (and there may be no local ship at all). */
  private _spectator = false;
  /** Live getter view of the renderer's members, built first: every other getter
   *  view (input / camera deps, probes, rekey, frame, teardown) is built once from
   *  it, at its own field below (pixi/rendererSetup/rendererViews.ts). */
  private readonly _host: RendererViewHost = this.viewHost();
  private viewHost(): RendererViewHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- getters read the renderer's live fields
    const r = this;
    return {
      get initialized() { return r.initialized; }, set initialized(v: boolean) { r.initialized = v; },
      get effects() { return r.effects; }, set effects(v: EffectsService | null) { r.effects = v; },
      get app() { return r.app; }, get world() { return r.world; }, get worldHost() { return r.worldHost; }, get camera() { return r.camera; },
      get starfield() { return r.starfield; }, get lastMirror() { return r._lastMirror; }, get galaxyLayer() { return r._galaxyLayer; },
      get spectator() { return r._spectator; }, get lockMarksVisible() { return r._lockMarksVisible; }, get artStatsHook() { return r._artStatsHook; },
      get shipRekeysApplied() { return r._shipRekeysApplied; }, set shipRekeysApplied(v: number) { r._shipRekeysApplied = v; }, get rekeyRefs() { return r._rekeyRefs; }, get sectorKey() { return r._sectorKey; }, get init() { return r._init; },
      get frame() { return r._frame; }, get probes() { return r._probes; }, get artOpts() { return r._artOpts; }, get isTouch() { return r._isTouch; },
      get quality() { return r.quality; }, get sprites() { return r.sprites; }, get mountVisuals() { return r.mountVisuals; }, get artCtx() { return r._artCtx; },
      get swarmSpriteKinds() { return r._swarmSpriteKinds; }, get swarmSpriteSigs() { return r._swarmSpriteSigs; }, get structureMountSlew() { return r._structureMountSlew; },
      get engineDbgScratch() { return r._engineDbgScratch; }, get farIcons() { return r._farIcons; }, get warpFxCtx() { return r._warpFxCtx; },
      get helmMarker() { return r.helmMarker; }, get incomingFire() { return r.incomingFire; }, get halo() { return r.halo; }, get hitEventCtx() { return r._hitEventCtx; },
      get litSceneCtx() { return r._litSceneCtx; }, get turretShotCtx() { return r._turretShotCtx; }, get engineShieldFxCtx() { return r._engineShieldFxCtx; },
      get placementGhostCtx() { return r._placementGhostCtx; }, get hudCtx() { return r._hudCtx; }, get input() { return r._input; },
      get cameraDirector() { return r._cameraDirector; }, get fleetRing() { return r._fleetRing; }, get feedback() { return r.feedback; },
      get frameMarkers() { return r.frameMarkers; }, get dyingHulls() { return r._dyingHulls; }, get cutField() { return r._cutField; },
      get wreckFarLayer() { return r._wreckFarLayer; }, get fxClock() { return r.fxClock; }, get seenScratch() { return r._updateSeenScratch; },
      get remoteHitTargets() { return r._updateRemoteHitTargetsScratch; }, get localHitTargets() { return r._updateLocalHitTargetsScratch; },
      get tractorViews() { return r._tractorViews; }, get spriteShipKind() { return r._spriteFns.spriteShipKind; }, get forgetSprite() { return r._spriteFns.forgetSprite; },
      get rekeyShip() { return r._spriteFns.rekeyShip; }, get fxShieldPose() { return r._spriteFns.fxShieldPose; }, fxNow: () => r.fxNow(),
    };
  }
  /** Pointer / touch / wheel input, RTS command routing and THE selection
   *  (pixi/rendererInputController.ts), built once. */
  private readonly _input = new RendererInputController(inputDepsView(this._host));
  /** Effects subsystem (plan `wiggly-puppy`). Owns destruction particles,
   *  engine emitters, shield aura, impact sparks, etc. Constructed in
   *  `init()` AFTER `app`, `world`, `shipContainer`, and `curtain` exist.
   *  `null` when `?effects=0` escape hatch is active — destruction +
   *  flames then fall back to today's inline Graphics paths. */
  private effects: EffectsService | null = null;
  /** What `init` builds for the sprite / beam / fx passes, and the scratch that
   *  only feeds them (pixi/rendererSetup/initWiring.ts), built once. */
  private readonly _init: RendererInitState = createRendererInitState();
  /** HUD-mode lock marks (`setHudOverlays`): false below the full HUD. Stored,
   *  not pushed, because the setter can arrive before `init` built the layers. */
  private _lockMarksVisible = true;
  private sprites = new Map<string, Container>();
  /** Screen-size LOD (capital-ship R&D round 3 E1): tiny ships draw as dots. */
  private readonly _farIcons = new FarZoomIcons();
  /** Far-zoom wreck-piece specks, one batch (wreckArt.ts `setFarZoom`). */
  private readonly _wreckFarLayer = new RenderLayer();
  /** Macro terrain v2 (room flag `cutField`): loaded cut-field chunks. */
  private readonly _cutField = new CutFieldLayer();
  /** Machined art (plan iridescent-seeking-rainbow): shared by the ship,
   *  swarm and lingering updaters. `art` is set in `init` when `?art=machined`
   *  (or the default) asks for it; null ⇒ today's vector look everywhere. */
  private readonly _artCtx: ShipArtCtx = { art: null, handles: new Map(), sunAz: 0 };
  /** Bound once in `init` (DOM path only); assigned to the global each frame. */
  private _artStatsHook: (() => unknown) | null = null;
  /** Per-ship turret sprites + aim lines (multi-mount/turret refactor,
   *  Phase 3). Parented to each ship's main `sprite` so the cluster inherits
   *  the ship's world transform; the cluster's own children sit at their
   *  mount-local offset and baseAngle rotation. */
  private mountVisuals = new MountVisualManager();
  /** Live getter view of the state the test / perf probes read (pixi/rendererProbes.ts). */
  private readonly _probes: RendererProbeState = probeStateView(this._host);
  /** The galaxy overlay layer (set when installed). When it reports
   *  `isPanZoomActive()` (selector/spawn mode + visible), the canvas
   *  pointer/wheel handlers route to ITS camera (free pan/zoom of the
   *  galaxy) instead of the world camera. Restored 2026-06-06. */
  private _galaxyLayer: GalaxyMapLayer | null = null;
  private readonly _tractorViews: BeamView[] = []; // salvage PR 11b (tractorBeams.ts)
  private initialized = false;
  /** 2026-05-25 heap-growth gate step 6 — persistent scratches for the
   *  five containers `update()` allocated per frame (60-90 Hz). Each
   *  is `.clear()`'d at the start of `update()` and refilled.
   *  Pre-fix: 5 containers + N{x,y} entries per frame = real allocator
   *  pressure under combat (see capture lnnkkh, 2026-05-25). */
  private readonly _updateSeenScratch = new Set<string>();
  /** Dying capitals drawn at their last pose until their wreck pieces are
   *  (capital-breakup take B, 2026-11-13: the hull vanished ~0.5 s first). */
  private readonly _dyingHulls = new DyingHullHold();
  /** Sprite-kind lookup, sweep cleanup, ship re-key step and shield pose, bound once (rendererSetup/rendererViews.ts). */
  private readonly _spriteFns: RendererSpriteFns = spriteFnsView(this._host);
  private readonly _rekeyRefs: ShipRekeyRefs = rekeyRefsView(this._host);

  /** Re-keys this renderer has applied (diagnostic / E2E). */
  private _shipRekeysApplied = 0;
  /** P3.8 — per-structure slewed mount (barrel/drill) arc-local angles, keyed by
   *  `swarm-<entityId>`. Persists across frames so the structure barrel SLEWS
   *  toward its target (rotateMountToward) instead of SNAPPING in one frame (the
   *  "places at a weird angle then snaps" bug). Swept alongside `sprites` in the
   *  swarm teardown loop so it can't leak across despawns. */
  private readonly _structureMountSlew = new Map<string, number[]>();
  /** Equinox Phase 3 #20 — the `kind` each cached swarm sprite was built for,
   *  keyed by `swarm-<entityId>`. Detects a recycled entityId flipping kind so
   *  the stale sprite is rebuilt (see swarmSpriteUpdater `spriteKinds`). Swept
   *  alongside `sprites` in the teardown loop so it can't leak across despawns. */
  private readonly _swarmSpriteKinds = new Map<string, number>();
  /** Campaign 3.2 — full build signature per cached swarm sprite (subtype-
   *  level recycle detection; see swarmSpriteUpdater `spriteBuildSigs`). */
  private readonly _swarmSpriteSigs = new Map<string, import('./pixi/swarmSpriteUpdater.js').SpriteBuildSig>();
  /** Latest mirror handed to `update()` — lets the `getEntityPose` closure
   *  read a ship's velocity (the sprite carries only x/y/rotation). Set as the
   *  first statement of `update`; the effects tick at the tail of the same
   *  call reads it, so it's always this frame's mirror. */
  private _lastMirror: RenderMirror | null = null;
  /** Camera framing + cinematic director (pixi/cameraDirector.ts), built once. */
  private readonly _cameraDirector = new RendererCameraDirector(cameraDepsView(this._host));
  private readonly _updateRemoteHitTargetsScratch = new Set<string>();
  private readonly _updateLocalHitTargetsScratch = new Set<string>();
  /** Off-screen ring/edge indicator. Constructed in the constructor body
   *  (NOT a field initializer) so it sees the assigned `_isTouch` — field
   *  initializers run before the constructor body, where `_isTouch` is still
   *  undefined (WS-B #3/#4 thread touch into the halo). */
  private readonly halo: HaloRadar;
  /** Naval shells on course for the local ship: fall-point markers + the
   *  radar's incoming chevron (`render/incoming/`). */
  private readonly incomingFire = new IncomingFireWarning();
  /** Helm move marker: the green RTS icon at the pilot's course point. */
  private readonly helmMarker = new HelmCourseMarker();
  /** Damage numbers, level-up icons, health bars + their kill switches (pixi/hudDrainUpdater.ts), built once here (`rekey` / `dispose` read it). */
  private readonly _hudCtx: HudDrainCtx = createHudDrainCtx();
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
  private readonly feedback: RendererFeedback = createRendererFeedback(); // pixi/frameFeedbackUpdater.ts

  /** F1 per-frame worker-side sub-cost markers (pixi/frameFeedbackUpdater.ts `createFrameMarkers`). */
  private readonly frameMarkers: FrameMarkers = createFrameMarkers();

  /** Read the most recent per-frame sub-cost markers. See `FrameMarkers`
   *  + `getFeedback()` for the parallel (but contract-gated) channel. */
  getFrameMarkers(): FrameMarkers {
    return this.frameMarkers;
  }

  /** Perf scenes + count probe (pixi/rendererProbes.ts), built once. */
  private readonly _perf = new RendererPerfProbe(this._probes);
  perfProbeSync(op: PerfProbeOp): RenderPerfReading | null { return this._perf.sync(op); }

  perfProbe(op: PerfProbeOp): Promise<RenderPerfReading | null> {
    return Promise.resolve(this.perfProbeSync(op));
  }

  /** DEBUG (exhaust-side investigation): see pixi/rendererProbes.ts `debugEngine`. */
  __debugEngine(): ReturnType<typeof debugEngine> { return debugEngine(this._probes); }

  async init(rawContainer: unknown): Promise<void> {
    // Setup steps live in pixi/rendererSetup/ (each returns what it built).
    const target = resolveInitTarget(rawContainer);
    const { isDom, initialW, initialH, domContainer } = target;

    this.app = new Application();
    await initRendererApp(this.app, target, this.quality, (dpr, w, h) => this.resolutionFor(dpr, w, h)); // rendererSetup/initScene.ts
    this.initialized = true;

    // Pixi v8 perf: disable per-sprite hit-test traversal on every
    // native pointer move (pixijs/pixijs#6515). Pre-refactor with
    // pixi-viewport, this was a major contention source. Skip in worker
    // context — `events.features` isn't initialised without a DOM event
    // source and the call would throw.
    if (isDom && this.app.renderer.events) {
      Object.assign(this.app.renderer.events.features, { globalMove: false });
    }

    ({ starfield: this.starfield, world: this.world, worldHost: this.worldHost } = buildWorldScene(this.app, this.quality));
    this.camera = createGameplayCamera(this.world);
    this._cameraDirector.setViewSize(initialW, initialH);

    // Read the bisected FX kill switches once at init. Threaded into the
    // EffectsService refs (per-effect bypasses).
    // Plan: melodic-engelbart Step 2.
    // Worker path: the switches arrive on BOOT (no `window` here).
    const fxKillSwitches = this._fxKillSwitches ?? readFxKillSwitches();
    // DEV/E2E hook (main-thread path, `?worker=0`): what the art service is
    // doing. Assigned from `update()`, so it always follows the LIVE renderer
    // (a dev StrictMode remount can leave a disposed one behind).
    if (isDom) this._artStatsHook = () => this.artStats();
    // Machined art, kill switches, start zoom, frame diag, scene layers, ctxs /
    // ?fx=new weapons / beam pools + effects / beam ctx, overlays (rendererSetup/initWiring.ts).
    initSceneAndOverlays(this._init, this._host, this._frame.r, target, fxKillSwitches);

    installFrameTicker(this._frame); // camera tick, fleet overlay, art pack / light / collect (rendererSetup/initTicker.ts)

    if (isDom && domContainer) { // rendererSetup/initDomListeners.ts
      installRendererDomListeners(this._frame.r, domContainer, () => this.initialized, (dpr, w, h) => this.resolutionFor(dpr, w, h));
    }
  }

  /** Worker-context RESIZE entry point: see pixi/rendererSetup/initDomListeners.ts `resizeRenderer`. */
  resize(width: number, height: number, dpr?: number): void {
    resizeRenderer(this._frame.r, this.initialized, (d, w, h) => this.resolutionFor(d, w, h), width, height, dpr);
  }

  /** Worker-context entry point for forwarded pointer events (see `pixi/rendererInputController.ts`). */
  forwardPointerEvent(e: ForwardedPointerEvent): void { this._input.forwardPointerEvent(e); }

  /** Register a confirmed-tap handler (worker path; see the controller). */
  setOnTap(handler: ((screenX: number, screenY: number) => void) | null): void { this._input.setOnTap(handler); }

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
    if (layer instanceof GalaxyMapLayer) this._galaxyLayer = layer;
  }

  /** Worker-context wheel forwarding. */
  forwardWheelEvent(deltaY: number, offsetX: number, offsetY: number): void { this._input.forwardWheelEvent(deltaY, offsetX, offsetY); }

  /** DEV/E2E-only hover at a GAME-space point (see the controller). */
  devHoverAtWorld(gameX: number, gameY: number): string | null { return this._input.devHoverAtWorld(gameX, gameY); }

  /** DEV/E2E-only selection at a GAME-space point (see the controller). */
  devSelectAtWorld(gameX: number, gameY: number): string | null { return this._input.devSelectAtWorld(gameX, gameY); }

  /**
   * Presentation time (time scale stream): game time at the sector's speed,
   * from `mirror.timeScale` each frame. EVERY effect and animation clock in the
   * renderer reads `fxNow()` (explosions, beams, recoil, connector pulses,
   * shields, fences, lights, the backdrop, the effects service), so a new
   * effect that takes its time from here follows the speed with no code of its
   * own. Real time stays for pose interpolation against wall-stamped arrivals,
   * the camera and UI (warp curtain, radar, lock marks, health-bar fades) and
   * cost measurement. At 1× it is `performance.now()` exactly.
   */
  // eslint-disable-next-line no-restricted-properties -- real time: the presentation clock is built over it
  private readonly fxClock = new GameClock(() => performance.now());
  private fxNow(): number { return this.fxClock.now(); }

  update(mirror: RenderMirror): void {
    const speed = mirror.timeScale ?? 1;
    if (speed !== this.fxClock.scale) this.fxClock.setScale(speed);
    // GPU-lit art: this frame's lights are added by the effects below.
    if (litPass.settings) litPass.begin();
    // F1 — bracket the whole update() for `rendererUpdateMs`. Single
    // exit point (the method has no early `return`), so a start-stamp +
    // tail-write is exact. Sub-µs, unconditional (markers-off baseline =
    // production cost). See `frameMarkers` / `FrameMarkers`.
    // eslint-disable-next-line no-restricted-properties -- real time: cost measurement
    const updateStart = performance.now();
    // Stash this frame's mirror so the getEntityPose effects closure can read
    // ship velocity (the sprite carries only x/y/rotation). The effects tick
    // at the tail of THIS update reads it → always the current frame's mirror.
    this._lastMirror = mirror;
    // The frame passes, in order (pooled ctx `pixi/frameCtx.ts`; no per-frame allocation).
    runFramePasses(mirror, this._frame); // pixi/framePasses.ts (phone-lane phase marks inside)

    // eslint-disable-next-line no-restricted-properties -- real time: cost measurement
    this.frameMarkers.rendererUpdateMs = performance.now() - updateStart;
    this._perf.ring?.push(this.frameMarkers.rendererUpdateMs);
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
    if (overlay instanceof GalaxyMapLayer) this._galaxyLayer = overlay;
  }

  /** Cap / pause the Pixi ticker: see pixi/rendererSetup/initTicker.ts `setTickerMaxFPS`. */
  setTickerMaxFPS(fps: number | null | undefined): void {
    if (!this.initialized) return;
    setTickerMaxFPS(this.app.ticker, fps);
  }

  setLoadCurtain(active: boolean): void {
    if (!this.initialized) return;
    this._init.curtain.setLoadCurtain(active);
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
   * Phase 4 WS-A1 — spectator/construction free-roam camera. See
   * `IRenderer.setSpectator`. While spectating, `update()` skips the per-frame
   * `camera.follow({local pose})`; here we detach the follow target immediately
   * (`follow(null)`) so the world camera holds wherever the player panned it.
   * The gameplay pointer path already pans/zooms the same `Camera` (drag +
   * wheel/pinch), so free-roam needs no new event routing.
   */
  /** See `IRenderer.setSector`. */
  setSector(sectorKey: string | null): void {
    const prev = this._sectorKey;
    this._sectorKey = sectorKey;
    // W3: each sector has its own sun. GPU-lit art re-lights at once (the lit
    // pass reads the rig each frame); baked art re-bakes, keyed by the rig.
    const art = this._artCtx.art;
    if (art) { art.setSector(sectorKey); this._artCtx.sunAz = art.lightRig.sunAz; }
    this._init.backdrop?.setSector(sectorKey);
    // Moving to another sector starts a new art visit: its art goes into
    // fresh pages, and the old sector's are freed once nothing draws them
    // (collectUnusedArt). The first sector joined is the warm-up's visit.
    if (prev && sectorKey && prev !== sectorKey) this._artCtx.art?.newVisit();
  }

  /** Pooled hit-event / shield-gate, GPU-lit and turret-shot ctxs (pixi/hitEventUpdater.ts,
   *  litSceneUpdater.ts, turretShotUpdater.ts), built once here (the explosions' light hook binds before `init`). */
  private readonly _hitEventCtx: HitEventCtx = createHitEventCtx({ fxShieldPose: this._spriteFns.fxShieldPose, fxNow: () => this.fxNow() });
  private readonly _litSceneCtx: LitSceneCtx = createLitSceneCtx({ fxNow: () => this.fxNow(), tractorViews: this._tractorViews });
  private readonly _turretShotCtx: TurretShotCtx = createTurretShotCtx({ mountVisuals: this.mountVisuals, sprites: this.sprites, fxNow: () => this.fxNow() });
  /** Pooled warp / spool ctx (pixi/warpFxUpdater.ts), built once here (probes read its effects before `init`). */
  private readonly _warpFxCtx: WarpFxCtx = createWarpFxCtx({ fxNow: () => this.fxNow(), sprites: this.sprites, artHandles: this._artCtx.handles });
  /** Pooled engine exhaust + shield aura ctx (pixi/engineShieldFxUpdater.ts); built once here (the handoff reset may run before `init`). */
  private readonly _engineShieldFxCtx: EngineShieldFxCtx = createEngineShieldFxCtx({
    fxShieldPose: this._spriteFns.fxShieldPose, fxNow: () => this.fxNow(), sprites: this.sprites, artHandles: this._artCtx.handles,
    swarmSpriteKinds: this._swarmSpriteKinds, seenScratch: this._updateSeenScratch,
  });
  /** Pooled ctx of the `update()` frame passes and the ticker (pixi/frameCtx.ts), built once here
   *  (every constant member it holds is declared above; `init`-assigned ones are getters). */
  private readonly _frame: RendererFrameCtx = createRendererFrameCtx(frameRefsView(this._host));
  /** Scratch for the test-only particle count in `artStats`. */
  private readonly _engineDbgScratch: number[] = [];

  /** The sector the new backdrop (`?fx=new`, on `_init`) shows. */
  private _sectorKey: string | null = null;

  /** DEV/E2E: what the backdrop is showing. */
  backdropStats(): BackdropStats { return backdropStats(this._probes); }

  /** See `IRenderer.setFleetPick`. */
  setFleetPick(kind: FleetPickKindWire | null): void { this._input.setFleetPick(kind); }
  /** See `IRenderer.commitFleetPick`. */
  commitFleetPick(): void { this._input.commitFleetPick(); }
  /** See `IRenderer.setFleetOverlayModel`. */
  setFleetOverlayModel(model: FleetOverlayModel): void { this._input.setFleetOverlayModel(model); }

  setSpectator(active: boolean): void {
    this._spectator = active;
    this._input.setCommandView(active);
    // The radar is camera-relative while spectating. Pushed here (not read
    // from the store) so it works on the worker path too.
    this.halo.setSpectator(active);
    if (!this.initialized) return;
    if (active) this.camera.follow(null);
    this._cameraDirector.applyZoomCap();
  }

  /** See `IRenderer.setRadarPrefs`. */
  setRadarPrefs(prefs: RadarPrefs): void {
    this.halo.setPrefs(prefs);
    // Far-zoom ship icons share the radar's relationship colours.
    this._farIcons.setColoursFromRadar(prefs);
  }

  /** See `IRenderer.setRadarInsets`. */
  setRadarInsets(insets: RadarInsets): void {
    this.halo.setInsets(insets);
  }

  /** See `IRenderer.setRadarSuppressed`. */
  setRadarSuppressed(suppressed: boolean): void {
    this.halo.setSuppressed(suppressed);
    this.incomingFire.setSuppressed(suppressed);
  }

  /** See `IRenderer.setHudOverlays`. */
  setHudOverlays(lockMarks: boolean, radar: boolean): void {
    this._lockMarksVisible = lockMarks;
    // `connectorRenderer` is built in `init`; it picks the flag up there.
    (this._init.connectorRenderer as ConnectorRenderer | undefined)?.setTurretOverlaysVisible(lockMarks);
    this.halo.setHidden(!radar);
  }

  /** Test-only (DEV hook `__eqxHaloDebug`, `?worker=0`) — drawn radar icons. */
  getRadarDebugIcons(): RadarDebugIcon[] {
    return this.halo.getDebugIcons();
  }

  /**
   * Phase 4 WS-A2 — one-shot eased camera glide to a GAME-space point. The
   * camera's `Camera` operates in pixi-world space (Y-down, `pixiY = -gameY`),
   * so negate Y. See `IRenderer.glideCameraTo`. Driven by elapsed ms inside
   * `Camera.tick` (independent of pose interpolation → no teleport-guard trip).
   */
  glideCameraTo(gameX: number, gameY: number, durationMs: number, toScale = 0): void {
    if (!this.initialized) return;
    this.camera.glideTo(gameX, -gameY, durationMs, toScale);
  }

  /** RTS fleet warp (S8) — see `RendererInputController.selectFleetShips`. */
  selectFleetShips(ids: readonly string[]): void { this._input.selectFleetShips(ids); }
  /** Tap rule T2 — see `RendererCommandRouting.attackFocus`. */
  attackFocus(): void { this._input.attackFocus(); }

  /** Cinematic camera — see `RendererCameraDirector.setCameraScript`. */
  setCameraScript(cues: readonly CameraCue[] | null): void { this._cameraDirector.setCameraScript(cues); }

  /** Test/automation — true while a cinematic script owns the camera. */
  isCameraScripted(): boolean { return this._cameraDirector.isCameraScripted(); }

  /** Phase 5 — set the spectator WASD free-pan velocity (SCREEN px/sec). */
  setPanVelocity(vx: number, vy: number): void {
    if (!this.initialized) return;
    this.camera.setPanVelocity(vx, vy);
  }

  /** Test-only screen-centre in GAME space (`__eqxCameraCenter`): see pixi/rendererProbes.ts. */
  getCameraCenterGame(): { x: number; y: number } { return cameraCenterGame(this._probes); }

  /** Test-only GAME point → canvas screen point (`__eqxWorldToScreen`): see pixi/rendererProbes.ts. */
  worldToScreenGame(x: number, y: number): { x: number; y: number } { return worldToScreenGame(this._probes, x, y); }

  /** Test-only ring probe state (pixi/rendererProbes.ts). Off until first read. */
  private readonly _fleetRing: FleetRingProbeState = createFleetRingProbe();

  /** Test-only ship identity probe (`__eqxShipVisualProbe`): see pixi/rendererProbes.ts. */
  shipVisualProbe(key: string): ShipVisualProbe { return shipVisualProbe(this._probes, key); }

  /** Test-only fleet ring probe (`__eqxFleetRingProbe`): see pixi/rendererProbes.ts. */
  fleetRingProbe(): FleetRingReading { return fleetRingProbe(this._probes); }

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

  /** Sector-handoff effects reset: see pixi/rendererSetup/teardown.ts. */
  resetEffectsForSectorHandoff(): void { resetEffectsForSectorHandoff(this._teardown); }

  /** Machined art status (DEV/perf probe): see pixi/rendererProbes.ts. */
  artStats(): ArtStats { return artStats(this._probes); }

  dispose(): void { disposeRenderer(this._teardown); } // pixi/rendererSetup/teardown.ts
  /** Live getter view of the state teardown reads (pixi/rendererSetup/teardown.ts), built once. */
  private readonly _teardown: RendererTeardownRefs = teardownRefsView(this._host);
}
