/**
 * `PixiRenderer.init` setup steps that build the scene graph: the init
 * target (DOM element or worker canvas bag), the starfield + world host,
 * the gameplay camera, the Machined art service, the camera-tracked
 * layers and the HUD / selection overlays. Each step takes a narrow deps
 * object and returns what it built; `init` assigns the results to its
 * fields in the same order as before (bodies moved verbatim).
 */
import { Container, type Application } from 'pixi.js';
import { Camera } from '../../worker/Camera.js';
import type { GraphicsQuality } from '../../graphicsQuality.js';
import type { FrameMarkers } from '../../worker/protocol.js';
import { FxaaFilter } from '../FxaaFilter.js';
import { LoadCurtain } from '../LoadCurtain.js';
import { ConnectorRenderer } from '../ConnectorRenderer.js';
import type { PlacementGhostCtx } from '../placementGhostUpdater.js';
import type { HudDrainCtx } from '../hudDrainUpdater.js';
import type { FarZoomIcons } from '../FarZoomIcons.js';
import type { WarpFxCtx } from '../warpFxUpdater.js';
import { StarfieldBackground } from '../../StarfieldBackground.js';
import { BackgroundGrid } from '../../BackgroundGrid.js';
import type { CutFieldLayer } from '../../field/CutFieldLayer.js';
import type { RenderLayer } from 'pixi.js';
import { GAMEPLAY_MAX_ZOOM, GAMEPLAY_MIN_ZOOM } from '@shared-types/shipScale/tuning';
import { createArtService } from '../../art/ArtService.js';
import { litPass } from '../../art/litPass.js';
import { warmUpJobs } from '../../art/warmUp.js';
import { Backdrop } from '../../art/fx/Backdrop.js';
import type { ArtOptions } from '../../art/artMode.js';
import type { ShipArtCtx } from '../../art/shipArtSprites.js';
import type { MountVisualManager } from '../../MountVisualManager.js';
import type { IncomingFireWarning } from '../../incoming/IncomingFireWarning.js';
import type { HelmCourseMarker } from '../../helm/HelmCourseMarker.js';
import type { HaloRadar } from '../../HaloRadar.js';
import { DamageNumberManager } from '../../DamageNumbers.js';
import { LevelUpIconManager } from '../../LevelUpIcons.js';
import { HealthBarManager } from '../../HealthBars.js';
import { LabelManager } from '../../Labels.js';
import { SelectionBracket } from '../../SelectionBracket.js';
import { AimFeedbackRenderer } from '../../AimFeedbackRenderer.js';
import { HoverBracket } from '../../HoverBracket.js';
import { FleetOverlay } from '../../FleetOverlay.js';
import type { EffectQuality } from '@core/contracts/IEffects';
import { logEvent, isDiagEnabled } from '../../../debug/ClientLogger.js';

/** Where `init` draws: a DOM element (main thread) or a worker canvas bag. */
export interface InitTarget {
  isDom: boolean;
  initialW: number;
  initialH: number;
  initialDpr: number;
  canvas: HTMLCanvasElement | OffscreenCanvas | undefined;
  domContainer: HTMLElement | null;
  zoom: number | undefined;
}

export function resolveInitTarget(rawContainer: unknown): InitTarget {
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
  // Optional `?zoom=` override (on-device crispness/framing A/B). DOM mode
  // reads the URL directly; worker mode receives it on the BOOT bag (the
  // worker has no `window`), forwarded by WorkerRendererClient.
  let zoom: number | undefined;
  if (isDom) {
    domContainer = rawContainer as HTMLElement;
    initialW = domContainer.clientWidth || window.innerWidth;
    initialH = domContainer.clientHeight || window.innerHeight;
    initialDpr = window.devicePixelRatio ?? 1;
    const z = new URLSearchParams(window.location.search).get('zoom');
    if (z !== null) zoom = parseFloat(z);
    // No `canvas:` option — Pixi creates one and we append it.
  } else {
    const bag = rawContainer as {
      canvas: OffscreenCanvas; width: number; height: number; dpr: number; zoom?: number;
    };
    canvas = bag.canvas;
    initialW = bag.width;
    initialH = bag.height;
    initialDpr = bag.dpr;
    zoom = bag.zoom;
  }
  return { isDom, initialW, initialH, initialDpr, canvas, domContainer, zoom };
}

