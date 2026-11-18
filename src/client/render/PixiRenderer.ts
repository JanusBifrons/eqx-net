import { Application, Container, RenderLayer } from 'pixi.js';
import { Camera } from './worker/Camera';
import { DEFAULT_GRAPHICS_QUALITY, renderResolution, type GraphicsQuality } from './graphicsQuality';
import type { FleetOverlayModel, FleetPickKindWire, IRenderer, RenderMirror, RendererFeedback } from '@core/contracts/IRenderer';
import { GameClock } from '@core/clock/GameClock';
import { GalaxyMapLayer } from './galaxy/GalaxyMapLayer';
import { type FrameMarkers } from './worker/protocol';
import { LoadCurtain } from './pixi/LoadCurtain.js';
import { shipSpriteKinds } from './pixi/shipSpriteUpdater.js';
import { DyingHullHold } from './pixi/dyingHullHold.js';
import { ConnectorRenderer } from './pixi/ConnectorRenderer.js';
import { createWarpFxCtx, type WarpFxCtx } from './pixi/warpFxUpdater.js';
import { createEngineShieldFxCtx, type EngineShieldFxCtx } from './pixi/engineShieldFxUpdater.js';
import { createHitEventCtx, type HitEventCtx } from './pixi/hitEventUpdater.js';
import { createHudDrainCtx, type HudDrainCtx } from './pixi/hudDrainUpdater.js';
import { createPlacementGhostCtx, type PlacementGhostCtx } from './pixi/placementGhostUpdater.js';
import { createLitSceneCtx, type LitSceneCtx } from './pixi/litSceneUpdater.js';
import { createTurretShotCtx, type TurretShotCtx } from './pixi/turretShotUpdater.js';
import { resolveInitTarget, buildWorldScene, createGameplayCamera, setupMachinedArt, applyStartZoom, logInitFrameDiag, buildSceneLayers, buildOverlays } from './pixi/rendererSetup/initScene.js';
import { createRendererInitState, applyFxKillSwitches, wireUpdatersAndFx, type RendererInitState } from './pixi/rendererSetup/initWiring.js';
import { installRendererDomListeners } from './pixi/rendererSetup/initDomListeners.js';
import { disposeRenderer, resetEffectsForSectorHandoff, type RendererTeardownRefs } from './pixi/rendererSetup/teardown.js';
import { installFrameTicker } from './pixi/rendererSetup/initTicker.js';
import { createRendererFrameCtx, type RendererFrameCtx, type RendererFrameRefs } from './pixi/frameCtx.js';
import { updateEntitySprites, updateProjectilesAndGhost } from './pixi/worldSpriteUpdater.js';
import { updateBeamsAndCamera, updateBackdrop, updateHudOverlays } from './pixi/frameViewUpdater.js';
import { createRendererFeedback, writeFrameFeedback, tickFrameEffects } from './pixi/frameFeedbackUpdater.js';
import type { EffectQuality } from '@core/contracts/IEffects';
import { RendererInputController, type ForwardedPointerEvent, type RendererInputDeps } from './pixi/rendererInputController.js';
import { RendererCameraDirector, type RendererCameraDeps } from './pixi/cameraDirector.js';
import { artStats, backdropStats, shipVisualProbe, debugEngine, createFleetRingProbe, captureFleetRingProbe, fleetRingProbe, type FleetRingProbeState, type FleetRingReading, type ArtStats, type BackdropStats, RendererPerfProbe, type RendererProbeState, type ShipVisualProbe } from './pixi/rendererProbes.js';
import { HaloRadar, type RadarDebugIcon } from './HaloRadar';
import { IncomingFireWarning } from './incoming/IncomingFireWarning.js';
import { HelmCourseMarker } from './helm/HelmCourseMarker.js';
import type { RadarInsets, RadarPrefs } from '../../shared-types/settings/radar.js';
import { LabelManager } from './Labels';
import { SelectionBracket } from './SelectionBracket';
import { AimFeedbackRenderer } from './AimFeedbackRenderer';
import { HoverBracket } from './HoverBracket';
import { FleetOverlay } from './FleetOverlay.js';
import { EffectsService } from '../effects/EffectsService';
import { readFxKillSwitches, type FxKillSwitches } from './fxKillSwitches';
import { litPass } from './art/litPass.js';
import { Backdrop } from './art/fx/Backdrop.js';
import { FarZoomIcons } from './pixi/FarZoomIcons';
import { ART_OFF, type ArtOptions } from './art/artMode.js';
import { type ShipArtCtx } from './art/shipArtSprites.js';
import { type BeamView } from './BeamSpritePool';
import type { CameraCue } from '@core/contracts/cameraScript';
import { MountVisualManager } from './MountVisualManager';
import { BackgroundGrid } from './BackgroundGrid';
import { CutFieldLayer } from './field/CutFieldLayer';
import { StarfieldBackground } from './StarfieldBackground';
import { logEvent, isDiagEnabled } from '../debug/ClientLogger';
import { rekeyShipVisuals, type ShipRekeyRefs } from './shipRekey.js';
import type { RenderPerfReading, PerfProbeOp } from '@core/contracts/IRenderer';