/** The starfield, the camera-tracked world and the host the FXAA pass sits on. */
export function buildWorldScene(app: Application, quality: GraphicsQuality): { starfield: StarfieldBackground; world: Container; worldHost: Container } {
  // Starfield attached to app.stage BEFORE the world so it z-orders
  // below all gameplay (Pixi insertion-order z).
  const starfield = new StarfieldBackground();
  starfield.attach(app);

  // World container hosts all camera-tracked gameplay. Pixi's
  // event-system traversal is opt-out (`eventMode='none'`) for the
  // gameplay subtree — see pixijs/pixijs#6515. Game-side taps are
  // routed via the Camera (which the App.tsx forwards canvas events
  // into), not Pixi's event system.
  const world = new Container();
  world.eventMode = 'none';
  // Graphics quality `?aa=fxaa|max`: one FXAA pass over the world (not the
  // stage, whose filters the destruction effects own). It sits on an unmoved
  // host: Pixi maps `filterArea` through the container's own transform, and
  // the camera moves and scales `world`, so on `world` itself the screen
  // rect lands off screen and the pass is skipped. The area is the screen,
  // so Pixi never measures the world's bounds.
  let worldHost = world;
  if (quality.aa === 'fxaa' || quality.aa === 'max') {
    worldHost = new Container();
    worldHost.eventMode = 'none';
    worldHost.addChild(world);
    worldHost.filters = [new FxaaFilter(quality.aa === 'max')];
    worldHost.filterArea = app.screen;
  }
  app.stage.addChild(worldHost);
  return { starfield, world, worldHost };
}

export function createGameplayCamera(world: Container): Camera {
  // followLerpFactor=1 → instant follow each Pixi tick (60 Hz). This
  // matches pre-migration pixi-viewport's `viewport.moveCenter(x, y)`
  // every frame, but driven by the Pixi ticker rather than the per-
  // `update(mirror)` cadence. Decoupling from MIRROR_UPDATE eliminates
  // the wheel-zoom vibration that throttled mirror updates introduced
  // (camera was snapping between zoom-target and centered position
  // every other frame).
  return new Camera(world, {
    // minScale lowered 0.4 → 0.15 (2026-06-03) so the player can zoom
    // much further out to read the wider battlefield. maxScale (zoom-in)
    // unchanged.
    minScale: GAMEPLAY_MIN_ZOOM,
    // The gameplay zoom-in cap then follows the ship you fly so its whole
    // hull fits (`applyZoomCap`); 3 stays the cap for ordinary hulls and
    // the cinematic director's limit.
    maxScale: GAMEPLAY_MAX_ZOOM,
    followLerpFactor: 1,
  });
}

export interface MachinedArtDeps {
  artOpts: ArtOptions;
  isTouch: boolean;
  quality: GraphicsQuality;
  artCtx: ShipArtCtx;
  mountVisuals: MountVisualManager;
  app: Application;
  worldHost: Container;
  sectorKey: string | null;
  effectsQuality: () => EffectQuality;
}

/** Machined art: the art service, warm-up and (with `?fx=new`) the new
 *  backdrop. Returns the backdrop it built, if any. */
export function setupMachinedArt(deps: MachinedArtDeps): Backdrop | null {
  // Machined art: bakes run on workers; until an entity's art is ready it
  // draws today's look. The mode is resolved on the main thread (artMode.ts).
  if (deps.artOpts.mode === 'machined') {
    const art = createArtService({ touch: deps.isTouch, delayMs: deps.artOpts.delayMs ?? 0, ...(deps.artOpts.lighting ? { lighting: deps.artOpts.lighting } : {}) });
    deps.artCtx.art = art;
    deps.artCtx.sunAz = art.lightRig.sunAz;
    // GPU-lit art (`?shiplight=gpu`): lit meshes are built with these.
    litPass.settings = deps.artOpts.lighting ?? null;
    litPass.texSoft = deps.quality.texSoft;
    // Machined turrets ride the new effects (rings in the bakes, baked guns).
    deps.artCtx.turrets = deps.artOpts.fx === true;
    if (deps.artOpts.livery) deps.artCtx.livery = deps.artOpts.livery;
    deps.mountVisuals.setArt(deps.artCtx);
    // Warm-up: bake the likely art now (this runs on the galaxy map /
    // warp screen), behind anything that appears on screen meanwhile.
    art.warmUp(warmUpJobs(deps.artOpts.fx === true, deps.artOpts.livery));
    // New backdrop (B2): behind the world, with dust in front of it. Until
    // its star tiles are baked, today's starfield keeps drawing.
    if (deps.artOpts.fx === true) {
      const bd = new Backdrop(art, deps.effectsQuality, deps.artOpts.speedFx === false ? 'off' : 'large', deps.artOpts.nebLook);
      const wi = deps.app.stage.getChildIndex(deps.worldHost);
      deps.app.stage.addChildAt(bd.sky, wi);
      deps.app.stage.addChildAt(bd.fore, wi + 2);
      bd.setSector(deps.sectorKey);
      return bd;
    }
  }
  return null;
}

/** Gated frame diagnostic at init (`?diag=1`). */
export function logInitFrameDiag(app: Application, world: Container, target: InitTarget): void {
  // Frame diagnostic (gated). The decisive crispness metric: the
  // backing buffer (`app.canvas.width`) MUST equal round(CSS px × dpr)
  // for true 1:1 HiDPI. Pre-fix the worker path double-applied dpr.
  // Captured on-device via `?diag=1` (plan: zazzy-engelbart, Phase 0).
  if (isDiagEnabled()) {
    logEvent('render_frame_diag', {
      phase: 'init',
      mode: target.isDom ? 'dom' : 'worker',
      appResolution: app.renderer.resolution,
      rendererType: (app.renderer as unknown as { type?: number }).type ?? -1,
      canvasW: app.canvas.width,
      canvasH: app.canvas.height,
      inW: target.initialW,
      inH: target.initialH,
      dpr: target.initialDpr,
      worldScaleX: world.scale.x,
    });
  }
}

export interface SceneLayerDeps {
  app: Application;
  frameMarkers: FrameMarkers;
  camera: Camera;
  cleanWorld: boolean;
  mountVisuals: MountVisualManager;
  cutField: CutFieldLayer;
  placementGhostCtx: PlacementGhostCtx;
  wreckFarLayer: RenderLayer;
  farIcons: FarZoomIcons;
  lockMarksVisible: boolean;
  warpFxCtx: WarpFxCtx;
}

export interface SceneLayers {
  curtain: LoadCurtain;
  backgroundGrid: BackgroundGrid | null;
  shipContainer: Container;
  connectorRenderer: ConnectorRenderer;
}