// Most colour + builder constants moved to pixi/spriteBuilders.ts;
// the constants below are PixiRenderer-specific (background tint,
// remote-laser colour used by inline beam draw in update()).
const BACKGROUND_COLOR = 0x05070f;

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
  private shipContainer!: Container;
  /** Structure placement ghost ctx (pixi/placementGhostUpdater.ts), built in the constructor (it needs `_isTouch`). */
  private readonly _placementGhostCtx: PlacementGhostCtx;
  /** Phase 4 WS-A1 — spectator/construction free-roam camera. While true,
   *  `update()` does NOT re-issue the local-ship follow, so the camera holds
   *  wherever the player panned it (and there may be no local ship at all). */
  private _spectator = false;
  /** Pointer / touch / wheel input, RTS command routing and THE selection
   *  (pixi/rendererInputController.ts), built once. */
  private readonly _input = new RendererInputController(this.inputDeps());
  private inputDeps(): RendererInputDeps {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- getters read the renderer's live fields
    const r = this;
    return {
      get camera() { return r.camera; }, get lastMirror() { return r._lastMirror; }, get galaxyLayer() { return r._galaxyLayer; },
      get feedback() { return r.feedback; }, get selectionBracket() { return r.selectionBracket; }, get fleetOverlay() { return r.fleetOverlay; },
    };
  }
  private fleetOverlay: FleetOverlay | null = null;
  /** Structures plan, Phase 3 — grid connector web renderer. */
  private connectorRenderer!: ConnectorRenderer;
  /** Load curtain (full-canvas dark overlay at join). Constructed in `init()`. */
  private curtain!: LoadCurtain;
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
  private readonly _probes: RendererProbeState = this.probeState();
  private probeState(): RendererProbeState {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- getters read the renderer's live fields
    const r = this;
    return {
      get app() { return r.app; }, get sprites() { return r.sprites; }, get artCtx() { return r._artCtx; }, get swarmSpriteKinds() { return r._swarmSpriteKinds; },
      get mountVisuals() { return r.mountVisuals; }, get camera() { return r.camera; }, get starfield() { return r.starfield; },
      get backdrop() { return r._backdrop; }, get effects() { return r.effects; }, get engineDbgScratch() { return r._engineDbgScratch; },
      get farIcons() { return r._farIcons; }, get warpFx() { return r._warpFxCtx.warpFx; }, get spoolFx() { return r._warpFxCtx.spoolFx; },
      get helmMarker() { return r.helmMarker; }, get lastMirror() { return r._lastMirror; }, get fxEngines() { return r._init.fxEngines; },
      get fxExplosions() { return r._init.fxExplosions; }, get fxProjectiles() { return r._init.fxProjectiles; }, get fxLiveBeams() { return r._init.fxLiveBeams; },
      get fxShields() { return r._init.fxShields; }, get fxShieldsOn() { return r._hitEventCtx.fxShieldsOn; }, get fxFences() { return r._init.fxFences; },
      get wreckBreaks() { return r._init.wreckBreaks; }, get wreckBlastsSpawned() { return r._init.wreckBlastsSpawned; },
      get wreckRipplesSpawned() { return r._init.wreckRipplesSpawned; }, get hullBlastsReplaced() { return r._frame.hullBlastsReplaced; },
      get shipRekeysApplied() { return r._shipRekeysApplied; }, get selectionBracket() { return r.selectionBracket; }, get fleetRing() { return r._fleetRing; },
    };
  }
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
  /** Sprite key → the ship kind it was built for (every ship, swarm).
   *  Bound once (no per-frame closure, #14). */
  private readonly _spriteShipKind = (id: string): string | null | undefined => {
    const sp = this.sprites.get(id);
    if (sp !== undefined) return shipSpriteKinds.get(sp) ?? this._swarmSpriteSigs.get(id)?.shipKind;
    return undefined;
  };
  /** The sweep's per-id cleanup; `held` keeps the turret cluster on the
   *  still-drawn sprite. Bound once (#14). */
  private readonly _forgetSprite = (id: string, held: boolean): void => {
    if (held) this.mountVisuals.detachShip(id);
    else this.mountVisuals.removeShip(id);
    this._structureMountSlew.delete(id); // P3.8 — drop slew state with the sprite
    this._swarmSpriteKinds.delete(id); // #20 — drop kind tracker with the sprite
    this._swarmSpriteSigs.delete(id); // campaign 3.2 — drop build signature with the sprite
    this._artCtx.handles.delete(id); // Machined art — drop the handle with the sprite
  };
  /** Bound once (#14): the per-pair step of `applyShipRekeys` (shipRekey.ts `rekeyShipVisuals`). */
  private readonly _rekeyShip = (from: string, to: string): void => {
    if (rekeyShipVisuals(this._rekeyRefs, from, to)) this._shipRekeysApplied++;
  };
  private readonly _rekeyRefs: ShipRekeyRefs = this.rekeyRefs();
  private rekeyRefs(): ShipRekeyRefs {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- getters read the renderer's live fields
    const r = this;
    return {
      get sprites() { return r.sprites; }, get artHandles() { return r._artCtx.handles; }, get mountVisuals() { return r.mountVisuals; },
      get healthBars() { return r._hudCtx.healthBars; }, get labels() { return r.labels; }, get farIcons() { return r._farIcons; },
      get fxEngines() { return r._init.fxEngines; }, get fxShields() { return r._init.fxShields; }, get input() { return r._input; }, forgetSprite: this._forgetSprite,
    };
  }

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
  private readonly _cameraDirector = new RendererCameraDirector(this.cameraDeps());
  private cameraDeps(): RendererCameraDeps {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- getters read the renderer's live fields
    const r = this;
    return {
      get camera() { return r.camera; }, get lastMirror() { return r._lastMirror; }, get sprites() { return r.sprites; },
      get swarmSpriteKinds() { return r._swarmSpriteKinds; }, get spectator() { return r._spectator; },
      get initialized() { return r.initialized; }, get halo() { return r.halo; },
    };
  }
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
  private labels: LabelManager | null = null;
  private selectionBracket: SelectionBracket | null = null;
  /** Experimental HUD aim feedback (lock bracket / aim line / ship arcs). */
  private aimFeedback: AimFeedbackRenderer | null = null;
  private hoverBracket: HoverBracket | null = null;
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
  private readonly feedback: RendererFeedback = createRendererFeedback(); // pixi/frameFeedbackUpdater.ts

  /**
   * F1 instrumentation — per-frame worker-side sub-costs (warp-spool
   * perf investigation, `docs/HANDOFF-warp-spool-perf-followup.md`).
   * Mutated in place at the tail of `update()` (no per-frame alloc); the
   * worker reads it via `getFrameMarkers()` after `update()` returns and
   * posts a `FRAME_MARKERS` message ONLY when diagnostics are enabled.
   * `warpTickMs` is written by the `LoadCurtain` ticker callback (a
   * separate Pixi ticker, not part of `update()`), so each
   * `FRAME_MARKERS` carries the most recent curtain-tick cost.
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
    const { isDom, initialW, initialH, initialDpr, canvas, domContainer, zoom } = target;

    this.app = new Application();
    await this.app.init({
      ...(canvas ? { canvas: canvas as unknown as HTMLCanvasElement } : {}),
      width: initialW,
      height: initialH,
      background: BACKGROUND_COLOR,
      // Graphics quality: `fxaa` swaps multisampling for the post pass on
      // the world; `off` is neither (graphicsQuality.ts).
      antialias: this.quality.aa === 'msaa' || this.quality.aa === 'max',
      resolution: this.resolutionFor(initialDpr, initialW, initialH),
      autoDensity: isDom,
      // Pin WebGL: Pixi v8.1+ already defaults autoDetect to WebGL, but
      // pinning guarantees the worker can never silently select WebGPU
      // (whose Graphics MSAA path differs from the main-thread fallback's
      // WebGL), keeping crispness identical across both renderer paths.
      preference: 'webgl',
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

    ({ starfield: this.starfield, world: this.world, worldHost: this.worldHost } = buildWorldScene(this.app, this.quality));
    this.camera = createGameplayCamera(this.world);
    this._cameraDirector.setViewSize(initialW, initialH);

    // Read the bisected FX kill switches once at init. Threaded into the
    // EffectsService refs (per-effect bypasses).
    // Plan: melodic-engelbart Step 2.
    // Worker path: the switches arrive on BOOT (no `window` here).
    const fxKillSwitches = this._fxKillSwitches ?? readFxKillSwitches();
    const effectsQuality = (): EffectQuality => this.effects?.getQuality() ?? 'medium';

    const backdrop = setupMachinedArt({
      artOpts: this._artOpts, isTouch: this._isTouch, quality: this.quality, artCtx: this._artCtx,
      mountVisuals: this.mountVisuals, app: this.app, worldHost: this.worldHost, sectorKey: this._sectorKey, effectsQuality,
    });
    if (backdrop) this._backdrop = backdrop;
    // DEV/E2E hook (main-thread path, `?worker=0`): what the art service is
    // doing. Assigned from `update()`, so it always follows the LIVE renderer
    // (a dev StrictMode remount can leave a disposed one behind).
    if (isDom) this._artStatsHook = () => this.artStats();
    applyFxKillSwitches(this._init, this._hudCtx, fxKillSwitches); // rendererSetup/initWiring.ts

    applyStartZoom(this.camera, this._cameraDirector, zoom); // rendererSetup/initScene.ts

    logInitFrameDiag(this.app, this.world, target);

    this._init.cleanWorld = fxKillSwitches.cleanWorld; // `?cleanworld=1` (showcase capture)
    const layers = buildSceneLayers({
      app: this.app, frameMarkers: this.frameMarkers, camera: this.camera, cleanWorld: this._init.cleanWorld,
      mountVisuals: this.mountVisuals, cutField: this._cutField, placementGhostCtx: this._placementGhostCtx,
      wreckFarLayer: this._wreckFarLayer, farIcons: this._farIcons, lockMarksVisible: this._lockMarksVisible, warpFxCtx: this._warpFxCtx,
    });
    this.curtain = layers.curtain;
    if (layers.backgroundGrid) this.backgroundGrid = layers.backgroundGrid;
    this.shipContainer = layers.shipContainer;
    this.connectorRenderer = layers.connectorRenderer;

    const effects = wireUpdatersAndFx(this._init, this._frame.r, { // ctxs, ?fx=new weapons, beam pools + effects, beam ctx (rendererSetup/initWiring.ts)
      artOpts: this._artOpts, effectsQuality, fxKillSwitches, structureMountAngles: this._structureMountSlew, spriteKinds: this._swarmSpriteKinds,
      spriteBuildSigs: this._swarmSpriteSigs, fxShieldPose: this._fxShieldPose, lastMirror: () => this._lastMirror,
    });
    if (effects) this.effects = effects;
    ({
      fleetOverlay: this.fleetOverlay, labels: this.labels, selectionBracket: this.selectionBracket,
      hoverBracket: this.hoverBracket, aimFeedback: this.aimFeedback,
    } = buildOverlays({
      app: this.app, camera: this.camera, world: this.world, incomingFire: this.incomingFire,
      helmMarker: this.helmMarker, halo: this.halo, hudCtx: this._hudCtx, cleanWorld: this._init.cleanWorld,
    }));

    installFrameTicker(this._frame); // camera tick, fleet overlay, art pack / light / collect (rendererSetup/initTicker.ts)

    if (isDom && domContainer) { // rendererSetup/initDomListeners.ts
      installRendererDomListeners(this._frame.r, domContainer, () => this.initialized, (dpr, w, h) => this.resolutionFor(dpr, w, h));
    }
  }

  /**
   * Worker-context entry point. The renderer worker calls this when it
   * receives a RESIZE message — replicates the DOM resize() handler for
   * the OffscreenCanvas path.
   */
  resize(width: number, height: number, dpr?: number): void {
    if (!this.initialized || !this.app?.renderer) return;
    // Pass resolution through so a DPR change (monitor move / browser
    // zoom / some rotations) re-derives the backing buffer. Omitting it
    // (the old behaviour) kept the stale init resolution → blur after
    // such a change. `width`/`height` are LOGICAL (CSS) px.
    this.app.renderer.resize(width, height, dpr !== undefined ? this.resolutionFor(dpr, width, height) : this.app.renderer.resolution);
    this._cameraDirector.setViewSize(width, height);
    this.starfield?.resize(width, height);
    if (isDiagEnabled()) {
      logEvent('render_frame_diag', {
        phase: 'resize',
        mode: 'worker',
        appResolution: this.app.renderer.resolution,
        canvasW: this.app.canvas.width,
        canvasH: this.app.canvas.height,
        inW: width,
        inH: height,
        dpr: dpr ?? -1,
        worldScaleX: this.world.scale.x,
      });
    }
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
    const f = this._frame;
    updateEntitySprites(mirror, f); // pixi/worldSpriteUpdater.ts
    updateProjectilesAndGhost(mirror, f);
    updateBeamsAndCamera(mirror, f); // pixi/frameViewUpdater.ts
    updateBackdrop(mirror, f); // after the camera moved: stars and grid don't lag a frame
    updateHudOverlays(mirror, f);
    writeFrameFeedback(mirror, f); // pixi/frameFeedbackUpdater.ts
    tickFrameEffects(mirror, f); // after every sprite pass (one pose per frame)

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

  setLoadCurtain(active: boolean): void {
    if (!this.initialized) return;
    this.curtain.setLoadCurtain(active);
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
    this._backdrop?.setSector(sectorKey);
    // Moving to another sector starts a new art visit: its art goes into
    // fresh pages, and the old sector's are freed once nothing draws them
    // (collectUnusedArt). The first sector joined is the warm-up's visit.
    if (prev && sectorKey && prev !== sectorKey) this._artCtx.art?.newVisit();
  }

  /** Pixi-space pose of an entity's sprite, for the new shields. */
  private readonly _fxShieldPose = (id: string, out: { x: number; y: number }): boolean => {
    const sp = this.sprites.get(id);
    if (!sp) return false;
    out.x = sp.x; out.y = sp.y;
    return true;
  };

  /** Pooled hit-event / shield-gate, GPU-lit and turret-shot ctxs (pixi/hitEventUpdater.ts,
   *  litSceneUpdater.ts, turretShotUpdater.ts), built once here (the explosions' light hook binds before `init`). */
  private readonly _hitEventCtx: HitEventCtx = createHitEventCtx({ fxShieldPose: this._fxShieldPose, fxNow: () => this.fxNow() });
  private readonly _litSceneCtx: LitSceneCtx = createLitSceneCtx({ fxNow: () => this.fxNow(), tractorViews: this._tractorViews });
  private readonly _turretShotCtx: TurretShotCtx = createTurretShotCtx({ mountVisuals: this.mountVisuals, sprites: this.sprites, fxNow: () => this.fxNow() });
  /** Pooled warp / spool ctx (pixi/warpFxUpdater.ts), built once here (probes read its effects before `init`). */
  private readonly _warpFxCtx: WarpFxCtx = createWarpFxCtx({ fxNow: () => this.fxNow(), sprites: this.sprites, artHandles: this._artCtx.handles });
  /** Pooled engine exhaust + shield aura ctx (pixi/engineShieldFxUpdater.ts); built once here (the handoff reset may run before `init`). */
  private readonly _engineShieldFxCtx: EngineShieldFxCtx = createEngineShieldFxCtx({
    fxShieldPose: this._fxShieldPose, fxNow: () => this.fxNow(), sprites: this.sprites, artHandles: this._artCtx.handles,
    swarmSpriteKinds: this._swarmSpriteKinds, seenScratch: this._updateSeenScratch,
  });
  /** Pooled ctx of the `update()` frame passes and the ticker (pixi/frameCtx.ts), built once here
   *  (every constant member it holds is declared above; `init`-assigned ones are getters). */
  private readonly _frame: RendererFrameCtx = createRendererFrameCtx(this.frameRefs());
  private frameRefs(): RendererFrameRefs {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- getters read the renderer's live fields
    const r = this;
    return {
      get app() { return r.app; }, get camera() { return r.camera; }, get world() { return r.world; },
      get shipContainer() { return r.shipContainer; }, get connectorRenderer() { return r.connectorRenderer; },
      get effects() { return r.effects; }, get fxExplosions() { return r._init.fxExplosions; }, get backdrop() { return r._backdrop; },
      get starfield() { return r.starfield; }, get backgroundGrid() { return r.backgroundGrid; }, get labels() { return r.labels; },
      get selectionBracket() { return r.selectionBracket; }, get hoverBracket() { return r.hoverBracket; },
      get aimFeedback() { return r.aimFeedback; }, get tractorBeamPool() { return r._init.tractorBeamPool; },
      get shipUpdaterCtx() { return r._init.shipUpdaterCtx; }, get swarmUpdaterCtx() { return r._init.swarmUpdaterCtx; },
      get projectileUpdaterCtx() { return r._init.projectileUpdaterCtx; }, get missileUpdaterCtx() { return r._init.missileUpdaterCtx; },
      get beamCtx() { return r._init.beamCtx; }, get spectator() { return r._spectator; }, get lockMarksVisible() { return r._lockMarksVisible; },
      get cleanWorld() { return r._init.cleanWorld; }, get beamsDisabled() { return r._init.beamsDisabled; }, get ringProbeOn() { return r._fleetRing.on; },
      get artStatsHook() { return r._artStatsHook; }, get placementGhostCtx() { return r._placementGhostCtx; }, get halo() { return r.halo; },
      sprites: this.sprites, mountVisuals: this.mountVisuals, cameraDirector: this._cameraDirector, input: this._input,
      feedback: this.feedback, frameMarkers: this.frameMarkers, hudCtx: this._hudCtx, hitEventCtx: this._hitEventCtx,
      litSceneCtx: this._litSceneCtx, turretShotCtx: this._turretShotCtx, warpFxCtx: this._warpFxCtx, engineShieldFxCtx: this._engineShieldFxCtx,
      dyingHulls: this._dyingHulls, farIcons: this._farIcons, cutField: this._cutField, wreckFarLayer: this._wreckFarLayer,
      incomingFire: this.incomingFire, helmMarker: this.helmMarker, fxClock: this.fxClock, artCtx: this._artCtx,
      seenScratch: this._updateSeenScratch, remoteHitTargets: this._updateRemoteHitTargetsScratch, localHitTargets: this._updateLocalHitTargetsScratch,
      tractorViews: this._tractorViews, spriteShipKind: this._spriteShipKind, forgetSprite: this._forgetSprite, rekeyShip: this._rekeyShip,
      captureFleetRingProbe: () => captureFleetRingProbe(this._probes), fxNow: () => this.fxNow(),
    };
  }
  /** Scratch for the test-only particle count in `artStats`. */
  private readonly _engineDbgScratch: number[] = [];

  /** New backdrop (`?fx=new`), and the sector it shows. */
  private _backdrop: Backdrop | null = null;
  private _sectorKey: string | null = null;

  /** DEV/E2E: what the backdrop is showing. */
  backdropStats(): BackdropStats { return backdropStats(this._probes); }

  /** See `IRenderer.setFleetOrderMode`. */
  setFleetOrderMode(mode: 'move' | 'attack'): void { this._input.setFleetOrderMode(mode); }
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
    (this.connectorRenderer as ConnectorRenderer | undefined)?.setTurretOverlaysVisible(lockMarks);
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
  glideCameraTo(gameX: number, gameY: number, durationMs: number): void {
    if (!this.initialized) return;
    this.camera.glideTo(gameX, -gameY, durationMs);
  }

  /** RTS fleet warp (S8) — see `RendererInputController.selectFleetShips`. */
  selectFleetShips(ids: readonly string[]): void { this._input.selectFleetShips(ids); }

  /** Cinematic camera — see `RendererCameraDirector.setCameraScript`. */
  setCameraScript(cues: readonly CameraCue[] | null): void { this._cameraDirector.setCameraScript(cues); }

  /** Test/automation — true while a cinematic script owns the camera. */
  isCameraScripted(): boolean { return this._cameraDirector.isCameraScripted(); }

  /** Phase 5 — set the spectator WASD free-pan velocity (SCREEN px/sec). */
  setPanVelocity(vx: number, vy: number): void {
    if (!this.initialized) return;
    this.camera.setPanVelocity(vx, vy);
  }

  /**
   * Test-only (Phase 4 WS-A1) — the world point currently at screen centre, in
   * GAME space (Y-up). The renderer's `Camera.center` is in pixi-world space
   * (Y-down, `pixiY = -gameY`), so negate Y. Read by the spectator E2E's
   * `__eqxCameraCenter` DEV hook (main-thread renderer path, `?worker=0`) to
   * assert the free-roam camera actually pans. Not consumed by gameplay logic.
   */
  getCameraCenterGame(): { x: number; y: number } {
    const c = this.camera.center;
    return { x: c.x, y: -c.y };
  }

  /**
   * Test-only (RTS fleet-command E2E): the canvas-relative screen point of a
   * GAME-space world point (Y-up → pixi `-y`), so a spec can box-select or
   * click a ship where it is drawn. Read by the `__eqxWorldToScreen` DEV hook
   * (main-thread renderer path, `?worker=0`). Not consumed by gameplay logic.
   */
  worldToScreenGame(x: number, y: number): { x: number; y: number } {
    return this.camera.toScreen(x, -y);
  }

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
  private readonly _teardown: RendererTeardownRefs = this.teardownRefs();
  private teardownRefs(): RendererTeardownRefs {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- getters read the renderer's live fields
    const r = this;
    return {
      get initialized() { return r.initialized; }, set initialized(v: boolean) { r.initialized = v; },
      get effects() { return r.effects; }, set effects(v: EffectsService | null) { r.effects = v; },
      get app() { return r.app; }, get curtain() { return r.curtain; }, get labels() { return r.labels; },
      get selectionBracket() { return r.selectionBracket; }, get hoverBracket() { return r.hoverBracket; }, get fleetOverlay() { return r.fleetOverlay; },
      get backgroundGrid() { return r.backgroundGrid; }, get starfield() { return r.starfield; }, get fxExplosions() { return r._init.fxExplosions; },
      get fxShields() { return r._init.fxShields; }, get fxFences() { return r._init.fxFences; },
      artCtx: this._artCtx, engineShieldFxCtx: this._engineShieldFxCtx, input: this._input, hudCtx: this._hudCtx,
      mountVisuals: this.mountVisuals, halo: this.halo, incomingFire: this.incomingFire, helmMarker: this.helmMarker,
    };
  }
}