/** The load curtain, grid and the camera-tracked layers under the hulls. */
export function buildSceneLayers(deps: SceneLayerDeps): SceneLayers {
  // Load curtain — lazy-builds its stage on the first setLoadCurtain.
  const curtain = new LoadCurtain(deps.app, deps.frameMarkers);

  // `?cleanworld=1` (showcase capture) drops debug-flavoured world overlays:
  // the spatial grid, turret aim-guides and NPC callsign labels.
  deps.mountVisuals.setAimLinesVisible(!deps.cleanWorld);
  let backgroundGrid: BackgroundGrid | null = null;
  if (!deps.cleanWorld) {
    backgroundGrid = new BackgroundGrid();
    backgroundGrid.attach(deps.camera);
  }

  deps.camera.addChild(deps.cutField.container); // cut-field rocks: under everything that moves
  const shipContainer = new Container();
  deps.camera.addChild(shipContainer);
  deps.placementGhostCtx.camera = deps.camera; deps.placementGhostCtx.shipContainer = shipContainer;
  // Far-zoom wreck specks (wreckArt.ts `setFarZoom`): one batch, under the ship icons.
  deps.camera.addChild(deps.wreckFarLayer);
  // Far-zoom ship icons above the ships they stand in for (FarZoomIcons.ts).
  deps.camera.addChild(deps.farIcons.container);

  // Structures plan, Phase 3 — the grid connector web. Added FIRST so the
  // lines render BEHIND the structure/ship sprites added later.
  const connectorRenderer = new ConnectorRenderer(deps.cutField);
  connectorRenderer.setTurretOverlaysVisible(deps.lockMarksVisible);
  // A3 — the static layer (idle web, range rings, wall rails) sits behind the
  // per-frame layer.
  shipContainer.addChild(connectorRenderer.staticGfx);
  shipContainer.addChild(connectorRenderer.gfx);
  // Warp-to visuals (Phase 4): engine build-up, blur streak, burning trails.
  // Cheap sprites, under the hulls; drawn for every render mode.
  shipContainer.addChild(deps.warpFxCtx.warpFx.layer);
  // Warp spool-up: the engines overcharge (glow + sparks, under the hulls).
  shipContainer.addChild(deps.warpFxCtx.spoolFx.layer);
  // Placed rocks and cut rock pieces: one mesh for all of them (rockBatch.ts),
  // under the hulls and the wreck pieces' cut-edge glow.
  shipContainer.addChild(deps.cutField.rockBatch.layer);
  return { curtain, backgroundGrid, shipContainer, connectorRenderer };
}

export interface OverlayDeps {
  app: Application;
  camera: Camera;
  world: Container;
  incomingFire: IncomingFireWarning;
  helmMarker: HelmCourseMarker;
  halo: HaloRadar;
  hudCtx: HudDrainCtx;
  cleanWorld: boolean;
}

export interface Overlays {
  fleetOverlay: FleetOverlay;
  labels: LabelManager;
  selectionBracket: SelectionBracket;
  hoverBracket: HoverBracket;
  aimFeedback: AimFeedbackRenderer;
}

/** Incoming-fire / helm markers, fleet overlay, radar, HUD managers and brackets. */
export function buildOverlays(deps: OverlayDeps): Overlays {
  // Incoming-fire markers sit under the radar's edge icons.
  deps.incomingFire.init(deps.camera);
  deps.helmMarker.init(deps.camera);
  // RTS command view: selection rings / drag box / order flash, screen space.
  const fleetOverlay = new FleetOverlay(deps.app.stage);
  deps.halo.init(deps.camera);
  deps.halo.setIncoming(deps.incomingFire);
  // Damage numbers attach to the world (pan with camera, anchored at
  // impact world coord) but counter-scale per frame so they stay
  // legible at any zoom — Camera ref needed for the per-frame
  // counter-scale.
  deps.hudCtx.damageNumbers = new DamageNumberManager(deps.world, deps.camera);
  deps.hudCtx.levelUpIcons = new LevelUpIconManager(deps.world, deps.camera);
  deps.hudCtx.healthBars = new HealthBarManager(deps.world);
  const labels = new LabelManager(deps.world, !deps.cleanWorld);
  // THE selection marker (Item B4; RTS Part A): one 4-corner bracket per
  // selected entity, screen space on the stage like the fleet overlay, drawn
  // in the ticker after the camera tick (`drawFleetOverlay`).
  const selectionBracket = new SelectionBracket(deps.app.stage);
  const hoverBracket = new HoverBracket(deps.world);
  const aimFeedback = new AimFeedbackRenderer(deps.world);
  return { fleetOverlay, labels, selectionBracket, hoverBracket, aimFeedback };
}
