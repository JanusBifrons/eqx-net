import { Application, Graphics, Container, type Texture } from 'pixi.js';
import { Camera } from './worker/Camera';
import type { IRenderer, RenderMirror, RendererFeedback } from '@core/contracts/IRenderer';
import { GalaxyMapLayer } from './galaxy/GalaxyMapLayer';
import { type WarpParams, type WarpCenter, type FrameMarkers } from './worker/protocol';
import { WarpFilterChain } from './pixi/WarpFilterChain.js';
import { shouldFireRemoteWarpVisual, remoteWarpEventFires } from './pixi/warpHelpers.js';
import { fillHitTargetSets } from './pixi/hitTargetSets.js';
import { updateShipSprites, type ShipSpriteCtx } from './pixi/shipSpriteUpdater.js';
import { entityPoseFromSprite, type EntityPose } from './pixi/entityPoseFromSprite.js';
import { decidePlacementPointer, shouldCentreGhostOnActivate } from './placementPointerDecision.js';
import { engineProfileForKind } from './pixi/engineGeometry.js';
import { updateSwarmSprites, type SwarmSpriteCtx } from './pixi/swarmSpriteUpdater.js';
import { ConnectorRenderer } from './pixi/ConnectorRenderer.js';
import { updateProjectileSprites, type ProjectileSpriteCtx } from './pixi/projectileSpriteUpdater.js';
import { updateMissileSprites, type MissileSpriteCtx } from './pixi/missileSpriteUpdater.js';
import { interpolateSwarmPose, type InterpolatedPose } from '../net/swarmInterpolation';
import { HaloRadar, type RadarDebugIcon } from './HaloRadar';
import type { RadarInsets, RadarPrefs } from '../../shared-types/settings/radar.js';
import { DamageNumberManager } from './DamageNumbers';
import { LevelUpIconManager } from './LevelUpIcons';
import { HealthBarManager } from './HealthBars';
import { LabelManager } from './Labels';
import { SelectionBracket } from './SelectionBracket';
import { AimFeedbackRenderer } from './AimFeedbackRenderer';
import { HoverBracket } from './HoverBracket';
import { pickEntityAt, type PickedEntityKind } from './pickEntity';
import { decideLingeringSpriteAction, decideExplosionPosition, type SpriteDecision } from './spriteUpdateDecisions';
import { shouldLatchFirstFrame } from './firstFrameLatch.js';
import { EffectsService, effectsDisabledByUrl } from '../effects/EffectsService';
import { readFxKillSwitches, type FxKillSwitches } from './fxKillSwitches';
import { createArtService, type ArtHandle } from './art/ArtService.js';
import { MachinedShipSprite } from './art/MachinedShipSprite.js';
import { litPass } from './art/litPass.js';
import { engineLightAstern, engineLightHeight, engineLightIntensity, engineLightReach } from './art/lightingSettings.js';
import { WarpSpoolFx, type SpoolFxShip, type Nozzle } from './pixi/WarpSpoolFx.js';
import { WARP_SPOOL_TICKS } from '@core/physics/warpDrive';
import { MachinedFlatSprite } from './art/MachinedFlatSprite.js';
import { warmUpJobs } from './art/warmUp.js';
import { Backdrop } from './art/fx/Backdrop.js';
import { speedFxFullSpeed } from './art/fx/depth.js';
import { FxBeams, FxProjectiles } from './art/fx/FxWeapons.js';
import { blastRadiusFor, FxExplosions, FxMissileTrails } from './art/fx/FxExplosions.js';
import { shellImpactRadius, shellEndedOnHit } from './art/fx/turretFx.js';
import { getWeapon, isWeaponId } from '@core/combat/WeaponCatalogue';
import { FxEngines } from './art/fx/FxEngines.js';
import { WarpFx, type WarpFxShip } from './pixi/WarpFx.js';
import { shipShotMuzzle } from '@core/combat/muzzle';
import { LodDots } from './pixi/LodDots';
import { GAMEPLAY_MIN_ZOOM, hullZoomFactor, shieldVisualRadius, shipTuning, startZoomForScale, zoomRangeForKind } from '@shared-types/shipScale/tuning';
import { FxFences, FxShields } from './art/fx/FxShields.js';
import { SHIELD_RADIUS_PAD } from '../../shared-types/shipKinds.js';
import { ART_OFF, type ArtOptions } from './art/artMode.js';
import { buildArtShipSprite, isMachinedSprite, shipArtSwap, shipHandleFor, updateArtShipLight, type ShipArtCtx } from './art/shipArtSprites.js';
import { BeamSpritePool, type BeamView } from './BeamSpritePool';
import {
  CameraDirector,
  type CameraTargetLookup,
  type DirectorTarget,
  type MutableBounds,
  type MutablePoint,
} from './camera/CameraDirector';
import type { CameraCue, CameraGroup } from '@core/contracts/cameraScript';
import { REMOTE_BEAM_STYLE, MINING_BEAM_STYLE } from './beamStyles';
import { MountVisualManager } from './MountVisualManager';
import { BackgroundGrid } from './BackgroundGrid';
import { StarfieldBackground } from './StarfieldBackground';
import { logEvent, isDiagEnabled } from '../debug/ClientLogger';
import { getShipKind } from '../../shared-types/shipKinds';
import { shipPrimaryColor } from '@core/geometry/shipHullOutline';
import {
  buildShipGfxFromShape,
  shapeForKind,
  buildGhostGfx,
  applyMountOffset,
  buildExplosionGfx,
  buildStructureGfx,
} from './pixi/spriteBuilders.js';
import { getStructureKind } from '@shared-types/structureKinds';
import { setCanvasPointerCapture } from './pointerCapture.js';
import { FrameTimeRing } from '@core/perf/FrameTimeRing';
import type { RenderPerfReading, PerfProbeOp, RenderCountReading } from '@core/contracts/IRenderer';

// Most colour + builder constants moved to pixi/spriteBuilders.ts;
// the constants below are PixiRenderer-specific (background tint,
// remote-laser colour used by inline beam draw in update()).
const BACKGROUND_COLOR = 0x05070f;
// Default gameplay camera zoom (world Container scale). 1.0 preserves the
// historical framing; tune here once the `?zoom=` on-device A/B settles.
// 2026-06-03 zoom-range tweak: the gameplay camera now allows zooming
// much further OUT (clampZoom minScale 0.4 → 0.15 below) so the player can
// take in the wider battlefield. The DEFAULT start zoom moved from 1.0 to
// 0.5 — close to the OLD max zoom-out (0.4), raised slightly — so you spawn
// seeing more of the sector. `?zoom=` still overrides for on-device A/B.
const DEFAULT_GAMEPLAY_ZOOM = 0.5;
const LASER_CORE_COLOR = 0xffffff;

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
// `shouldFireRemoteWarpVisual` is imported above for in-module use (#7); the
// test imports it directly from `./pixi/warpHelpers`.
export { shouldFireRemoteWarpVisual };


// Sprite/Graphics builders moved to ./pixi/spriteBuilders.ts — pure
// constructors of Pixi Graphics instances, no class state. The
// orchestrator below imports them from that module.

/** A live naval shell: last + first-seen Pixi position, burst radius, full travel. */
interface NavalShellRec { x: number; y: number; r: number; sx: number; sy: number; reach: number }

/** How often (frames) unused older-sector art is freed (~2 s at 60 fps). */
const ART_COLLECT_EVERY_FRAMES = 120;

/** Record the Machined art a sprite draws (for art collection). */
function noteShownArt(sprite: Container, out: Set<object>): void {
  if (sprite instanceof MachinedShipSprite || sprite instanceof MachinedFlatSprite) out.add(sprite.art);
}

export class PixiRenderer implements IRenderer {
  /** True on touch devices (Equinox P6.1). The placement ghost seeds at
   *  screen-centre on touch (vs ahead-of-ship + hover-follow on desktop) so the
   *  blueprint is visible on select instead of hidden under the speed-dial.
   *  Threaded from `selectRenderer` (main-thread) / the `BOOT` message (worker);
   *  `isTouchDevice()` is unreliable in a worker (no `window.matchMedia`). */
  private readonly _isTouch: boolean;

  /** Which look to draw (resolved on the main thread; default today's look). */
  private readonly _artOpts: ArtOptions;
  /** Zoom range follows the ship you fly (capital-ship round 3 D): the kind id
   *  last applied, its hull zoom factor, and whether `?zoom=` pinned the start. */
  private _zoomKindId: string | null = null;
  private _zoomFactor = 1;
  private _zoomPinned = false;
  private readonly _zoomRange = { minScale: GAMEPLAY_MIN_ZOOM, startZoom: 0 };

  /** FX kill switches handed in by the worker BOOT (resolved on the main
   *  thread — the worker has no `window`). Absent ⇒ read the URL at init. */
  private readonly _fxKillSwitches: FxKillSwitches | undefined;

  constructor(isTouch = false, art: ArtOptions = ART_OFF, fxKillSwitches?: FxKillSwitches) {
    this._isTouch = isTouch;
    this._artOpts = art;
    this._fxKillSwitches = fxKillSwitches;
    this.halo = new HaloRadar(isTouch);
  }

  private app!: Application;
  /**
   * World Container — replaces `pixi-viewport`'s `Viewport`. Holds all
   * gameplay sprites (ships, swarm, projectiles, beams,
   * lingering hulls, background grid, etc.). Pan / zoom / momentum are
   * driven by the `Camera` controller below.
   */
  private world!: Container;
  /** Camera controller — owns world's transform via pointer/wheel events. */
  private camera!: Camera;
  private shipContainer!: Container;
  /** Structure placement ghost (Issue 5) — lazily built translucent blueprint
   *  silhouette, rebuilt when the previewed kind changes. Lives in
   *  `shipContainer` (world space) so it pans/zooms with the structures. */
  private _placementGhost: Graphics | null = null;
  private _placementGhostKind: string | null = null;
  /** Tap/drag-to-position placement state (2026-06-07). `_placementActive` is
   *  set each frame from `mirror.pendingPlacementPreview`. While active, canvas
   *  pointer events position the blueprint ghost (game-space) instead of
   *  panning the camera. `_placementChosenX/Y` is the chosen GAME point (null =
   *  not yet positioned → fall back to the ahead-of-ship preview).
   *  `_placementFollowing` true ⇒ the ghost tracks the pointer (desktop hover /
   *  mobile drag); set false on pointer-up so the ghost parks and the Confirm
   *  banner appears. */
  private _placementActive = false;
  private _placementFollowing = true;
  private _placementChosenX: number | null = null;
  private _placementChosenY: number | null = null;
  /** Phase 4 WS-A1 — spectator/construction free-roam camera. While true,
   *  `update()` does NOT re-issue the local-ship follow, so the camera holds
   *  wherever the player panned it (and there may be no local ship at all). */
  private _spectator = false;
  /**
   * Click-to-inspect selection (structures follow-up Item B2). The renderer
   * OWNS the selected entity — set on a gameplay tap that resolves to an
   * entity, toggled off on a re-tap of the SAME entity, cleared on an
   * empty-space tap. Published each frame via `feedback.selectedPickId/Kind`
   * (the main thread mirrors it into Zustand for panel visibility). The id form
   * matches the `HealthBarManager`/`SelectionBracket` lookup convention.
   */
  private _selectedId: string | null = null;
  private _selectedKind: PickedEntityKind | null = null;
  /** WS-10 (R2.4) — the entity the desktop pointer is HOVERING over (set from
   *  pointer-move via `pickEntityAt`). Renderer-local, NEVER Zustand (updates at
   *  move cadence — invariant #2). Drives the lighter `HoverBracket` outline. */
  private _hoveredId: string | null = null;
  /** Structures plan, Phase 3 — grid connector web renderer. */
  private connectorRenderer!: ConnectorRenderer;
  /** A3 — visible rect for culling structure sprites (reused per frame). */
  private readonly _swarmViewScratch = new Float64Array(4);
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
  /** Effects subsystem (plan `wiggly-puppy`). Owns destruction particles,
   *  engine emitters, shield aura, impact sparks, etc. Constructed in
   *  `init()` AFTER `app`, `world`, `shipContainer`, and `warp` exist.
   *  `null` when `?effects=0` escape hatch is active — destruction +
   *  flames then fall back to today's inline Graphics paths. */
  private effects: EffectsService | null = null;
  // Phone-stall thermal-isolation switches. Read once at init via
  // `readFxKillSwitches`; gated at render-time call sites to attribute
  // GPU heat to specific subsystems (beams / damage numbers / health
  // bars). Same pattern as `filtersDisabled` / `particlesDisabled`.
  private _beamsDisabled = false;
  private _dmgNumbersDisabled = false;
  private _selfDmgNumbersDisabled = false;
  private _cleanWorld = false;
  private _healthBarsDisabled = false;
  private sprites = new Map<string, Container>();
  /** Screen-size LOD (capital-ship R&D round 3 E1): tiny ships draw as dots. */
  private readonly _lodDots = new LodDots();
  /** Machined art (plan iridescent-seeking-rainbow): shared by the ship,
   *  swarm and lingering updaters. `art` is set in `init` when `?art=machined`
   *  (or the default) asks for it; null ⇒ today's vector look everywhere. */
  private readonly _artCtx: ShipArtCtx = { art: null, handles: new Map(), sunAz: 0 };
  /** Frames since the last art collection, and its reused in-use set. */
  private _artCollectFrame = 0;
  private readonly _artInUse = new Set<ArtHandle>();
  private readonly _artShown = new Set<object>();

  /** Free the atlas pages of an older sector's art once no sprite or gun
   *  draws it (after a sector trip), so a phone's few pages don't fill. */
  private collectUnusedArt(): void {
    const art = this._artCtx.art;
    if (!art) return;
    const inUse = this._artInUse;
    inUse.clear();
    for (const h of this._artCtx.handles.values()) inUse.add(h);
    this.mountVisuals.addArtHandlesTo(inUse);
    const shown = this._artShown;
    shown.clear();
    for (const sp of this.sprites.values()) noteShownArt(sp, shown);
    for (const e of this.lingeringSprites.values()) noteShownArt(e.sprite, shown);
    art.collect(inUse, shown);
    inUse.clear();
    shown.clear();
  }
  /** Bound once in `init` (DOM path only); assigned to the global each frame. */
  private _artStatsHook: (() => unknown) | null = null;
  /** Scratch for `feedback.artReady` (see the end of `update()`). */
  private _artPendingSeen = false;
  /** The own-ship art handle already moved to the front of the bake queue. */
  private _prioritizedArtKey: string | null = null;
  private readonly _noteArtPending = (h: { state: string }): void => {
    if (h.state === 'pending') this._artPendingSeen = true;
  };
  /** Per-ship turret sprites + aim lines (multi-mount/turret refactor,
   *  Phase 3). Parented to each ship's main `sprite` so the cluster inherits
   *  the ship's world transform; the cluster's own children sit at their
   *  mount-local offset and baseAngle rotation. */
  private mountVisuals = new MountVisualManager();
  private serverGhost: Graphics | null = null;
  private projectileSprites = new Map<string, Graphics>();
  /** Per-missile sprites, keyed by stable per-sector missileId. Pooled
   *  via the missileSpriteUpdater's seen-set; one sprite per in-flight
   *  missile, destroyed when the missile leaves the mirror. */
  private missileSprites = new Map<number, Graphics>();
  /** Active missile-detonation explosion sprites (short-lived). */
  private missileExplosionsActive: MissileSpriteCtx['activeExplosions'] = [];
  /** Reused per-frame seen-set for the missile sprite updater. */
  private readonly _updateMissileSeenScratch = new Set<number>();
  private _missileUpdaterCtx!: MissileSpriteCtx;
  private explosionSprites: Array<{ gfx: Graphics; framesLeft: number }> = [];
  // Post-2026-06-01: beams now rendered via sprite pools (no Graphics
  // clear/redraw cycle). The `liveBeamGfx` / `remoteBeamGfx` accessor
  // fields are kept as Container types — same surface LaserGlow uses
  // to attach filters. Pools own the actual sprite lifecycle.
  private liveBeamGfx: Container | null = null;
  private remoteBeamGfx: Container | null = null;
  /** The galaxy overlay layer (set when installed). When it reports
   *  `isPanZoomActive()` (selector/spawn mode + visible), the canvas
   *  pointer/wheel handlers route to ITS camera (free pan/zoom of the
   *  galaxy) instead of the world camera. Restored 2026-06-06. */
  private _galaxyLayer: GalaxyMapLayer | null = null;
  /** #7 — observable outcome of the `pendingWarpEvents` drain, so a test can
   *  lock the ACTUAL wiring (not just the pure helper): incremented in
   *  `drainRemoteWarp` when a queued remote-warp event FIRES its ripple
   *  (`triggerWarpIn`) vs is SUPPRESSED (galaxy map open / burst in flight).
   *  Exposed via the test seam `debugRemoteWarpCounts()`. */
  private _remoteWarpFiredCount = 0;
  private _remoteWarpSuppressedCount = 0;
  private _liveBeamPool: BeamSpritePool | null = null;
  private _remoteBeamPool: BeamSpritePool | null = null;
  /** WS-4 Phase 4 (R2.27) — dedicated pool for the Miner's mining beam
   *  (`laser_fired` mountId `drill`). Separate from `_remoteBeamPool` so it can
   *  be tinted as a distinct fat amber drill beam AND so an E2E can isolate its
   *  `liveCount` (the shared remote pool can't tell a drill beam from a combat
   *  laser). The faint always-on link hint stays in `ConnectorRenderer`. */
  private _miningBeamPool: BeamSpritePool | null = null;
  private miningBeamGfx: Container | null = null;
  /**
   * Plan: combat-fx-hunt (2026-05-31) — beam endpoint cache for the
   * dirty-flag check on the per-frame Graphics rebuild path.
   * `liveBeamGfx.clear() + moveTo + lineTo + stroke` ran every frame
   * while held-fire was active even when the ship hadn't moved or
   * rotated past visual threshold. Same pattern as HealthBars and
   * BackgroundGrid — Pixi v8 allocates fresh ShapePath /
   * GpuGraphicsContext per `stroke()` call. Cached per-mount endpoints
   * + alpha; epsilon 0.5 world units (sub-pixel at typical zoom).
   * `_liveBeamCacheCount` is the number of valid entries — used so we
   * can rebuild from cache without depending on Map size invariants.
   */
  private readonly _liveBeamCache: Array<{
    mountId: string;
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    solidLen?: number;
  }> = [];
  private _liveBeamCacheCount = 0;
  /** Same dirty-flag cache for remote shooters' beams (per-shooter +
   *  per-mount keyed). With multiple drones firing at once the rebuild
   *  cost was per-frame × per-beam — the cache compounds. Flat array
   *  matches liveBeam pattern; iteration order is stable across frames
   *  (JS Map preserves insertion order). */
  private readonly _remoteBeamCache: Array<{
    shooterId: string;
    mountId: string;
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    alpha: number;
  }> = [];
  private _remoteBeamCacheCount = 0;
  /** WS-4 Phase 4 — drill-beam slots routed out of the remote-laser loop into
   *  the dedicated mining pool. Same slot shape as `_remoteBeamCache` (the pool
   *  reads only the BeamView subset); reused in place (invariant #14). */
  private readonly _miningBeamCache: Array<{
    shooterId: string;
    mountId: string;
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    alpha: number;
  }> = [];
  private _miningBeamCacheCount = 0;
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
  /** Wall-clock (performance.now) of the previous swarm-sprite update — the dt
   *  source for the structure mount slew (P3.8). 0 ⇒ first frame (one 60 Hz step). */
  private _lastSwarmUpdateNow = 0;
  /** Reused scratch for the `getEntityPose` effects poll — mutated per call
   *  by `entityPoseFromSprite` (+ vx/vy filled from `_lastMirror`) so the
   *  per-frame engine/shield pose lookup allocates nothing (Invariant #14).
   *  Read synchronously inside the effects tick; never stored across frames. */
  private readonly _enginePoseScratch: EntityPose = { x: 0, y: 0, angle: 0, vx: 0, vy: 0 };
  /** Latest mirror handed to `update()` — lets the `getEntityPose` closure
   *  read a ship's velocity (the sprite carries only x/y/rotation). Set as the
   *  first statement of `update`; the effects tick at the tail of the same
   *  call reads it, so it's always this frame's mirror. */
  private _lastMirror: RenderMirror | null = null;
  /** Cinematic camera (docs/architecture/cinematic-camera.md). While a script
   *  plays the director is the sole camera driver: `update()` stops re-issuing
   *  the local-ship follow and feeds `Camera.setDirectorTarget` instead. */
  private readonly _director = new CameraDirector();
  private readonly _directorOut: DirectorTarget = { x: 0, y: 0, zoom: 1, smoothMs: 0 };
  private readonly _directorLookup: CameraTargetLookup = this.createDirectorLookup();
  private readonly _updateRemoteHitTargetsScratch = new Set<string>();
  private readonly _updateLocalHitTargetsScratch = new Set<string>();
  private readonly _updateLingeringPosesView = new Map<string, { x: number; y: number }>();
  private readonly _updateLingeringPoseEntries: { x: number; y: number }[] = [];
  private readonly _updateProjSeenScratch = new Set<string>();
  /** 2026-05-26 heap-growth gate step 12 — pooled per-frame ctx objects
   *  for the extracted sprite updaters. Pre-fix each `update()` call
   *  allocated 3 fresh ctx literals (8/7/3 fields) at 60-90 Hz =
   *  ~180-270 obj/s, triggering brief GC compaction in the 22-30 ms
   *  inter-RAF gap band. Every field references a permanent member
   *  (Container, Map, Set, MountVisualManager) — initialised once in
   *  the constructor after `this.shipContainer` is assigned. */
  private _shipUpdaterCtx!: ShipSpriteCtx;
  private _swarmUpdaterCtx!: SwarmSpriteCtx;
  private _projectileUpdaterCtx!: ProjectileSpriteCtx;
  /** Off-screen ring/edge indicator. Constructed in the constructor body
   *  (NOT a field initializer) so it sees the assigned `_isTouch` — field
   *  initializers run before the constructor body, where `_isTouch` is still
   *  undefined (WS-B #3/#4 thread touch into the halo). */
  private readonly halo: HaloRadar;
  private damageNumbers: DamageNumberManager | null = null;
  /** Phase 4 WS-B1 — pooled screenspace level-up icon (own ship). */
  private levelUpIcons: LevelUpIconManager | null = null;
  private healthBars: HealthBarManager | null = null;
  private labels: LabelManager | null = null;
  private selectionBracket: SelectionBracket | null = null;
  /** Experimental HUD aim feedback (lock bracket / aim line / ship arcs). */
  private aimFeedback: AimFeedbackRenderer | null = null;
  private hoverBracket: HoverBracket | null = null;
  /** WS-9 (R2.30) — reused scratch for the selection screen-projection (#14). */
  private readonly _selScreenScratch = { x: 0, y: 0 };
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
    shieldRingVisibleCount: 0,
    firstFrameRendered: false,
    artReady: false,
    liveBeamRenderedFromX: null,
    liveBeamRenderedFromY: null,
    placementScreenX: null,
    placementScreenY: null,
    selectionScreenX: null,
    selectionScreenY: null,
    placementChosenWorldX: null,
    placementChosenWorldY: null,
    placementStuck: false,
    placementConfirmSeq: 0,
    helmCourseSeq: 0,
    helmCourseX: 0,
    helmCourseY: 0,
    placementPreviewConnectionCount: 0,
    selectedPickId: null,
    selectedPickKind: null,
    hoveredPickId: null,
    miningBeamCount: 0,
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

  /** Perf scenes (plan prancy-squishing-donut P2): per-frame render cost,
   *  recorded only after `perfProbeSync('enable')` (`?perfprobe=1`). */
  private _perfRing: FrameTimeRing | null = null;

  /** Count probe (WS3): draw calls per rendered frame + upload baselines. */
  private _drawRing: FrameTimeRing | null = null;
  private _drawCount = 0;
  private _drawMark = 0;
  private _uploadsBase = 0;
  private _uploadTexelsBase = 0;

  /** Count mode (`?perfcounts=1`): pin the effects tier (what is drawn must not
   *  depend on the host's speed), count WebGL draw calls by wrapping the
   *  context's draw entry points, and close each rendered frame on Pixi's
   *  `postrender` runner. Perf runs only; players never reach it. */
  private enableCountProbe(): void {
    if (this._drawRing || !this.app?.renderer) return;
    this._drawRing = new FrameTimeRing();
    this.effects?.pinQuality('high');
    const gl = (this.app.renderer as unknown as { gl?: WebGL2RenderingContext }).gl;
    if (gl) {
      // Fixed-arity wrappers: no rest-array per draw call (#14).
      const de = gl.drawElements.bind(gl);
      gl.drawElements = (m, c, t, o) => { this._drawCount++; de(m, c, t, o); };
      const da = gl.drawArrays.bind(gl);
      gl.drawArrays = (m, f, c) => { this._drawCount++; da(m, f, c); };
      if (typeof gl.drawElementsInstanced === 'function') {
        const dei = gl.drawElementsInstanced.bind(gl);
        gl.drawElementsInstanced = (m, c, t, o, n) => { this._drawCount++; dei(m, c, t, o, n); };
      }
      if (typeof gl.drawArraysInstanced === 'function') {
        const dai = gl.drawArraysInstanced.bind(gl);
        gl.drawArraysInstanced = (m, f, c, n) => { this._drawCount++; dai(m, f, c, n); };
      }
    }
    const runners = (this.app.renderer as unknown as { runners?: { postrender?: { add(o: { postrender(): void }): void } } }).runners;
    runners?.postrender?.add({ postrender: () => {
      this._drawRing?.push(this._drawCount - this._drawMark);
      this._drawMark = this._drawCount;
    } });
    this.resetCountProbe();
  }

  private resetCountProbe(): void {
    this._drawRing?.reset();
    this._drawMark = this._drawCount;
    const s = this._artCtx.art?.stats();
    this._uploadsBase = s?.uploads ?? 0;
    this._uploadTexelsBase = s?.uploadTexels ?? 0;
  }

  private readCountProbe(): RenderCountReading | null {
    if (!this._drawRing) return null;
    const d = this._drawRing.summary();
    const s = this._artCtx.art?.stats();
    return {
      drawCalls: { frames: d.frames, p50: d.p50, p95: d.p95, max: d.max },
      textureUploads: (s?.uploads ?? 0) - this._uploadsBase,
      uploadTexels: (s?.uploadTexels ?? 0) - this._uploadTexelsBase,
      atlasPages: s?.pages ?? 0,
      gpuBytes: s?.gpuBytes ?? 0,
    };
  }

  perfProbeSync(op: PerfProbeOp): RenderPerfReading | null {
    if (op === 'enable') { this._perfRing ??= new FrameTimeRing(); return null; }
    if (op === 'counts') { this._perfRing ??= new FrameTimeRing(); this.enableCountProbe(); return null; }
    if (!this._perfRing) return null;
    if (op === 'reset') { this._perfRing.reset(); this.resetCountProbe(); return null; }
    let displayObjects = 0;
    const walk = (c: Container): void => { displayObjects++; for (const ch of c.children) walk(ch as Container); };
    if (this.app?.stage) walk(this.app.stage);
    const m = this._lastMirror;
    return {
      render: this._perfRing.summary(),
      sprites: this.sprites.size,
      displayObjects,
      mirrorShips: m?.ships.size ?? 0,
      mirrorSwarm: m?.swarm?.size ?? 0,
      effectQuality: this.effects?.getQuality() ?? 'none',
      counts: this.readCountProbe(),
    };
  }

  perfProbe(op: PerfProbeOp): Promise<RenderPerfReading | null> {
    return Promise.resolve(this.perfProbeSync(op));
  }

  /** DEBUG (exhaust-side investigation): the local ship sprite WORLD position
   *  + engine particle world positions (pixi coords; gfx.y = -gameY). */
  __debugEngine(): { ship: { x: number; y: number; vx: number; vy: number }; particles: number[] } | null {
    const localId = this._lastMirror?.localPlayerId;
    if (!localId || !this.effects) return null;
    const sp = this.sprites.get(localId);
    if (!sp) return null;
    const out: number[] = [];
    const n = this.effects.debugCopyEngineParticleWorld(out);
    out.length = n * 4;
    const sv = this._lastMirror?.ships.get(localId);
    return { ship: { x: sp.x, y: sp.y, vx: sv?.vx ?? 0, vy: sv?.vy ?? 0 }, particles: out };
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

    this.app = new Application();
    await this.app.init({
      ...(canvas ? { canvas: canvas as unknown as HTMLCanvasElement } : {}),
      width: initialW,
      height: initialH,
      background: BACKGROUND_COLOR,
      antialias: true,
      resolution: initialDpr,
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
      // minScale lowered 0.4 → 0.15 (2026-06-03) so the player can zoom
      // much further out to read the wider battlefield. maxScale (zoom-in)
      // unchanged.
      minScale: GAMEPLAY_MIN_ZOOM,
      maxScale: 3,
      followLerpFactor: 1,
    });
    this.camera.setScreenSize(initialW, initialH);

    // Read the bisected FX kill switches once at init. Threaded into the
    // warp chain (forceDisable) + EffectsService refs (per-effect bypasses).
    // Plan: melodic-engelbart Step 2.
    // Worker path: the switches arrive on BOOT (no `window` here).
    const fxKillSwitches = this._fxKillSwitches ?? readFxKillSwitches();

    // Machined art: bakes run on workers; until an entity's art is ready it
    // draws today's look. The mode is resolved on the main thread (artMode.ts).
    if (this._artOpts.mode === 'machined') {
      const art = createArtService({ touch: this._isTouch, delayMs: this._artOpts.delayMs ?? 0, ...(this._artOpts.lighting ? { lighting: this._artOpts.lighting } : {}) });
      this._artCtx.art = art;
      this._artCtx.sunAz = art.lightRig.sunAz;
      // GPU-lit art (`?shiplight=gpu`): lit meshes are built with these.
      litPass.settings = this._artOpts.lighting ?? null;
      // Machined turrets ride the new effects (rings in the bakes, baked guns).
      this._artCtx.turrets = this._artOpts.fx === true;
      this.mountVisuals.setArt(this._artCtx);
      // Warm-up: bake the likely art now (this runs on the galaxy map /
      // warp screen), behind anything that appears on screen meanwhile.
      art.warmUp(warmUpJobs(this._artOpts.fx === true));
      // New backdrop (B2): behind the world, with dust in front of it. Until
      // its star tiles are baked, today's starfield keeps drawing.
      if (this._artOpts.fx === true) {
        const bd = new Backdrop(art, () => this.effects?.getQuality() ?? 'medium', this._artOpts.speedFx === false ? 'off' : 'large');
        const wi = this.app.stage.getChildIndex(this.world);
        this.app.stage.addChildAt(bd.sky, wi);
        this.app.stage.addChildAt(bd.fore, wi + 2);
        bd.setSector(this._sectorKey);
        this._backdrop = bd;
      }
    }
    // DEV/E2E hook (main-thread path, `?worker=0`): what the art service is
    // doing. Assigned from `update()`, so it always follows the LIVE renderer
    // (a dev StrictMode remount can leave a disposed one behind).
    if (isDom) this._artStatsHook = () => this.artStats();
    this._beamsDisabled = fxKillSwitches.beamsDisabled;
    this._dmgNumbersDisabled = fxKillSwitches.dmgNumbersDisabled;
    this._selfDmgNumbersDisabled = fxKillSwitches.selfDmgNumbersDisabled;
    this._healthBarsDisabled = fxKillSwitches.healthBarsDisabled;

    // Default gameplay zoom. Historically the gameplay camera ran at the
    // Pixi default scale 1.0 (the worker Camera replaced pixi-viewport,
    // which only ever `moveCenter`d the gameplay world — it never set a
    // zoom; cf. GalaxyOverviewRenderer's setZoom(0.7), a separate map).
    // `DEFAULT_GAMEPLAY_ZOOM` makes that explicit + one-line tunable, and
    // the `?zoom=` URL override lets us A/B the sweet spot on-device
    // before baking a new default in. (plan: zazzy-engelbart, Phase 2.)
    const resolvedZoom =
      zoom !== undefined && Number.isFinite(zoom) && zoom > 0
        ? zoom
        : startZoomForScale(DEFAULT_GAMEPLAY_ZOOM); // ship scale (shipScale/tuning)
    this._zoomPinned = resolvedZoom !== startZoomForScale(DEFAULT_GAMEPLAY_ZOOM);
    this.camera.setZoom(resolvedZoom);

    // Frame diagnostic (gated). The decisive crispness metric: the
    // backing buffer (`app.canvas.width`) MUST equal round(CSS px × dpr)
    // for true 1:1 HiDPI. Pre-fix the worker path double-applied dpr.
    // Captured on-device via `?diag=1` (plan: zazzy-engelbart, Phase 0).
    if (isDiagEnabled()) {
      logEvent('render_frame_diag', {
        phase: 'init',
        mode: isDom ? 'dom' : 'worker',
        appResolution: this.app.renderer.resolution,
        rendererType: (this.app.renderer as unknown as { type?: number }).type ?? -1,
        canvasW: this.app.canvas.width,
        canvasH: this.app.canvas.height,
        inW: initialW,
        inH: initialH,
        dpr: initialDpr,
        worldScaleX: this.world.scale.x,
      });
    }

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
    if (fxKillSwitches.filtersDisabled) {
      this.warp.forceDisable();
    }

    // `?cleanworld=1` (showcase capture) drops debug-flavoured world overlays:
    // the spatial grid, turret aim-guides and NPC callsign labels.
    this._cleanWorld = fxKillSwitches.cleanWorld;
    this.mountVisuals.setAimLinesVisible(!this._cleanWorld);
    if (!this._cleanWorld) {
      this.backgroundGrid = new BackgroundGrid();
      this.backgroundGrid.attach(this.camera);
    }

    this.shipContainer = new Container();
    this.camera.addChild(this.shipContainer);
    // Round 3 E1: far-zoom dots above the ships they stand in for.
    this.camera.addChild(this._lodDots.container);

    // Structures plan, Phase 3 — the grid connector web. Added FIRST so the
    // lines render BEHIND the structure/ship sprites added later.
    this.connectorRenderer = new ConnectorRenderer();
    // A3 — the static layer (idle web, range rings, wall rails) sits behind the
    // per-frame layer.
    this.shipContainer.addChild(this.connectorRenderer.staticGfx);
    this.shipContainer.addChild(this.connectorRenderer.gfx);
    // Warp-to visuals (Phase 4): engine build-up, blur streak, burning trails.
    // Cheap sprites, under the hulls; drawn for every render mode.
    this.shipContainer.addChild(this._warpFx.layer);
    // Warp spool-up: the engines overcharge (glow + sparks, under the hulls).
    this.shipContainer.addChild(this._spoolFx.layer);

    // 2026-05-26 heap-growth gate step 12 — pool ctx objects for the
    // per-frame sprite updaters. All fields are permanent references;
    // initialised once here, mutated never. Object identity stable for
    // the renderer's lifetime. Eliminates ~180-270 obj/s of per-frame
    // ctx-literal allocation introduced by the god-file refactor.
    // `!`-declared readonly fields accept the constructor-body
    // assignment without any cast.
    this._shipUpdaterCtx = {
      shipContainer: this.shipContainer,
      sprites: this.sprites,
      mountVisuals: this.mountVisuals,
      remoteHitTargets: this._updateRemoteHitTargetsScratch,
      localHitTargets: this._updateLocalHitTargetsScratch,
      seenScratch: this._updateSeenScratch,
      art: this._artCtx,
    };
    this._swarmUpdaterCtx = {
      shipContainer: this.shipContainer,
      sprites: this.sprites,
      mountVisuals: this.mountVisuals,
      swarmPoseScratch: this.swarmPoseScratch,
      remoteHitTargets: this._updateRemoteHitTargetsScratch,
      localHitTargets: this._updateLocalHitTargetsScratch,
      seenScratch: this._updateSeenScratch,
      structureMountAngles: this._structureMountSlew,
      spriteKinds: this._swarmSpriteKinds,
      spriteBuildSigs: this._swarmSpriteSigs,
      slewDtSec: 1 / 60, // overwritten per frame before updateSwarmSprites
      art: this._artCtx,
    };
    this._projectileUpdaterCtx = {
      shipContainer: this.shipContainer,
      projectileSprites: this.projectileSprites,
      projSeenScratch: this._updateProjSeenScratch,
    };
    this._missileUpdaterCtx = {
      shipContainer: this.shipContainer,
      missileSprites: this.missileSprites,
      missileSeenScratch: this._updateMissileSeenScratch,
      activeExplosions: this.missileExplosionsActive,
    };
    // New weapons (B3, `?fx=new`): beam glow + flow over today's beam pools,
    // and bolts / tracers as batched sprites. Nothing draws until baked.
    if (this._artOpts.fx === true && this._artCtx.art) {
      const art = this._artCtx.art;
      this._fxLiveBeams = new FxBeams(art, 0x6fd0ff);
      this._fxRemoteBeams = new FxBeams(art, 0xffaa44);
      this._fxProjectiles = new FxProjectiles(art);
      this.shipContainer.addChild(this._fxRemoteBeams.container, this._fxLiveBeams.container, this._fxProjectiles.container);
      this._projectileUpdaterCtx.fx = this._fxProjectiles;
      // B4: explosions (ship / drone / structure deaths, missile detonations)
      // and missile smoke trails.
      this._fxExplosions = new FxExplosions(art, () => this.effects?.getQuality() ?? 'medium');
      this._fxExplosions.onSpawn = (x, y, r): void => this.noteBlastLight(x, y, r);
      this._fxMissileTrails = new FxMissileTrails(art);
      this.shipContainer.addChild(this._fxMissileTrails.smokeLayer, this._fxExplosions.smokeLayer, this._fxMissileTrails.glowLayer, this._fxExplosions.fireLayer);
      this._missileUpdaterCtx.fxTrails = this._fxMissileTrails;
      // Engine exhaust: a flame + ribbon at every Machined nozzle, for every
      // ship (players and drones). Under the hulls; ship sprites are added later.
      this._fxEngines = new FxEngines(art, () => this.effects?.getQuality() ?? 'medium');
      this.shipContainer.addChild(this._fxEngines.trailLayer, this._fxEngines.flameLayer, this._fxEngines.glowLayer);
      this._missileUpdaterCtx.fxExplosions = this._fxExplosions;
      // B5: shields (invisible at rest; hit ripples, held laser contacts,
      // break) and fences (energy line, raise / power-loss / gate).
      this._fxShields = new FxShields(art);
      this._fxFences = new FxFences(art);
      this.shipContainer.addChild(this._fxShields.container);
      // Fences sit just above the connector web, below the sprites.
      this.shipContainer.addChildAt(this._fxFences.container, this.shipContainer.getChildIndex(this.connectorRenderer.gfx) + 1);
      this.connectorRenderer.fxFences = this._fxFences;
    }

    // Effects subsystem (plan `wiggly-puppy` M3+). Constructed inside
    // PixiRenderer.init so the same single seam serves both the worker
    // path (this whole file runs inside the renderer worker) AND the
    // main-thread fallback (touch devices, Safari < 17). ?effects=0 URL
    // hatch skips construction entirely.
    if (!effectsDisabledByUrl()) {
      // Eagerly create the beam sprite pools (post-2026-06-01 — was
      // Pixi Graphics). Each pool's Container is exposed as
      // `liveBeamGfx` / `remoteBeamGfx` so LaserGlow can attach a
      // GlowFilter to it at construct time. Empty pools render as
      // nothing — no visual change before first beam.
      this._liveBeamPool = new BeamSpritePool({ tint: LASER_CORE_COLOR, width: 2, alpha: 1, taper: true });
      this.liveBeamGfx = this._liveBeamPool.container;
      this.shipContainer.addChild(this.liveBeamGfx);
      this._remoteBeamPool = new BeamSpritePool(REMOTE_BEAM_STYLE);
      this.remoteBeamGfx = this._remoteBeamPool.container;
      this.shipContainer.addChild(this.remoteBeamGfx);
      // WS-4 Phase 4 — the Miner's mining beam: a distinct fat warm-amber drill
      // beam, separate pool so its `liveCount` is isolatable + its look differs
      // from the combat laser. Styles are named consts (beamStyles.ts) so the
      // distinction is greppable + regression-locked. Sits behind the sprites.
      this._miningBeamPool = new BeamSpritePool(MINING_BEAM_STYLE);
      this.miningBeamGfx = this._miningBeamPool.container;
      this.shipContainer.addChild(this.miningBeamGfx);

      this.effects = new EffectsService({
        app: this.app,
        world: this.world,
        stage: this.app.stage,
        camera: this.camera,
        warpChain: this.warp,
        ...(this._artOpts.fx === true && this._artCtx.art ? { fxGlow: this.fxGlowTexture() } : {}),
        // Per-frame pose lookup. Reads the RENDERED sprite position so
        // it stays in lockstep with whatever frame the engine emitter
        // ticks on (one-pose-per-frame invariant for drones too — the
        // sprite was just set from the resolved swarm pose by
        // updateSwarmSprites). Returns null for entities not in the
        // sprite map (despawned, never spawned, off-interest).
        getEntityPose: (entityId: string) => {
          // Active ships + drones live in `this.sprites`; PARKED lingering hulls
          // live in the SEPARATE `this.lingeringSprites` map. Effects registered
          // for a lingering hull (the shield aura — P3.12 / WS-C3) must resolve
          // its pose too, or the ring registers but `ShieldAura` hides it every
          // frame (the "lingering ships don't draw a shield" bug). Fall back.
          const sp = this.sprites.get(entityId) ?? this.lingeringSprites.get(entityId)?.sprite;
          if (!sp) return null;
          // Pure seam helper: converts the Pixi sprite pose BACK to game
          // space (Y-up, angle un-negated). Mutates the reused scratch so
          // the per-frame poll allocates nothing (Invariant #14); the
          // emitter reads it synchronously and never stores it.
          const pose = entityPoseFromSprite(sp, this._enginePoseScratch);
          // Velocity for speed-scaled emission + coherent streaming. The
          // sprite carries no velocity; read it from this frame's mirror.
          // Ships only (drones live in mirror.swarm and don't emit engine
          // particles) → undefined for non-ships ⇒ 0.
          const ship = this._lastMirror?.ships.get(entityId);
          pose.vx = ship?.vx ?? 0;
          pose.vy = ship?.vy ?? 0;
          return pose;
        },
        beams: { liveBeamGfx: this.liveBeamGfx, remoteBeamGfx: this.remoteBeamGfx },
        fxKillSwitches,
      });
    }

    this.halo.init(this.camera);
    // Damage numbers attach to the world (pan with camera, anchored at
    // impact world coord) but counter-scale per frame so they stay
    // legible at any zoom — Camera ref needed for the per-frame
    // counter-scale.
    this.damageNumbers = new DamageNumberManager(this.world, this.camera);
    this.levelUpIcons = new LevelUpIconManager(this.world, this.camera);
    this.healthBars = new HealthBarManager(this.world);
    this.labels = new LabelManager(this.world, !this._cleanWorld);
    // Click-to-inspect selection bracket (Item B4). Parented to the world
    // container (camera-transformed, world space like the health bars) so the
    // 4-corner bracket tracks the selected entity as it (and the camera) moves.
    this.selectionBracket = new SelectionBracket(this.world);
    this.hoverBracket = new HoverBracket(this.world);
    this.aimFeedback = new AimFeedbackRenderer(this.world);

    // Drive Camera momentum + follow each frame (works in both contexts).
    this.app.ticker.add(() => {
      // deltaMS keeps the Camera's zoom-ease framerate-independent
      // (60 / 90 / 120 Hz devices ease at the same wall-clock rate).
      this.camera.tick(this.app.ticker.deltaMS);
      // Machined art: pack finished bakes every frame — including on the
      // galaxy map / warp screen, where `update()` doesn't run, so the
      // warm-up lands before the player joins.
      this._artCtx.art?.tick();
      // GPU-lit art: light every lit mesh from this frame's lights, before render.
      if (litPass.settings && this._artCtx.art && litPass.count > 0) litPass.finish(this.world, this._artCtx.art.lightRig, this.app.renderer.resolution);
      if (this._artCtx.art && ++this._artCollectFrame >= ART_COLLECT_EVERY_FRAMES) {
        this._artCollectFrame = 0;
        this.collectUnusedArt();
      }
      if (this._artStatsHook) (globalThis as { __eqxArtStats?: () => unknown }).__eqxArtStats = this._artStatsHook;
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
        // Re-apply DPR so browser-zoom / monitor-move updates resolution
        // on the main-thread path too (parity with the worker resize).
        const dpr = window.devicePixelRatio ?? 1;
        this.app.renderer.resize(w, h, dpr);
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
  resize(width: number, height: number, dpr?: number): void {
    if (!this.initialized || !this.app?.renderer) return;
    // Pass resolution through so a DPR change (monitor move / browser
    // zoom / some rotations) re-derives the backing buffer. Omitting it
    // (the old behaviour) kept the stale init resolution → blur after
    // such a change. `width`/`height` are LOGICAL (CSS) px.
    this.app.renderer.resize(width, height, dpr ?? this.app.renderer.resolution);
    this.camera.setScreenSize(width, height);
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

  /**
   * Worker-context entry point for synthesised pointer events forwarded
   * from the main thread. The Camera consumes via its state machine.
   */
  forwardPointerEvent(e: { type: string; pointerId: number; offsetX: number; offsetY: number; stamp: number; button?: number; pointerType?: string }): void {
    // Galaxy selector (spawn/warp picker) owns pointer input for free
    // pan/zoom; a tap is resolved to a sector inside the layer. Otherwise
    // the world camera consumes it (gameplay pan/zoom + tap).
    const gl = this._galaxyLayer;
    if (gl !== null && gl.isPanZoomActive()) {
      switch (e.type) {
        case 'pointerdown': gl.onPointerDown(e.pointerId, e.offsetX, e.offsetY, e.stamp); break;
        case 'pointermove': gl.onPointerMove(e.pointerId, e.offsetX, e.offsetY); break;
        case 'pointerup': gl.onPointerUp(e.pointerId, e.offsetX, e.offsetY, e.stamp); break;
        case 'pointercancel':
        case 'pointerleave': gl.onPointerCancel(e.pointerId); break;
      }
      return;
    }
    // Structure placement positions the ghost instead of panning (worker path).
    if (this._placementActive) {
      this.routePlacementPointer(e.type, e.offsetX, e.offsetY, e.button ?? -1, e.pointerType ?? 'mouse');
      return;
    }
    switch (e.type) {
      case 'pointerdown':
        this.camera.onPointerDown(e.pointerId, e.offsetX, e.offsetY, e.stamp);
        break;
      case 'pointermove':
        this.camera.onPointerMove(e.pointerId, e.offsetX, e.offsetY);
        // WS-10 (R2.4) — desktop hover outline. Renderer-local; gated like
        // selection so it never fires over the galaxy layer / during placement.
        if (!this.galaxyTapSuppressed() && !this._placementActive) {
          this.handleGameplayHover(e.offsetX, e.offsetY);
        }
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
        // Click-to-inspect (Item B2): a gameplay tap selects an entity, gated
        // off galaxy + placement so it never cross-fires with warp/picker/build.
        if (result.wasTap && !this.galaxyTapSuppressed() && !this._placementActive) {
          this.handleGameplayTap(e.offsetX, e.offsetY);
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
    if (layer instanceof GalaxyMapLayer) this._galaxyLayer = layer;
  }

  /** Worker-context wheel forwarding. */
  forwardWheelEvent(deltaY: number, offsetX: number, offsetY: number): void {
    const gl = this._galaxyLayer;
    if (gl !== null && gl.isPanZoomActive()) {
      gl.onWheel(deltaY, offsetX, offsetY);
      return;
    }
    this.camera.onWheel(deltaY, offsetX, offsetY);
  }

  /**
   * Install pointer/wheel/touch listeners on the canvas and forward
   * them into the Camera. Replaces pixi-viewport's automatic
   * `events: app.renderer.events` subscription. Touch hijacking is
   * suppressed via `{ passive: false }` + `preventDefault`.
   */
  private readonly canvasListeners: Array<{ type: string; handler: EventListener; options?: AddEventListenerOptions }> = [];
  /** P3.5 — the window-level placement-drag pointermove handler (so the ghost
   *  follows the pointer off-canvas / over overlays). Removed in dispose(). */
  private _placementWindowMoveHandler: EventListener | null = null;
  private installCanvasEventListeners(canvas: HTMLCanvasElement): void {
    const onPointer = (e: PointerEvent): void => {
      const stamp = Date.now();
      // Galaxy selector owns pointer input (free pan/zoom; tap → sector).
      const gl = this._galaxyLayer;
      if (gl !== null && gl.isPanZoomActive()) {
        switch (e.type) {
          case 'pointerdown': gl.onPointerDown(e.pointerId, e.offsetX, e.offsetY, stamp); break;
          case 'pointermove': gl.onPointerMove(e.pointerId, e.offsetX, e.offsetY); break;
          case 'pointerup': gl.onPointerUp(e.pointerId, e.offsetX, e.offsetY, stamp); break;
          case 'pointercancel':
          case 'pointerleave': gl.onPointerCancel(e.pointerId); break;
        }
        return;
      }
      // Structure placement: position the blueprint ghost instead of panning.
      // The Camera's `screenToWorld` gives pixi-world coords (y = -gameY).
      if (this._placementActive) {
        // Capture the pointer for the duration of the placement drag (playtest
        // 2026-06-10 Issue 9 — "desktop build-drag breaks"). A fast drag that
        // leaves the canvas (or another element grabbing the pointer) stops
        // delivering pointermove, stalling the ghost. Capture keeps every
        // move/up routed here until release.
        setCanvasPointerCapture(canvas, e.type, e.pointerId);
        this.routePlacementPointer(e.type, e.offsetX, e.offsetY, e.button, e.pointerType);
        return;
      }
      switch (e.type) {
        case 'pointerdown':
          this.camera.onPointerDown(e.pointerId, e.offsetX, e.offsetY, stamp);
          break;
        case 'pointermove':
          this.camera.onPointerMove(e.pointerId, e.offsetX, e.offsetY);
          // WS-10 (R2.4) — desktop hover outline (main-thread render path).
          if (!this.galaxyTapSuppressed() && !this._placementActive) {
            this.handleGameplayHover(e.offsetX, e.offsetY);
          }
          break;
        case 'pointerup': {
          const result = this.camera.onPointerUp(e.pointerId, e.offsetX, e.offsetY, stamp);
          // Click-to-inspect (Item B2): a confirmed gameplay tap (not a drag)
          // selects an entity. Gated off the galaxy layer + placement so it
          // never cross-fires. The galaxy `isPanZoomActive` branch above
          // already returned for the selector; `galaxyTapSuppressed()` also
          // covers the in-game overlay (warp taps).
          if (result.wasTap && !this.galaxyTapSuppressed() && !this._placementActive) {
            this.handleGameplayTap(e.offsetX, e.offsetY);
          }
          break;
        }
        case 'pointercancel':
        case 'pointerleave':
          this.camera.onPointerCancel(e.pointerId);
          break;
      }
    };
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const gl = this._galaxyLayer;
      if (gl !== null && gl.isPanZoomActive()) {
        gl.onWheel(e.deltaY, e.offsetX, e.offsetY);
        return;
      }
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

    // P3.5 — desktop placement drag: while placing, the ghost must keep
    // following the pointer even when it leaves the canvas or crosses an HUD
    // overlay (canvas `pointermove` isn't delivered there — the user's repeated
    // "desktop drag breaks"). ALSO listen on the WINDOW and route window moves
    // (converted to canvas-local) to the ghost while placement is active.
    // GATE on `e.target !== canvas`: moves OVER the canvas are already routed by
    // the canvas listener above using the native, canvas-relative `e.offsetX`.
    // Re-routing those here with `clientX - rect.left` would DOUBLE-handle them,
    // and the window value would clobber the canvas one — on the worker path the
    // two computations diverge, so the chosen point snapped to a wrong world
    // coord (feature E regression). Only handle the off-canvas / over-overlay
    // case the canvas listener can't see.
    //
    // CAPTURE PHASE (P3.5 follow-still-broken, 2026-06-13): registered with
    // `{ capture: true }` so it fires on the way DOWN, BEFORE any element under
    // the pointer (the MUI speed-dial / its tooltips) can `stopPropagation` a
    // bubble-phase listener away. `window` is the outermost capture target, so
    // nothing can intercept it — this is the true "connect to the ENTIRE window
    // mouse move" the placement follow needs. Removed (with matching capture
    // flag) in dispose().
    const onWindowPlacementMove = (e: PointerEvent): void => {
      if (!this._placementActive || e.target === canvas) return;
      const rect = canvas.getBoundingClientRect();
      this.routePlacementPointer('pointermove', e.clientX - rect.left, e.clientY - rect.top, e.button, e.pointerType);
    };
    window.addEventListener('pointermove', onWindowPlacementMove, true);
    this._placementWindowMoveHandler = onWindowPlacementMove as EventListener;
  }

  /**
   * Position the placement blueprint ghost from a canvas pointer event. Shared
   * by the main-thread path (`installCanvasEventListeners`) and the worker path
   * (`forwardPointerEvent`). `screenX/Y` are canvas-relative. `screenToWorld`
   * returns pixi-world coords, so `gameY = -that.y`.
   *
   * Follow model: `_placementFollowing` starts true when placement begins, so
   * the ghost tracks the pointer (desktop HOVER move / mobile DRAG). Releasing
   * (pointer-up) parks the ghost (`following = false`).
   *
   * WS-10 (R2.5) — DESKTOP one-click placement: a MOUSE left-click (pointerup,
   * `button === 0`, `pointerType === 'mouse'`) COMMITS the blueprint at the
   * cursor by bumping `feedback.placementConfirmSeq` (gameRafLoop edge-detects it
   * and places at the chosen point, then clears `placementKind`). TOUCH never
   * commits here — a touch pointer-up just parks the ghost so the Confirm banner
   * appears (the tap-to-position flow), so the two-step touch UX is unchanged.
   */
  private routePlacementPointer(
    type: string,
    screenX: number,
    screenY: number,
    button: number,
    pointerType: string,
  ): void {
    const w = this.camera.screenToWorld(screenX, screenY);
    const gameX = w.x;
    const gameY = -w.y;
    // Pure state machine (placementPointerDecision.ts) — the load-bearing rule
    // is that `pointerleave` does NOT park the follow (P3.5 follow-still-broken):
    // desktop hover-follow has no pointer capture, so leaving the canvas (over
    // the speed-dial / off-screen) must not break the lock. Unit-locked.
    const outcome = decidePlacementPointer(type, pointerType, button, this._placementFollowing);
    if (outcome.following !== null) this._placementFollowing = outcome.following;
    if (outcome.updateChosen) {
      this._placementChosenX = gameX;
      this._placementChosenY = gameY;
    }
    if (outcome.commit) this.feedback.placementConfirmSeq++;
  }

  /**
   * Click-to-inspect (Item B2). A confirmed gameplay tap (NOT a drag) resolves
   * to the nearest entity under the tap via the pure `pickEntityAt`. The
   * renderer OWNS the selection:
   *   - tap empty space        → clear selection
   *   - tap a new entity       → select it
   *   - re-tap the SAME entity → toggle it off (deselect)
   * The result is published each frame in `feedback.selectedPickId/Kind`.
   *
   * Gated by the callers on `!galaxyTapSuppressed() && !_placementActive` so it
   * never cross-fires with the galaxy selector/overlay or blueprint placement.
   * `screenX/Y` are canvas-relative pixels; `screenToWorld` returns pixi-world
   * coords (y = -gameY), so the pick runs in GAME space.
   */
  private handleGameplayTap(screenX: number, screenY: number): void {
    if (this._lastMirror === null) return;
    const w = this.camera.screenToWorld(screenX, screenY);
    const gameX = w.x;
    const gameY = -w.y;
    const hit = pickEntityAt(gameX, gameY, this._lastMirror);
    if (hit === null) {
      this._selectedId = null;
      this._selectedKind = null;
      // Helm orders: a capital pilot's tap on empty space sets the course.
      const m = this._lastMirror;
      const own = m.localPlayerId ? m.ships.get(m.localPlayerId) : undefined;
      if (own !== undefined && getShipKind(own.kind ?? null).sizeClass === 'capital') {
        this.feedback.helmCourseX = gameX;
        this.feedback.helmCourseY = gameY;
        this.feedback.helmCourseSeq++;
      }
    } else if (hit.id === this._selectedId) {
      this._selectedId = null; // re-tap toggles off
      this._selectedKind = null;
    } else {
      this._selectedId = hit.id;
      this._selectedKind = hit.kind;
    }
  }

  /**
   * Hover outline (WS-10 / R2.4). On desktop pointer-MOVE (no button), resolve
   * the entity under the cursor via the SAME pure `pickEntityAt` the tap uses and
   * stash it in `_hoveredId` (renderer-local — NEVER Zustand, #2). The per-frame
   * `update()` draws the lighter `HoverBracket` around it. Reads the already-
   * resolved `_lastMirror` (one-pose-per-frame; pickEntityAt reads `entry.x/y`
   * for kind 1/2, never re-interpolates). Gated by the callers on
   * `!galaxyTapSuppressed() && !_placementActive` (same as selection) so it never
   * fires over the galaxy layer or during blueprint placement.
   */
  private handleGameplayHover(screenX: number, screenY: number): void {
    if (this._lastMirror === null) {
      this._hoveredId = null;
      return;
    }
    const w = this.camera.screenToWorld(screenX, screenY);
    const hit = pickEntityAt(w.x, -w.y, this._lastMirror);
    this._hoveredId = hit?.id ?? null;
  }

  /**
   * DEV/E2E-only deterministic hover at a GAME-space point — bypasses
   * screen→world projection (camera-transform fragility) so a Playwright spec can
   * hover an entity at its known world position. Mirrors `devSelectAtWorld`; runs
   * the SAME `pickEntityAt` the real pointer-move hover uses. Returns the id.
   */
  devHoverAtWorld(gameX: number, gameY: number): string | null {
    if (this._lastMirror === null) return null;
    const hit = pickEntityAt(gameX, gameY, this._lastMirror);
    this._hoveredId = hit?.id ?? null;
    return this._hoveredId;
  }

  /**
   * #7 — the SINGLE-OWNER drain for `pendingWarpEvents` (remote warp_in/out
   * broadcasts from the server). Extracted from `update()` so the actual wiring
   * is unit-lockable headlessly (it needs only `_galaxyLayer`, `warp`,
   * `triggerWarpIn`, and the counters — no WebGL).
   *
   * The WarpFilterChain lives on the shared `app.stage`, and the GalaxyMapLayer
   * is a child of that same stage, so a remote-warp ripple bleeds across the
   * galaxy overlay the player is reading. Skip the cosmetic visual entirely
   * while the map is open (the gameplay scene isn't the focus anyway). Still
   * drain the queue so it doesn't back up. The fire/skip decision is the shared
   * pure `remoteWarpEventFires` (galaxy-map gate AND burst-in-flight gate) — the
   * same function the DEV hook reads, so the hook cannot drift from this drain.
   */
  private drainRemoteWarp(mirror: RenderMirror): void {
    if (!mirror.pendingWarpEvents || mirror.pendingWarpEvents.length === 0) return;
    const galaxyMapOpen = this._galaxyLayer?.visible === true;
    const burstInFlight = this.warp.isBurstInFlight();
    if (remoteWarpEventFires({ galaxyMapOpen, burstInFlight })) {
      // Fire ONLY the first queued event this frame. Subsequent events get
      // visually skipped — at 1-2 warps/sec from drones plus a 1.5 s burst
      // window, the visible duty cycle is close to 100 % anyway, so dropping
      // 1-2 visuals is invisible to the player but bounds GPU cost.
      const first = mirror.pendingWarpEvents[0]!;
      this.triggerWarpIn({ kind: 'world', worldX: first.x, worldY: first.y });
      this._remoteWarpFiredCount++;
    } else {
      this._remoteWarpSuppressedCount++;
    }
    mirror.pendingWarpEvents.length = 0;
  }

  /**
   * DEV/E2E + test-only (#7): the observable outcome of the `pendingWarpEvents`
   * drain. `fired` counts events that fired their ripple (`triggerWarpIn`);
   * `suppressed` counts events skipped (galaxy map open / burst in flight). The
   * lock that the drain ACTUALLY honours the galaxy-map gate reads these after
   * driving `drainRemoteWarp` — reverting the gate moves the counter the wrong
   * way (see `PixiRenderer.warpGalaxyGate.test.ts`).
   */
  debugRemoteWarpCounts(): { fired: number; suppressed: number } {
    return { fired: this._remoteWarpFiredCount, suppressed: this._remoteWarpSuppressedCount };
  }

  /**
   * DEV/E2E-only (#7): would a queued REMOTE-warp event fire its ripple right
   * now, given the live galaxy-map state? Returns the EXACT gate the
   * `pendingWarpEvents` drain applies (`shouldFireRemoteWarpVisual` against
   * `_galaxyLayer.visible`), so a spec can assert the warp ripple is suppressed
   * while the galaxy map is open without injecting a server warp broadcast. This
   * is the galaxy-map gate ONLY (it ignores the transient burst-in-flight gate)
   * — it answers "is the map suppressing the ripple", which is what the E2E
   * checks; it reads the SAME `shouldFireRemoteWarpVisual` the drain composes
   * into `remoteWarpEventFires`.
   */
  devRemoteWarpVisualWouldFire(): boolean {
    const galaxyMapOpen = this._galaxyLayer?.visible === true;
    return shouldFireRemoteWarpVisual({ galaxyMapOpen });
  }

  /** True while the galaxy layer should swallow gameplay taps — either the
   *  full-screen selector (pan/zoom active) OR the in-game additive overlay is
   *  up (a tap there warps to a neighbour). Selection must not fire in either. */
  private galaxyTapSuppressed(): boolean {
    const gl = this._galaxyLayer;
    return gl !== null && (gl.isPanZoomActive() || gl.visible);
  }

  /**
   * DEV/E2E-only deterministic selection at a GAME-space point — bypasses
   * screen→world projection so a Playwright spec can select an entity at its
   * known world position without the camera-transform fragility a real screen
   * tap would carry. Mirrors the `__eqxGalaxyPick` DEV-hook pattern. Runs the
   * SAME `pickEntityAt` + toggle logic the real tap uses, so it exercises the
   * full pick → select → bracket → feedback path. Returns the resolved id.
   */
  devSelectAtWorld(gameX: number, gameY: number): string | null {
    if (this._lastMirror === null) return null;
    const hit = pickEntityAt(gameX, gameY, this._lastMirror);
    if (hit === null) {
      this._selectedId = null;
      this._selectedKind = null;
    } else if (hit.id === this._selectedId) {
      this._selectedId = null;
      this._selectedKind = null;
    } else {
      this._selectedId = hit.id;
      this._selectedKind = hit.kind;
    }
    return this._selectedId;
  }

  /** The zoom range follows the ship you fly: on a change of kind, the
   *  zoom-out floor moves, and a different-sized hull starts at its own zoom
   *  (unless `?zoom=` pinned it). Compares ids only, so steady state is free. */
  private applyHullZoom(mirror: RenderMirror): void {
    const ship = mirror.localPlayerId ? mirror.ships.get(mirror.localPlayerId) : undefined;
    const id = ship?.kind ?? null;
    if (id === null || id === this._zoomKindId) return;
    this._zoomKindId = id;
    const kind = getShipKind(id);
    zoomRangeForKind(kind, DEFAULT_GAMEPLAY_ZOOM, this._zoomRange);
    this.camera.setMinScale(this._zoomRange.minScale);
    const f = hullZoomFactor(kind);
    if (f !== this._zoomFactor) {
      this._zoomFactor = f;
      if (!this._zoomPinned) this.camera.setZoom(this._zoomRange.startZoom);
    }
  }

  update(mirror: RenderMirror): void {
    // GPU-lit art: this frame's lights are added by the effects below.
    if (litPass.settings) litPass.begin();
    // F1 — bracket the whole update() for `rendererUpdateMs`. Single
    // exit point (the method has no early `return`), so a start-stamp +
    // tail-write is exact. Sub-µs, unconditional (markers-off baseline =
    // production cost). See `frameMarkers` / `FrameMarkers`.
    const updateStart = performance.now();
    // Stash this frame's mirror so the getEntityPose effects closure can read
    // ship velocity (the sprite carries only x/y/rotation). The effects tick
    // at the tail of THIS update reads it → always the current frame's mirror.
    this._lastMirror = mirror;
    // 2026-05-25 heap-growth gate step 6: reuse persistent scratch
    // containers instead of `new Set<string>()` per frame.
    const seen = this._updateSeenScratch;
    seen.clear();

    // Per-frame hit-target sets — see pixi/hitTargetSets.ts.
    const remoteHitTargets = this._updateRemoteHitTargetsScratch;
    const localHitTargets = this._updateLocalHitTargetsScratch;
    fillHitTargetSets(mirror, remoteHitTargets, localHitTargets);

    // Active-ship sprite update — sprite creation, pose, tint, thrust
    // + boost flames. See pixi/shipSpriteUpdater.ts. Ctx pooled to
    // `this._shipUpdaterCtx` (heap-growth gate step 12) — same fields
    // every frame, no per-call literal allocation.
    this.mountVisuals.setLocalAim(mirror.localPlayerId, mirror.localAimMountIds);
    this.applyHullZoom(mirror);
    this.mountVisuals.setFrame(performance.now(), this.effects?.getQuality() ?? 'medium');
    updateShipSprites(mirror, this._shipUpdaterCtx);

    // Explosion sprites spawned this frame for destroyed ships.
    // 2026-05-13 — look up the targetId across both sprite maps
    // (active ships by playerId, lingering hulls by shipInstanceId).
    // Previously this only checked `this.sprites` (active-only) and
    // defaulted to (0,0) when a lingering hull was destroyed — the
    // user's "explosion appeared at zero zero" bug. Helper is in
    // `spriteUpdateDecisions.ts` and is unit-tested there.
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
        // PRESERVE the decideExplosionPosition lookup — the 2026-05-13
        // Phase 6b fix. Naive `mirror.ships.get(targetId)?.pose` here
        // would regress the "explosion at (0,0)" bug when a lingering
        // hull (mirror.lingeringShips) is destroyed. The helper unifies
        // the two sprite maps.
        const pose = decideExplosionPosition({
          targetId,
          activeShipsByPlayerId: this.sprites,
          lingeringShipsByShipInstanceId: lingeringPosesView,
        });
        if (!pose) continue; // ship not in any map — skip the VFX

        // M4 (effects subsystem plan `wiggly-puppy`): dispatch to the
        // EffectsService when present; fall back to today's inline
        // buildExplosionGfx path under the ?effects=0 escape hatch. The
        // pose returned by the helper is in Pixi space (Y-flipped); the
        // effects service expects world coords, so unflip here.
        // New explosions (B4): sized from the dying sprite; replaces the
        // particle burst + shock filter when its textures are ready.
        const dying = this.sprites.get(targetId);
        const diameter = dying ? Math.max(dying.width, dying.height) : 40;
        if (this._fxExplosions?.spawn(pose.x, -pose.y, blastRadiusFor(diameter), performance.now())) {
          // drawn by FxExplosions
        } else if (this.effects) {
          this.effects.spawnBurst('destruction', pose.x, -pose.y);
          this.effects.triggerOneShotFilter('destruction-shock', pose.x, -pose.y);
        } else {
          const expl = buildExplosionGfx();
          expl.x = pose.x;
          expl.y = pose.y;
          this.shipContainer.addChild(expl);
          this.explosionSprites.push({ gfx: expl, framesLeft: 30 });
        }
      }
    }

    // Advance and remove expired explosion sprites (only the legacy
    // fallback path uses this; the EffectsService manages its own
    // particles + shock filters in its tick).
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

    // Structures plan, Phase 3 — grid connector web (behind sprites). Joins
    // mirror.structures → mirror.swarm positions; no-op when no structures.
    // Item C: feed the connector preview the pointer-chosen ghost point (so the
    // preview lines emanate from where the ghost is actually drawn), then read
    // the would-connect count back into the feedback channel.
    this.connectorRenderer.ghostWorldX = this._placementChosenX;
    this.connectorRenderer.ghostWorldY = this._placementChosenY;
    // Phase 5 — bolder defensive range ring on the hovered/selected turret. The
    // selection/hover ids are `swarm-<entityId>` (structures ride the swarm
    // channel); prefer the selected one.
    const highlightedSel = this._selectedId ?? this._hoveredId;
    this.connectorRenderer.highlightedStructureId =
      highlightedSel !== null && highlightedSel.startsWith('swarm-')
        ? parseInt(highlightedSel.slice('swarm-'.length), 10)
        : null;
    this.connectorRenderer.update(mirror, this.world.scale.x, performance.now());
    this.feedback.placementPreviewConnectionCount =
      this.connectorRenderer.placementPreviewConnectionCount;
    // WS-D (#21) — built-turret defensive range-circle count. DEV hook only (not
    // a RendererFeedback field — that grows the per-frame worker payload and is
    // phase-gated; the unit lock is the primary regression guard). Main-thread
    // render path only, like __eqxGalaxyBadgeCount, so the E2E runs ?worker=0.
    (globalThis as { __eqxBuiltTurretRangeCount?: number }).__eqxBuiltTurretRangeCount =
      this.connectorRenderer.builtTurretRangeCount;

    // Phase 5c swarm sprites (asteroids + drones) — see
    // pixi/swarmSpriteUpdater.ts. Ctx pooled to `this._swarmUpdaterCtx`.
    // P3.8 — feed the structure-mount slew its dt (clamped so a tab-resume /
    // first-frame gap eases rather than teleporting).
    const swarmNow = performance.now();
    this._swarmUpdaterCtx.slewDtSec =
      this._lastSwarmUpdateNow > 0
        ? Math.min(0.05, Math.max(0, (swarmNow - this._lastSwarmUpdateNow) / 1000))
        : 1 / 60;
    this._lastSwarmUpdateNow = swarmNow;
    this._swarmUpdaterCtx.viewBounds = this.camera.visibleBoundsInto(this._swarmViewScratch);
    updateSwarmSprites(mirror, this._swarmUpdaterCtx);
    this._lodDots.update(mirror, this.sprites, this.world.scale.x);
    this.noteTurretShots(mirror);
    this.feedLitScene(mirror);

    for (const [id, sprite] of this.sprites) {
      if (!seen.has(id)) {
        this.shipContainer.removeChild(sprite);
        // Boost flame and mount-visual cluster are children — destroy({
        // children: true }) frees them too, but we still drop the map
        // entries so a respawn rebuilds cleanly.
        this.mountVisuals.removeShip(id);
        sprite.destroy({ children: true });
        this.sprites.delete(id);
        this._structureMountSlew.delete(id); // P3.8 — drop slew state with the sprite
        this._swarmSpriteKinds.delete(id); // #20 — drop kind tracker with the sprite
        this._swarmSpriteSigs.delete(id); // campaign 3.2 — drop build signature with the sprite
        this._artCtx.handles.delete(id); // Machined art — drop the handle with the sprite
      }
    }

    // Projectile + ghost-projectile sprites — see pixi/projectileSpriteUpdater.ts.
    // Ctx pooled to `this._projectileUpdaterCtx`.
    updateProjectileSprites(mirror, this._projectileUpdaterCtx);

    // Missile sprites + detonation VFX. Reads single-pose-per-frame via
    // resolveMissileDisplayPose (one-pose-per-frame rule — same as drones).
    updateMissileSprites(mirror, this._missileUpdaterCtx, performance.now());
    this._fxExplosions?.tick(performance.now());

    // Server ghost: the debug marker showing where the server's last snapshot
    // put the ship, before any client-side prediction replay. OFF unless the
    // player switches it on in Settings (2026-11-06; it used to default on).
    // `?cleanworld=1` (showcase capture) never shows it.
    const ghostEnabled = !this._cleanWorld && mirror.showServerGhost === true;
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
    // New shields (B5): open the frame here; beams and hits feed it below,
    // the shield sync closes it.
    this._fxShieldsOn = this._fxShields !== null && this._fxShields.ready();
    if (this._fxShieldsOn) this._fxShields!.begin();
    if (!this._beamsDisabled && mirror.remoteLasers && mirror.remoteLasers.size > 0 && this._remoteBeamPool) {

      // Origin tracking: the shooter pose moves every frame (drones each
      // tick, players while turning), so we recompute every beam's
      // endpoints from the live mirror/swarm pose and ALWAYS call
      // `setBeams`. The old `BEAM_EPSILON` dirty-cache (combat-fx-hunt
      // 2026-05-31) compared this frame's pose to the PREVIOUS frame, not
      // to the last DRAWN frame — so coasting under the epsilon froze the
      // drawn beam while the shooter flew on, snapping to catch up only
      // when one frame exceeded the threshold (the laser-detach bug, smoke
      // handoff 2026-06-06, Issue 1 Bug #1). `setBeams` is O(count)
      // transform writes (no Graphics triangulation), so always-calling
      // for a handful of beams is free and adds no allocation (invariant
      // #14 — reuses the pooled slot array + pooled sprites).
      const now = performance.now();
      let slotIdx = 0;
      // WS-4 Phase 4 — drill beams route to the dedicated mining pool instead.
      let miningIdx = 0;

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
            // The barrel tip (shared with the server, core/combat/muzzle.ts).
            const muzzleD = mount ? shipShotMuzzle(shooterKind, mount) : shipTuning(shooterKind).muzzleClearance;
            fromX = origin.x + fwdX * muzzleD;
            fromY = origin.y + fwdY * muzzleD;
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
            // A drone's turning turret fires from its barrel tip (the server's
            // AiFireResolver uses the same shared muzzle).
            const barrelOffset = mount ? shipShotMuzzle(shooterKind, mount, true) : swarmShooter.radius + 2;
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
          // Fill the reused pooled slot (no per-beam allocation). The Miner's
          // mining beam (mountId 'drill') routes into the dedicated mining pool
          // (WS-4 Phase 4) so it draws as a distinct fat amber drill beam and is
          // isolatable for the E2E; everything else stays in the remote pool.
          const isMining = mountId === 'drill';
          const cache = isMining ? this._miningBeamCache : this._remoteBeamCache;
          const idx = isMining ? miningIdx : slotIdx;
          let slot = cache[idx];
          if (!slot) {
            slot = { shooterId, mountId, fromX, fromY, toX, toY, alpha };
            cache[idx] = slot;
          }
          slot.shooterId = shooterId;
          slot.mountId = mountId;
          slot.fromX = fromX;
          slot.fromY = fromY;
          slot.toX = toX;
          slot.toY = toY;
          slot.alpha = alpha;
          if (!isMining) this._fxRemoteHit[idx] = laser.hit === true;
          // A beam landing on a shield is a held contact there.
          if (this._fxShieldsOn && !isMining && laser.hit && laser.targetId) this._fxShields!.beam(laser.targetId, 1 + idx, toX, toY, this._fxShieldPose);
          // A beam that hit something with no target id stopped on a fence.
          else if (!isMining && laser.hit && !laser.targetId) this._fxFences?.beam(1 + idx, toX, toY);
          if (isMining) miningIdx++;
          else slotIdx++;
        }
      }
      this._remoteBeamCacheCount = slotIdx;
      this._miningBeamCacheCount = miningIdx;

      // Sprite-pool driven render — no clear/redraw, just transforms.
      // Always re-set: the pool resolves its own pooling + visibility and
      // the transform writes are cheap (see the always-call rationale above).
      this._remoteBeamPool.setBeams(this._remoteBeamCache, slotIdx);
      this.remoteBeamGfx!.visible = true;
      this._fxRemoteBeams?.setBeams(this._remoteBeamCache, slotIdx, performance.now(), this._fxRemoteHit);
      if (this._miningBeamPool && this.miningBeamGfx) {
        this._miningBeamPool.setBeams(this._miningBeamCache, miningIdx);
        this.miningBeamGfx.visible = miningIdx > 0;
        this.feedback.miningBeamCount = this._miningBeamPool.liveCount;
      }
    } else if (this._remoteBeamPool && this.remoteBeamGfx) {
      this.remoteBeamGfx.visible = false;
      this._remoteBeamPool.hideAll();
      this._fxRemoteBeams?.hideAll();
      this._remoteBeamCacheCount = 0;
      if (this._miningBeamPool && this.miningBeamGfx) {
        this.miningBeamGfx.visible = false;
        this._miningBeamPool.hideAll();
        this._miningBeamCacheCount = 0;
        this.feedback.miningBeamCount = 0;
      }
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
    if (!this._beamsDisabled && mirror.liveBeams && mirror.liveBeams.size > 0 && localShip && this._liveBeamPool) {
      const localKind = getShipKind(localShip.kind ?? null);
      const localMounts = localKind.mounts ?? [];

      // Recompute every beam's endpoints from the live ship pose and
      // ALWAYS call `setBeams`. The old `BEAM_EPSILON` dirty-cache
      // (combat-fx-hunt 2026-05-31) compared this frame's pose to the
      // PREVIOUS frame, not to the last DRAWN frame, and overwrote the
      // cache every frame — so coasting/flying under 4 u/frame never
      // tripped `dirty`, `setBeams` was never called, and the DRAWN beam
      // froze in place while the ship flew on (snapping to catch up only
      // when one frame exceeded 4 u). That is the no-enemy fly-forward
      // laser-detach repro (smoke handoff 2026-06-06, Issue 1 Bug #1).
      // `setBeams` is O(count) transform writes — free for 1–2 beams,
      // adds no allocation (invariant #14 — pooled slots + pooled sprites).
      let slotIdx = 0;
      for (const [mountId, beam] of mirror.liveBeams) {
        const mountIdx = localMounts.findIndex((m) => m.id === mountId);
        const mount = mountIdx >= 0 ? localMounts[mountIdx] : undefined;
        const currentMountAngle = mountIdx >= 0 ? (localShip.mountAngles?.[mountIdx] ?? 0) : 0;
        const origin = applyMountOffset(localShip.x, localShip.y, localShip.angle, mount);
        const fireAngle = localShip.angle + (mount?.baseAngle ?? 0) + currentMountAngle;
        const fwdX = -Math.sin(fireAngle);
        const fwdY =  Math.cos(fireAngle);
        const fromX = origin.x + fwdX * 20;
        const fromY = origin.y + fwdY * 20;
        const toX = fromX + fwdX * beam.dist;
        const toY = fromY + fwdY * beam.dist;
        let slot = this._liveBeamCache[slotIdx];
        if (!slot) {
          slot = { mountId, fromX: 0, fromY: 0, toX: 0, toY: 0 };
          this._liveBeamCache[slotIdx] = slot;
        }
        slot.mountId = mountId;
        slot.fromX = fromX;
        slot.fromY = fromY;
        slot.toX = toX;
        slot.toY = toY;
        // P1a — the full-strength solid length (== aim guide / optimal range when
        // not clipped); beyond it the pool fades the beam to nothing.
        slot.solidLen = beam.solidDist;
        if (this._fxShieldsOn && beam.hitId) this._fxShields!.beam(beam.hitId, 500 + slotIdx, toX, toY, this._fxShieldPose);
        // The local beam stops on a fence's prediction collider.
        if (beam.hitId?.startsWith('predwall-')) this._fxFences?.beam(500 + slotIdx, toX, toY);
        slotIdx++;
      }
      this._liveBeamCacheCount = slotIdx;

      // Sprite-pool driven render (matches remoteBeam path) — always re-set.
      this._liveBeamPool.setBeams(this._liveBeamCache, slotIdx);
      this.liveBeamGfx!.visible = true;
      this._fxLiveBeams?.setBeams(this._liveBeamCache, slotIdx, performance.now());
      // E2E observable: publish the ACTUAL drawn beam origin (the sprite
      // transform), not a recompute — this is what catches the detach bug.
      this.feedback.liveBeamRenderedFromX = this._liveBeamPool.renderedFromX;
      this.feedback.liveBeamRenderedFromY = this._liveBeamPool.renderedFromY;
    } else {
      if (this.liveBeamGfx) this.liveBeamGfx.visible = false;
      this._liveBeamPool?.hideAll();
      this._fxLiveBeams?.hideAll();
      this._liveBeamCacheCount = 0;
      this.feedback.liveBeamRenderedFromX = null;
      this.feedback.liveBeamRenderedFromY = null;
    }

    const local = mirror.localPlayerId ? this.sprites.get(mirror.localPlayerId) : null;
    // Phase 4 WS-A1 — in spectator/construction mode the camera free-roams; do
    // NOT re-issue the local-ship follow (which would yank the view back / snap
    // to a ship that no longer exists). `setSpectator(true)` already detached
    // the follow target; the gameplay pointer path keeps panning/zooming it.
    if (this._director.isActive()) {
      // Cinematic script owns the camera — resolved from THIS frame's rendered
      // sprites (updated above), smoothed by the Camera's spring in tick().
      const status = this._director.update(performance.now(), this._directorLookup, this._directorOut, mirror.frameTimeMs);
      if (status === 'active') {
        const d = this._directorOut;
        this.camera.setDirectorTarget(d.x, d.y, d.zoom, d.smoothMs);
      } else if (status === 'released') {
        this.camera.clearDirector();
        this.halo.setCameraRelative(false);
      }
    } else if (local && !this._spectator) {
      // `follow` (not `moveCenter`) — the camera's per-tick interpolator
      // applies this target every Pixi frame (60 Hz), independent of
      // `update()` cadence. With `followLerpFactor: 1` the follow is
      // instant — matches the original every-frame `moveCenter` feel
      // but runs at ticker speed not MIRROR_UPDATE speed. See Camera
      // construction in init() for the rationale.
      this.camera.follow({ x: local.x, y: local.y });
    }

    // Structure placement ghost + world→screen projection for the confirm
    // (smoke handoff 2026-06-06, Issue 5). Draw a translucent blueprint
    // silhouette at the previewed world pose and project that pose to screen
    // so the world-anchored confirm UI can sit on top of it. The ghost lives
    // in `shipContainer` (world space) so it pans/zooms with real structures;
    // Y-flip per the pixiY = -gameY convention. Only active during placement
    // mode (preview set), so the rebuild + `toScreen` alloc is transient UI,
    // never steady-state. (Phase-A3: the create/rebuild/hide branching could
    // move to a pure spriteUpdateDecisions helper if a 3rd preview type lands.)
    const preview = mirror.pendingPlacementPreview;
    // A "pending" preview is the dim post-Confirm ghost (playtest 2026-06-10
    // Issue 7): placement is DONE, so it must NOT capture pointers (the camera
    // pans again) and it draws at the SENT point, dimmer.
    const pendingGhost = preview != null && preview.pending === true;
    this._placementActive = preview != null && !pendingGhost;
    // P6.1 (touch only) — seed the ghost at SCREEN-CENTRE on placement-start so
    // it's visible instead of hidden under the speed-dial at the ahead-of-ship
    // pose. Park it (`following=false`) so the Confirm banner is ready at centre;
    // a tap/drag then repositions it. Desktop is gated out (hover-follow + the
    // ahead-of-ship preview is fine when the cursor is already on screen).
    if (preview && shouldCentreGhostOnActivate(this._isTouch, this._placementChosenX !== null, pendingGhost, this._spectator)) {
      const c = this.camera.center; // world coord (pixi-down) currently at screen centre
      this._placementChosenX = c.x;
      this._placementChosenY = -c.y; // game Y = -worldY
      // Park ONLY on touch (no hover → the Confirm banner waits at centre). On
      // DESKTOP (incl. desktop SPECTATOR, which also centre-seeds because there's
      // no ship to anchor) keep hover-follow ON so the ghost snaps to the cursor
      // on the first move — otherwise the spectator build ghost sat at centre and
      // never tracked the mouse (Equinox Phase-5 audit: "doesn't follow").
      this._placementFollowing = !this._isTouch;
    }
    if (preview) {
      if (!this._placementGhost || this._placementGhostKind !== preview.kind) {
        if (this._placementGhost) {
          this.shipContainer.removeChild(this._placementGhost);
          this._placementGhost.destroy();
        }
        const radius = getStructureKind(preview.kind).radius;
        const g = buildStructureGfx(preview.kind, radius);
        this.shipContainer.addChild(g);
        this._placementGhost = g;
        this._placementGhostKind = preview.kind;
      }
      // Live ghost: draw at the pointer-chosen world point once positioned,
      // else the ahead-of-ship preview pose. Pending ghost: the SENT point.
      // Dim the pending ghost so it reads as "sent, awaiting" vs positioning.
      this._placementGhost.alpha = pendingGhost ? 0.18 : 0.4;
      const gx = pendingGhost ? preview.x : (this._placementChosenX ?? preview.x);
      const gy = pendingGhost ? preview.y : (this._placementChosenY ?? preview.y);
      this._placementGhost.visible = true;
      this._placementGhost.x = gx;
      this._placementGhost.y = -gy; // Y-flip
      this._placementGhost.rotation = -preview.angle;
      const screen = this.camera.toScreen(gx, -gy);
      this.feedback.placementScreenX = screen.x;
      this.feedback.placementScreenY = screen.y;
      this.feedback.placementChosenWorldX = gx;
      this.feedback.placementChosenWorldY = gy;
      this.feedback.placementStuck = !this._placementFollowing;
    } else {
      if (this._placementGhost) this._placementGhost.visible = false;
      this.feedback.placementScreenX = null;
      this.feedback.placementScreenY = null;
      this.feedback.placementChosenWorldX = null;
      this.feedback.placementChosenWorldY = null;
      this.feedback.placementStuck = false;
      // Reset for the next placement (start in follow mode, no chosen point).
      this._placementFollowing = true;
      this._placementChosenX = null;
      this._placementChosenY = null;
    }

    // Background layers — run AFTER moveCenter so they use this frame's
    // camera position (otherwise stars and grid lag by one frame).
    // Speed effects follow the pilot's own ship: full speed is its top speed
    // (the default kind's when spectating). Catalogue lookups are cached.
    const speedShip = mirror.localPlayerId ? mirror.ships.get(mirror.localPlayerId) : undefined;
    // Phase 4 travel state: in the empty middle of a trip the sky thins to deep
    // space (it fills back in as the ship flies into the new sector).
    this._backdrop?.setDeepSpace(mirror.travelDeep === true);
    this._backdrop?.setTravelHold(mirror.travelling === true);
    if (mirror.prewarmSector !== undefined) this._backdrop?.prewarm(mirror.prewarmSector);
    // Placing the ship on its approach into a new sector jumps the camera; the
    // sky is shifted back by the same amount so the stars carry on unbroken.
    // (Game space y up; Pixi y down.)
    const skyCam = this._skyCam;
    skyCam.center.x = this.camera.center.x - (mirror.travelJumpX ?? 0);
    skyCam.center.y = this.camera.center.y + (mirror.travelJumpY ?? 0);
    skyCam.scale.x = this.camera.scale.x;
    skyCam.screenWidth = this.camera.screenWidth;
    skyCam.screenHeight = this.camera.screenHeight;
    const backdropOn = this._backdrop?.update(skyCam, performance.now(), speedFxFullSpeed(speedShip?.kind)) ?? false;
    // Speed effects (C3): the backdrop's eased speed asks the camera to zoom
    // out a little; applied on the camera's next tick (none while it's baking).
    this.camera.setSpeedZoom(backdropOn ? this._backdrop!.speedZoom() : 1);
    if (backdropOn) this.starfield?.setHidden(true);
    else this.starfield?.update(this.camera);
    this.backgroundGrid?.update(this.camera);

    // Drain pending damage numbers and spawn floating text. update()
    // must be OUTSIDE the spawn-drain block — sub-managers need to
    // tick every frame to advance lifetime + counter-scale.
    if (!this._dmgNumbersDisabled && this.damageNumbers && mirror.pendingDamageNumbers) {
      for (const dn of mirror.pendingDamageNumbers) {
        if (this._selfDmgNumbersDisabled && dn.targetId === mirror.localPlayerId) continue;
        this.damageNumbers.spawn(dn.targetId, dn.x, dn.y, dn.damage, dn.tag);
      }
      mirror.pendingDamageNumbers.length = 0;
    } else if (this._dmgNumbersDisabled && mirror.pendingDamageNumbers) {
      // Drain even when disabled — don't let the queue grow unbounded.
      mirror.pendingDamageNumbers.length = 0;
    }
    // Effects subsystem (M7 — plan wiggly-puppy): drain the effect-
    // trigger queue and dispatch to spawnBurst / triggerOneShotFilter.
    // The queue's length-reset is owned by `perFrameTriggers.consumeOne-
    // FrameTriggers` on render frames only (worker every-other-RAF
    // skip-frames must NOT silently drain — same discipline as
    // explodingShips). DO NOT add `.length = 0` here.
    if (this.effects && mirror.pendingEffectTriggers) {
      for (const ev of mirror.pendingEffectTriggers) {
        if (ev.kind === 'wall-hit') {
          // A fence stopped a shot: a ripple on the wall (new look), else
          // shield-tinted sparks (today's look).
          if (!this._fxFences?.hitAt(ev.worldX, ev.worldY, performance.now())) {
            this.effects.spawnBurst('impact', ev.worldX, ev.worldY, { tint: 0x88ddff });
          }
        } else if (ev.kind === 'shield-contact') {
          // A collision touched a shield: the same flash as a shot's hit,
          // facing the other body (drawn only if the shield is up).
          if (ev.entityId) {
            this.effects.pulseShield(ev.entityId);
            if (this._fxShieldsOn) this._fxShields!.hitAt(ev.entityId, ev.worldX, ev.worldY, performance.now(), this._fxShieldPose);
          }
        } else if (ev.kind === 'destruction-shock' || ev.kind === 'shield-flash') {
          this.effects.triggerOneShotFilter(ev.kind, ev.worldX, ev.worldY);
        } else {
          this.effects.spawnBurst(ev.kind, ev.worldX, ev.worldY, {
            ...(ev.intensity !== undefined ? { intensity: ev.intensity } : {}),
            ...(ev.tint !== undefined ? { tint: ev.tint } : {}),
          });
          // Shield-hit impacts also pulse the target's shield ring.
          if (ev.kind === 'impact' && ev.tint === 0x88ddff && ev.entityId) {
            this.effects.pulseShield(ev.entityId);
            if (this._fxShieldsOn) this._fxShields!.hitAt(ev.entityId, ev.worldX, ev.worldY, performance.now(), this._fxShieldPose);
          }
        }
      }
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
    if (!this._dmgNumbersDisabled) this.damageNumbers?.update();

    // Phase 4 WS-B1 — drain the level-up icon queue and pop a pooled
    // screenspace icon over the named ship's CURRENT pose. The queue's
    // length-reset is owned by `consumeOneFrameTriggers` on render frames only
    // (same skip-frame discipline as explodingShips / pendingEffectTriggers).
    // DO NOT add `.length = 0` here.
    if (this.levelUpIcons && mirror.pendingLevelUps) {
      for (const ev of mirror.pendingLevelUps) {
        const ship = mirror.ships.get(ev.playerId);
        if (!ship) continue;
        this.levelUpIcons.spawn(ship.x, ship.y, ev.newLevel);
      }
    }
    this.levelUpIcons?.update();

    if (!this._healthBarsDisabled && this.healthBars && mirror.pendingHealthBarHits) {
      for (const hb of mirror.pendingHealthBarHits) {
        this.healthBars.onHit(hb.entityId, hb.healthPct, hb.shieldPct, hb.preHealthPct);
      }
      mirror.pendingHealthBarHits.length = 0;
    } else if (this._healthBarsDisabled && mirror.pendingHealthBarHits) {
      mirror.pendingHealthBarHits.length = 0;
    }
    if (!this._healthBarsDisabled) this.healthBars?.update(mirror);
    this.aimFeedback?.update(mirror, this.camera.scale.x);

    // Click-to-inspect selection bracket (Item B4). The renderer owns
    // `_selectedId`; the bracket resolves its live pose from the mirror each
    // frame (single pooled Graphics + dirty flag). If the selected entity has
    // vanished from the mirror (despawned / left interest), the bracket reports
    // it and we clear the selection so the panel + stats channel tear down.
    if (this._selectedId !== null) {
      const stillPresent = this.selectionBracket?.update(mirror, this._selectedId) ?? false;
      if (!stillPresent) {
        this._selectedId = null;
        this._selectedKind = null;
      }
    } else {
      this.selectionBracket?.update(mirror, null);
    }
    // Publish the current selection for the main thread → Zustand bridge.
    this.feedback.selectedPickId = this._selectedId;
    this.feedback.selectedPickKind = this._selectedKind;

    // WS-10 (R2.4) — hover outline. Suppress it on the already-SELECTED entity so
    // the two brackets never stack on the same target. If the hovered entity
    // vanished from the mirror, clear `_hoveredId`. Renderer-local id published
    // for the E2E bridge (data-hover-pick-id) — NEVER Zustand (#2).
    const hoverTarget = this._hoveredId === this._selectedId ? null : this._hoveredId;
    if (hoverTarget !== null) {
      const stillHovered = this.hoverBracket?.update(mirror, hoverTarget) ?? false;
      if (!stillHovered) this._hoveredId = null;
    } else {
      this.hoverBracket?.update(mirror, null);
    }
    this.feedback.hoveredPickId = this._hoveredId;
    // WS-9 (R2.30) — project the bracket's above-entity point to SCREEN so the
    // stats box floats over the entity (any kind). Alloc-free toScreenInto (#14).
    const selWX = this.selectionBracket?.lastWorldX ?? null;
    const selWY = this.selectionBracket?.lastWorldY ?? null;
    if (selWX !== null && selWY !== null) {
      this.camera.toScreenInto(selWX, selWY, this._selScreenScratch);
      this.feedback.selectionScreenX = this._selScreenScratch.x;
      this.feedback.selectionScreenY = this._selScreenScratch.y;
    } else {
      this.feedback.selectionScreenX = null;
      this.feedback.selectionScreenY = null;
    }

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
    this.drainRemoteWarp(mirror);

    // Phase 1 — name labels above remote ships and drones (skip self).
    this.labels?.update(mirror);

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
    // R2.32 — lingering (parked) hulls also carry weapon-barrel clusters; surface
    // their mount counts (reusing the existing mountCounts feedback field) so the
    // worker-boundary probe can assert the barrels actually render.
    if (mirror.lingeringShips) {
      for (const id of mirror.lingeringShips.keys()) {
        const count = this.mountVisuals.mountCountForShip(id);
        if (count > 0) this.feedback.mountCounts.set(id, count);
      }
    }
    this.feedback.haloArrowCount = this.halo.getDebugVisibleArrowCount();
    this.feedback.damageNumberActiveCount = this.damageNumbers?.getActiveCount() ?? 0;
    // Join-render readiness signal: latch true once we've painted a frame the
    // player can see. Piloting → require the LOCAL player's own ship in the
    // mirror (not just any remote ship). SPECTATING → there is no own ship, so a
    // painted frame of the sector IS the signal (the shipless-spectator join-hang
    // fix — Equinox Phase-5 audit). Decision is pure + unit-locked
    // (`firstFrameLatch.ts`), per the Phase A3 extract-renderer-decisions rule.
    if (shouldLatchFirstFrame(
          this.feedback.firstFrameRendered,
          mirror.localPlayerId,
          mirror.localPlayerId !== null && mirror.ships.has(mirror.localPlayerId),
          this._spectator,
        )) {
      this.feedback.firstFrameRendered = true;
    }
    // Art readiness: nothing on screen still waiting for its Machined art.
    // Pre-bound callback + a field flag, so no per-frame allocation (#14).
    if (this._artCtx.art === null) {
      this.feedback.artReady = true;
    } else {
      this._artPendingSeen = false;
      this._artCtx.handles.forEach(this._noteArtPending);
      this.feedback.artReady = this.feedback.firstFrameRendered && !this._artPendingSeen;
      // The pilot's own ship bakes first (once per handle).
      const own = mirror.localPlayerId ? this._artCtx.handles.get(mirror.localPlayerId) : undefined;
      if (own && own.state === 'pending' && own.key !== this._prioritizedArtKey) {
        this._prioritizedArtKey = own.key;
        this._artCtx.art.prioritize(own);
      }
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
    this.drawWarpFx(mirror);

    // Effects subsystem tick. MUST run AFTER all sprite updates so per-
    // entity effects (shield aura, engine emitters in later milestones)
    // read the one-pose-per-frame state the sprite updaters just wrote
    // (src/client/CLAUDE.md "Drones are PURE snapshot-interpolated"
    // section). dtMs = wall-clock since last tick; effects use it for
    // particle lifetime + budget EMA.
    if (this.effects) {
      // Engine continuous emitters — drive from mirror.boostingShips /
      // thrustingShips Sets (M5 of plan wiggly-puppy). Set diff per frame
      // → setContinuous on transitions only (no-op on identical state).
      this.drawFxEngines(mirror);
      this.syncEngineContinuousEffects(mirror);

      const nowMs = performance.now();
      const dtMs = this.lastEffectsTickNowMs > 0 ? nowMs - this.lastEffectsTickNowMs : 16.67;
      // M9: feed the budget the PREVIOUS frame's rendererUpdateMs
      // (current frame's value isn't set until line ~1062). Single-frame
      // lag is negligible vs the 500 ms budget hysteresis hold.
      this.effects.tick(nowMs, dtMs, this.frameMarkers.rendererUpdateMs);
      this.lastEffectsTickNowMs = nowMs;
      // Drawn-artefact signal for the worker-boundary lingering-aura lock
      // (P3.12 / WS-C3) — read AFTER tick(), which sets each ring's visibility.
      this.feedback.shieldRingVisibleCount = this.effects.shieldRingVisibleCount();
    } else {
      this.feedback.shieldRingVisibleCount = 0;
    }

    this.frameMarkers.rendererUpdateMs = performance.now() - updateStart;
    this._perfRing?.push(this.frameMarkers.rendererUpdateMs);
  }

  /** Track which ships currently have an active engine emitter registered
   *  with EffectsService — lets us detect transitions per frame and only
   *  call setContinuous on actual changes (setContinuous is re-entrant
   *  but the per-key check still wins on alloc-pressure). */
  private readonly _activeThrustIds = new Set<string>();
  private readonly _activeBoostIds = new Set<string>();
  /** Set of entityIds (player playerIds OR drone "swarm-N" ids) currently
   *  carrying an active shield aura. Diff'd against mirror state each
   *  frame; transitions fire setContinuous('shield', active). */
  private readonly _activeShieldIds = new Set<string>();

  /** Diff mirror.thrustingShips / boostingShips against our last frame's
   *  registration set; fire setContinuous(id, kind, true|false) only on
   *  transitions. Mirrors the existing thrust/boost flame ownership in
   *  spriteBuilders — those Graphics flames continue to render (they are
   *  the minimal-tier fallback); EngineEmitter ADDS particle trails. */
  /** The sprite key a shooter id draws under (players and drones as-is,
   *  structures as `swarm-<id>`), or null when it has no sprite. */
  private shooterSpriteKey(id: string): string | null {
    if (this.sprites.has(id)) return id;
    let k = this._ownerSpriteKey.get(id);
    if (k === undefined) {
      if (this._ownerSpriteKey.size > 1024) this._ownerSpriteKey.clear();
      k = `swarm-${id}`;
      this._ownerSpriteKey.set(id, k);
    }
    return this.sprites.has(k) ? k : null;
  }

  // ---- GPU-lit art: lights from the frame's weapons fire and explosions.
  private readonly _blastLights: Array<{ x: number; y: number; r: number; t0: number }> = [];
  private _blastLightNext = 0;

  /** An explosion lights the hulls around it for ~0.9 s (sprite space). */
  private noteBlastLight(x: number, y: number, r: number): void {
    if (!litPass.settings || litPass.settings.pointLights <= 0) return;
    const L = this._blastLights;
    if (L.length < 24) { L.push({ x, y, r, t0: performance.now() }); return; }
    const b = L[this._blastLightNext]!;
    this._blastLightNext = (this._blastLightNext + 1) % L.length;
    b.x = x; b.y = y; b.r = r; b.t0 = performance.now();
  }

  /**
   * GPU-lit art: add this frame's lights to the lighting pass (sprite space):
   * explosions (fading), projectiles in flight (naval shells by calibre),
   * missiles and beams. Muzzle flashes are lit by the guns themselves
   * (MountVisualManager, pinned to the flash sprite). Alloc-free.
   */
  private feedLitScene(mirror: RenderMirror): void {
    const ls = litPass.settings;
    if (!ls || ls.pointLights <= 0) return;
    const sc = litPass.scene, now = performance.now();
    for (const b of this._blastLights) {
      const age = (now - b.t0) / 900;
      if (age < 0 || age >= 1) continue;
      const k = (1 - age) * (1 - age);
      sc.addLight(b.x, b.y, 25, 0xff8a30, 3 * k, b.r * 3 + 90);
    }
    if (mirror.projectiles) for (const p of mirror.projectiles.values()) {
      if (p.beam) continue;
      const w = p.weaponId ?? '';
      const K = w === 'naval_siege' ? 10 : w === 'naval_xxl' ? 7 : w === 'naval_xl' ? 6 : w === 'naval_l' ? 4.5 : w === 'naval_m' ? 3 : w === 'naval_s' ? 2 : 1;
      const color = w.startsWith('naval_') || w === 'autocannon' ? 0xffc070 : 0x9fd8ff;
      const x = p.x, y = -p.y;
      sc.addLight(x, y, 5 * K, color, K > 1 ? 0.36 * K : 0.9, 55 * K);
    }
    if (mirror.missiles) for (const m of mirror.missiles.values()) sc.addLight(m.x, -m.y, 8, 0xffa060, 1.2, 70);
    for (let i = 0; i < this._liveBeamCacheCount; i++) this.beamLights(this._liveBeamCache[i]!);
    for (let i = 0; i < this._remoteBeamCacheCount; i++) this.beamLights(this._remoteBeamCache[i]!);
  }

  /** A beam lights where it hits and along its length. */
  private beamLights(b: BeamView): void {
    const sc = litPass.scene;
    const len = Math.hypot(b.toX - b.fromX, b.toY - b.fromY);
    sc.addLight(b.toX, b.toY, 6, 0xff6a9a, 2.2, 120);
    sc.addLight((b.fromX + b.toX) / 2, (b.fromY + b.toY) / 2, 6, 0xff6a9a, 0.8, len * 0.6 + 30);
  }

  /** Firing reactions for Machined guns (turrets T2): held beams by mount
   *  id, and each bolt / missile the frame it first appears, matched to its
   *  owner's nearest gun tip. Render-only; no wire change. */
  private noteTurretShots(mirror: RenderMirror): void {
    const mv = this.mountVisuals;
    if (mv.machinedGunCount() <= 0) return;
    const gen = ++this._turretShotGen;
    const localId = mirror.localPlayerId;
    if (localId && mirror.liveBeams) for (const mountId of mirror.liveBeams.keys()) mv.noteBeam(localId, mountId);
    if (mirror.remoteLasers) {
      for (const [shooterId, perShooter] of mirror.remoteLasers) {
        const key = this.shooterSpriteKey(shooterId);
        if (key) for (const mountId of perShooter.keys()) mv.noteBeam(key, mountId);
      }
    }
    const now = performance.now();
    if (mirror.projectiles) for (const [id, p] of mirror.projectiles) {
      if (p.beam) continue; // instant beam lines: handled as beams
      if (!this._turretShotSeen.has(id)) {
        const key = this.shooterSpriteKey(p.ownerId);
        if (key) mv.noteShotNear(key, p.x, -p.y, p.weaponId);
      }
      this._turretShotSeen.set(id, gen);
      // Naval shells: remember where each one is, for its impact burst.
      if (p.weaponId !== undefined && p.weaponId.startsWith('naval_')) {
        let rec = this._navalShells.get(id);
        if (rec === undefined) {
          rec = this._navalShellFree.pop() ?? { x: 0, y: 0, r: 0, sx: 0, sy: 0, reach: 0 };
          const w = isWeaponId(p.weaponId) ? getWeapon(p.weaponId) : null;
          rec.r = shellImpactRadius(w && w.mode !== 'hitscan' ? w.radius : 3);
          rec.reach = w && w.mode !== 'hitscan' ? (w.speed * (w.mode === 'projectile' ? w.maxTicks : w.lifetimeTicks)) / 60 : 0;
          rec.sx = p.x; rec.sy = -p.y;
          this._navalShells.set(id, rec);
        }
        rec.x = p.x; rec.y = -p.y;
      }
    }
    for (const [id, g] of this._turretShotSeen) if (g !== gen) this._turretShotSeen.delete(id);
    // A shell gone this frame: burst where it was last seen if it HIT
    // something. A shell that ran out of range just fades (a salvo's outer
    // shells fly past a small target; bursting them in empty space read as
    // explosions in the wrong place, review 2026-11-07).
    for (const [id, rec] of this._navalShells) {
      if (this._turretShotSeen.has(id)) continue;
      if (shellEndedOnHit(Math.hypot(rec.x - rec.sx, rec.y - rec.sy), rec.reach)) this._fxExplosions?.spawn(rec.x, rec.y, rec.r, now);
      this._navalShells.delete(id);
      this._navalShellFree.push(rec);
    }
    if (mirror.missiles) {
      for (const [id, m] of mirror.missiles) {
        if (!this._turretMissileSeen.has(id)) {
          const key = this.shooterSpriteKey(m.ownerId);
          if (key) mv.noteShotNear(key, m.x, -m.y);
        }
        this._turretMissileSeen.set(id, gen);
      }
      for (const [id, g] of this._turretMissileSeen) if (g !== gen) this._turretMissileSeen.delete(id);
    }
  }

  /** New engine exhaust for every ship sprite with Machined art: players
   *  pass their thrust / boost input, drones (`swarm-*`) follow their speed.
   *  Lingering hulls and scrap are skipped. Reads the sprite's resolved pose
   *  (one pose per frame). Ships it draws skip today's particle emitter. */
  /** Warp-to visuals for every visible ship (one resolved sprite pose each). */
  private drawWarpFx(mirror: RenderMirror): void {
    const fx = this._warpFx;
    fx.beginFrame(performance.now(), this.world.scale.x);
    this._spoolFx.beginFrame(performance.now(), this.world.scale.x);
    const local = mirror.localPlayerId;
    const s = this._warpShipScratch;
    for (const [id, ship] of mirror.ships) {
      const sp = this.sprites.get(id);
      // A remote ship on its run is hidden but still tracked (its departure).
      if (!sp || (!sp.visible && ship.warp !== 2)) continue;
      const kind = ship.kind ?? '';
      let stern = this._warpStern.get(kind);
      if (stern === undefined) { stern = engineProfileForKind(ship.kind).sternOffset; this._warpStern.set(kind, stern); }
      s.x = sp.x; s.y = sp.y; s.rotation = sp.rotation; s.warp = ship.warp; s.stern = stern; s.isLocal = id === local;
      fx.draw(id, s);
      this.drawSpoolFx(id, ship.warp, ship.kind, sp, id === local ? mirror.localSpoolMs : undefined);
    }
    // W2a — NPCs warping (flagship fleets). Fed while their phase is set and
    // one frame after it clears, so a cancelled spool settles to idle instead
    // of WarpFx reading the disappearance as a departure.
    const fed = this._droneWarpFed;
    if (mirror.swarm) for (const [eid, e] of mirror.swarm) {
      if (e.kind !== 1) continue;
      const key = this.droneWarpKey(eid);
      if (e.warp === undefined && !fed.has(key)) continue;
      const sp = this.sprites.get(key);
      if (!sp) continue;
      const kindId = e.shipKind ?? '';
      let stern = this._warpStern.get(kindId);
      if (stern === undefined) { stern = engineProfileForKind(e.shipKind).sternOffset; this._warpStern.set(kindId, stern); }
      s.x = sp.x; s.y = sp.y; s.rotation = sp.rotation; s.warp = e.warp; s.stern = stern; s.isLocal = false;
      fx.draw(key, s);
      this.drawSpoolFx(key, e.warp, e.shipKind, sp, undefined);
      if (e.warp === undefined) fed.delete(key); else fed.add(key);
    }
    fx.endFrame();
    this._spoolFx.endFrame();
  }

  /** One ship's spool-up (progress-driven, sized from its own nozzles). */
  private drawSpoolFx(id: string, warp: number | undefined, kind: string | undefined, sp: Container, spoolMs: number | undefined): void {
    const now = performance.now();
    const phase = warp === 1 ? 1 : 0;
    if (phase !== (this._spoolPhase.get(id) ?? 0)) {
      if (phase === 1) { this._spoolPhase.set(id, 1); this._spoolStart.set(id, now); }
      else { this._spoolPhase.delete(id); this._spoolStart.delete(id); }
    }
    const kindId = kind ?? 'fighter';
    let k = this._spoolKind.get(kindId);
    if (!k) {
      // Classic-look ships have no baked nozzles: one at the stern.
      const stern = engineProfileForKind(kindId).sternOffset;
      k = { half: stern, nozzles: [{ x: 0, y: stern, r: Math.max(2, stern * 0.25) }] };
      this._spoolKind.set(kindId, k);
    }
    const s = this._spoolShip;
    s.x = sp.x; s.y = sp.y; s.rotation = sp.rotation;
    const dur = spoolMs ?? (WARP_SPOOL_TICKS / 60) * 1000;
    s.progress = phase === 1 ? Math.min(1, (now - (this._spoolStart.get(id) ?? now)) / dur) : -1;
    const art = this._artCtx.handles.get(id)?.ship;
    s.nozzles = art && art.nozzles.length > 0 ? art.nozzles : k.nozzles;
    s.half = k.half;
    this._spoolFx.draw(id, s);
  }

  private drawFxEngines(mirror: RenderMirror): void {
    const fx = this._fxEngines;
    if (!fx) return;
    const now = performance.now();
    const dt = this._fxEnginesLastMs > 0 ? Math.min(0.1, (now - this._fxEnginesLastMs) / 1000) : 1 / 60;
    this._fxEnginesLastMs = now;
    fx.beginFrame();
    for (const [key, sp] of this.sprites) {
      if (!sp.visible) continue;
      const h = this._artCtx.handles.get(key);
      if (!h || h.job.type !== 'ship' || !h.ship) continue;
      let thrust: -1 | 0 | 1, boost: -1 | 0 | 1;
      if (mirror.ships.has(key)) {
        thrust = mirror.thrustingShips?.has(key) ? 1 : 0;
        boost = mirror.boostingShips?.has(key) ? 1 : 0;
      } else if (key.startsWith('swarm-')) {
        thrust = -1; boost = -1;
      } else continue;
      let top = this._fxTopSpeed.get(h.job.id), trail = this._fxTrailS.get(h.job.id);
      if (top === undefined || trail === undefined) {
        const k = getShipKind(h.job.id);
        top = k.maxSpeed; trail = shipTuning(k).exhaustTrailS;
        this._fxTopSpeed.set(h.job.id, top); this._fxTrailS.set(h.job.id, trail);
      }
      fx.draw(key, h.ship.nozzles, sp.x, sp.y, sp.rotation, thrust, boost, top, dt, now, trail);
      // GPU-lit art: each engine is a light in its plume (its own hull takes little).
      const ls = litPass.settings;
      if (ls && ls.engineLights && ls.pointLights > 0) {
        const owner = sp instanceof MachinedShipSprite && sp.lit.length > 0 ? sp.lit[0]!.lightOwnerId : -1;
        const th = fx.thrustOf(key), c = Math.cos(sp.rotation), s = Math.sin(sp.rotation);
        for (const nz of h.ship.nozzles) {
          const ly = nz.y + engineLightAstern(nz.r);
          litPass.scene.addLight(sp.x + nz.x * c - ly * s, sp.y + nz.x * s + ly * c, engineLightHeight(nz.r), 0xffa24a, engineLightIntensity(nz.r, th), engineLightReach(nz.r), owner);
        }
      }
    }
    fx.endFrame();
  }

  private syncEngineContinuousEffects(mirror: RenderMirror): void {
    if (!this.effects) return;
    const thrust = mirror.thrustingShips;
    const boost = mirror.boostingShips;
    // Ships drawn by the new exhaust don't also get today's particles.
    const fxe = this._fxEngines;

    if (thrust) {
      for (const id of thrust) {
        if (!this._activeThrustIds.has(id) && !fxe?.drew(id)) {
          // Per-kind nozzle offset + plume scale, computed once at
          // registration (not per frame) from the ship catalogue.
          this.effects.setContinuous(id, 'thrust', true, undefined, engineProfileForKind(mirror.ships.get(id)?.kind));
          this._activeThrustIds.add(id);
        }
      }
      for (const id of this._activeThrustIds) {
        if (!thrust.has(id) || fxe?.drew(id)) {
          this.effects.setContinuous(id, 'thrust', false);
          this._activeThrustIds.delete(id);
        }
      }
    } else if (this._activeThrustIds.size > 0) {
      for (const id of this._activeThrustIds) this.effects.setContinuous(id, 'thrust', false);
      this._activeThrustIds.clear();
    }

    if (boost) {
      for (const id of boost) {
        if (!this._activeBoostIds.has(id) && !fxe?.drew(id)) {
          this.effects.setContinuous(id, 'boost', true, undefined, engineProfileForKind(mirror.ships.get(id)?.kind));
          this._activeBoostIds.add(id);
        }
      }
      for (const id of this._activeBoostIds) {
        if (!boost.has(id) || fxe?.drew(id)) {
          this.effects.setContinuous(id, 'boost', false);
          this._activeBoostIds.delete(id);
        }
      }
    } else if (this._activeBoostIds.size > 0) {
      for (const id of this._activeBoostIds) this.effects.setContinuous(id, 'boost', false);
      this._activeBoostIds.clear();
    }

    // Shield aura — M8 (plan wiggly-puppy). Drive from mirror.ships's
    // shieldDown field (populated by handleShield + handleDamage) AND
    // mirror.swarm's shieldDown (decoded from the binary wire's
    // SWARM_RECORD_FLAG_SHIELD_DOWN bit). Note inversion: aura is ON
    // when shield is UP (shieldDown=false / undefined). Drones use
    // "swarm-<entityId>" id prefix to namespace with the player ids.
    this.syncShieldAuraEffects(mirror);
  }

  private syncShieldAuraEffects(mirror: RenderMirror): void {
    if (!this.effects) return;
    const seen = this._updateSeenScratch; // already cleared at top of update()
    seen.clear();

    // Aura is ON unless shieldDown is EXPLICITLY true. Default assumption
    // is "shield up" — every fresh-spawn ship has full shield (the server
    // initialises `ship.shield = kind.shieldMax` on spawn), and the
    // client only learns `shieldDown=true` via the explicit SHIELD_BROKEN
    // event. Pre-fix the aura was gated on `shieldDown === false`
    // (explicit), so an unscathed just-spawned ship rendered no aura —
    // user perception: "I spawn in without a shield up."
    for (const [id, ship] of mirror.ships) {
      if (ship.shieldDown !== true) seen.add(id);
    }
    if (mirror.swarm) {
      for (const [id, sw] of mirror.swarm) {
        if (sw.shieldDown !== true && sw.kind === 1) seen.add(`swarm-${id}`);
      }
    }
    // R2.32 — lingering (parked) hulls render their shield aura too. They are
    // shipInstanceId-keyed (no `swarm-` prefix) and kept OUT of mirror.ships, so
    // the radius lookup below also falls back to mirror.lingeringShips.
    if (mirror.lingeringShips) {
      for (const [id, ship] of mirror.lingeringShips) {
        if (ship.shieldDown !== true) seen.add(id);
      }
    }

    for (const id of seen) {
      if (!this._activeShieldIds.has(id)) {
        // Look up the entity's actual hull radius so the visible aura
        // matches the physics ball collider (both use the same
        // `kind.radius + SHIELD_RADIUS_PAD` formula on the server).
        // Without this, ShieldAura would fall back to its 28 u default
        // for every ship — scout's tiny shield would render the same
        // size as a heavy's, and neither would match the physics.
        let auraRadius: number | undefined;
        if (id.startsWith('swarm-')) {
          const swarmId = parseInt(id.slice('swarm-'.length), 10);
          const sw = mirror.swarm?.get(swarmId);
          if (sw) auraRadius = sw.shipKind ? shieldVisualRadius(getShipKind(sw.shipKind)) : sw.radius;
        } else {
          // mirror.ships for an active hull; mirror.lingeringShips for a parked
          // one (lingering hulls are shipInstanceId-keyed + kept out of ships).
          const ship = mirror.ships.get(id) ?? mirror.lingeringShips?.get(id);
          if (ship?.kind) auraRadius = shieldVisualRadius(getShipKind(ship.kind));
        }
        this.effects.setContinuous(id, 'shield', true, auraRadius);
        this._activeShieldIds.add(id);
        this._fxShieldRadius.set(id, (auraRadius ?? 28) + SHIELD_RADIUS_PAD);
      }
    }
    for (const id of this._activeShieldIds) {
      if (!seen.has(id)) {
        this.effects.setContinuous(id, 'shield', false);
        this._activeShieldIds.delete(id);
        this._fxShieldRadius.delete(id);
      }
    }
    // New shields (B5): every shield up this frame, then lay them out (a
    // shield missing this frame went down and plays its break).
    this.effects.setShieldAuraHidden(this._fxShieldsOn);
    if (this._fxShieldsOn) {
      for (const id of this._activeShieldIds) this._fxShields!.shield(id, this._fxShieldRadius.get(id) ?? 38);
      this._fxShields!.end(performance.now(), this._fxShieldPose);
    }
  }

  /** Wall-clock of the last `effects.tick` call. Used to derive dt for the
   *  next call. 0 ⇒ first frame (use a default 16.67 ms to seed). */
  private lastEffectsTickNowMs = 0;

  /** Phase 6b — lingering hulls (players who disconnected within the
   *  15-min linger window OR whose ships have been displaced from
   *  `playerToSlot` by a fresh spawn) are drawn with the SAME silhouette
   *  + colour as the live ship (they still belong to a real player), with
   *  a slight alpha drop (0.75) as a visual cue for "this hull is parked,
   *  the pilot isn't currently flying it".
   *
   *  Phase A3: the create-vs-rebuild-vs-reposition decision is delegated
   *  to `decideLingeringSpriteAction` (pure, unit-tested). The previous
   *  inline version's `if (!ship.kind) continue` skip left lingering
   *  hulls permanently invisible when the schema diff was late; the
   *  extracted helper makes the fallback-kind behaviour an explicit
   *  contract and prevents regression. */
  /** Lingering hull sprites. Per-entry `stamp` field implements the
   *  generation-counter pattern (R5 in the paradigm doc) — bump
   *  `_lingeringFrameId` at the top of `updateLingeringShips`, stamp
   *  every touched entry, sweep entries whose stamp lags. Replaces the
   *  per-frame `new Set<string>()` the audit identified at this site. */
  private readonly lingeringSprites = new Map<string, { sprite: Container; kind: string; stamp: number }>();
  private _lingeringFrameId = 0;
  private updateLingeringShips(mirror: RenderMirror): void {
    if (!mirror.lingeringShips || mirror.lingeringShips.size === 0) {
      if (this.lingeringSprites.size > 0) {
        for (const [id, entry] of this.lingeringSprites) {
          this.mountVisuals.removeShip(id); // R2.32 — free the weapon-barrel cluster
          entry.sprite.destroy();
        }
        this.lingeringSprites.clear();
      }
      return;
    }
    // Generation-counter sweep (invariant #14, R5). Pre-Phase-4 this
    // path allocated `new Set<string>()` per RAF (60-100 fps depending
    // on device); the stamp field on each entry now carries the same
    // signal with zero allocation.
    const frameId = ++this._lingeringFrameId;
    for (const [shipInstanceId, ship] of mirror.lingeringShips) {
      const decision = decideLingeringSpriteAction({
        cached: this.lingeringSprites.get(shipInstanceId),
        currentKind: ship.kind,
        fallbackKind: 'fighter',
      });
      let entry = this.lingeringSprites.get(shipInstanceId);
      // Machined art: a parked hull swaps to its Machined sprite once ready.
      const artKey = `linger-${shipInstanceId}`; // TODO: alloc-debt (one key string per lingering hull per frame)
      const kind = 'kind' in decision ? decision.kind : (entry?.kind ?? 'fighter');
      const lingerHandle = shipHandleFor(this._artCtx, artKey, kind, undefined);
      let action: SpriteDecision['action'] = decision.action;
      if (entry && action === 'reposition' && shipArtSwap(this._artCtx, entry.sprite, lingerHandle) !== 'keep') action = 'rebuild';
      if (action === 'rebuild') {
        this.mountVisuals.removeShip(shipInstanceId); // drop the old cluster before its sprite dies
        entry!.sprite.destroy();
        this.lingeringSprites.delete(shipInstanceId);
        entry = undefined;
      }
      if (action === 'create' || action === 'rebuild') {
        const shape = shapeForKind(kind);
        const sprite = buildArtShipSprite(lingerHandle, () => buildShipGfxFromShape(shape, shipPrimaryColor(getShipKind(kind))));
        sprite.alpha = 0.75;
        this.shipContainer.addChild(sprite);
        // R2.32 — give the parked hull its weapon barrels. Parented to the
        // sprite so they inherit its pose; frozen at baseAngle (no
        // applyMountAngles call — an abandoned hull isn't aiming).
        this.mountVisuals.ensureForShip(shipInstanceId, kind, sprite);
        entry = { sprite, kind, stamp: frameId };
        this.lingeringSprites.set(shipInstanceId, entry);
      }
      // 'skip' is not produced by the lingering decision today. Be
      // defensive anyway.
      if (action === 'skip' || !entry) continue;
      entry.stamp = frameId;
      entry.sprite.x = ship.x;
      entry.sprite.y = -ship.y;
      entry.sprite.rotation = -ship.angle;
      updateArtShipLight(this._artCtx, entry.sprite);
    }
    for (const [id, entry] of this.lingeringSprites) {
      if (entry.stamp !== frameId) {
        this.mountVisuals.removeShip(id); // R2.32 — free the weapon-barrel cluster
        entry.sprite.destroy();
        this.lingeringSprites.delete(id);
        this._artCtx.handles.delete(`linger-${id}`);
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

  /** The baked glow texture for impact sparks (null until baked). */
  private fxGlowTexture(): () => Texture | null {
    const h = this._artCtx.art!.fx('glow', undefined, undefined, false);
    return () => (h.state === 'ready' && h.fx ? h.fx.tex : null);
  }

  /** New shields + fences (`?fx=new`, B5). */
  private _fxShields: FxShields | null = null;
  private _fxFences: FxFences | null = null;
  private _fxShieldsOn = false;
  /** Shield radius per shielded entity (hull radius + pad), set when it comes up. */
  private readonly _fxShieldRadius = new Map<string, number>();
  /** Pixi-space pose of an entity's sprite, for the new shields. */
  private readonly _fxShieldPose = (id: string, out: { x: number; y: number }): boolean => {
    const sp = this.sprites.get(id) ?? this.lingeringSprites.get(id)?.sprite;
    if (!sp) return false;
    out.x = sp.x; out.y = sp.y;
    return true;
  };

  /** New explosions + missile smoke (`?fx=new`, B4). */
  private _fxExplosions: FxExplosions | null = null;
  private _fxMissileTrails: FxMissileTrails | null = null;
  private _fxEngines: FxEngines | null = null;
  /** Firing reactions (turrets T2): projectile / missile ids seen, stamped
   *  with the frame's generation so a new one is noticed once, and a cache of
   *  owner id → sprite key (structures fire as their bare entity id). */
  private readonly _turretShotSeen = new Map<string, number>();
  /** Live naval shells (last Pixi-space position + impact radius), pooled. */
  private readonly _navalShells = new Map<string, NavalShellRec>();
  private readonly _navalShellFree: NavalShellRec[] = [];
  private readonly _turretMissileSeen = new Map<number, number>();
  private _turretShotGen = 0;
  private readonly _ownerSpriteKey = new Map<string, string>();
  private _fxEnginesLastMs = 0;
  private readonly _warpFx = new WarpFx();
  private readonly _spoolFx = new WarpSpoolFx();
  private readonly _spoolShip: SpoolFxShip = { x: 0, y: 0, rotation: 0, progress: -1, nozzles: [], half: 0 };
  /** Per ship: when its spool started (ms) and its last warp phase. */
  private readonly _spoolStart = new Map<string, number>();
  private readonly _spoolPhase = new Map<string, number>();
  /** Per kind: hull half length and a stern nozzle for classic-look ships. */
  private readonly _spoolKind = new Map<string, { half: number; nozzles: Nozzle[] }>();
  /** Phase 4 travel state: the camera the sky is drawn from (shifted by the
   *  trip's approach jump). */
  private readonly _skyCam = { center: { x: 0, y: 0 }, scale: { x: 1 }, screenWidth: 0, screenHeight: 0 };

  private readonly _warpShipScratch: WarpFxShip = { x: 0, y: 0, rotation: 0, warp: undefined, stern: 0, isLocal: false };
  private readonly _warpStern = new Map<string, number>();
  /** W2a — drones fed to WarpFx last frame (their sprite keys). */
  private readonly _droneWarpFed = new Set<string>();
  /** W2a — `swarm-<id>` keys, built once per drone (no per-frame string). */
  private readonly _droneWarpKeys = new Map<number, string>();
  private droneWarpKey(eid: number): string {
    let k = this._droneWarpKeys.get(eid);
    if (k === undefined) {
      k = `swarm-${eid}`;
      if (this._droneWarpKeys.size > 4096) this._droneWarpKeys.clear(); // bound it; rebuilt on demand
      this._droneWarpKeys.set(eid, k);
    }
    return k;
  }
  /** Scratch for the test-only particle count in `artStats`. */
  private readonly _engineDbgScratch: number[] = [];
  /** Top speed per ship kind (normalises a drone's engine level). */
  private readonly _fxTopSpeed = new Map<string, number>();
  /** Per kind: seconds of path the engine ribbon spans (`shipTuning`). */
  private readonly _fxTrailS = new Map<string, number>();

  /** New weapon effects (`?fx=new`, B3). */
  private _fxLiveBeams: FxBeams | null = null;
  private _fxRemoteBeams: FxBeams | null = null;
  private _fxProjectiles: FxProjectiles | null = null;
  /** Per remote beam this frame: did it land on something (FxBeams' flare). */
  private readonly _fxRemoteHit: boolean[] = [];

  /** New backdrop (`?fx=new`), and the sector it shows. */
  private _backdrop: Backdrop | null = null;
  private _sectorKey: string | null = null;

  /** DEV/E2E: what the backdrop is showing. */
  backdropStats(): { classicStars: boolean; motes: { near: number; fore: number } | null; deep: number; on: boolean; nebula: string | null; landmarks: number; sky: string; density: number; speed: number; speedZoom: number; speedLevel: string } {
    const b = this._backdrop;
    return { classicStars: this.starfield?.isVisible() === true, motes: b?.moteCounts() ?? null, deep: b?.deepSpace() ?? 0, on: b?.sky.visible === true, nebula: b?.nebulaKey() ?? null, landmarks: b?.visibleLandmarks ?? 0, sky: b?.skySignature ?? '', density: b?.density ?? 0,
      speed: b?.speed.sf ?? 0, speedZoom: this.camera.speedZoom(), speedLevel: b?.speedLevel ?? 'off' };
  }

  setSpectator(active: boolean): void {
    this._spectator = active;
    // The radar is camera-relative while spectating. Pushed here (not read
    // from the store) so it works on the worker path too.
    this.halo.setSpectator(active);
    if (!this.initialized) return;
    if (active) this.camera.follow(null);
  }

  /** See `IRenderer.setRadarPrefs`. */
  setRadarPrefs(prefs: RadarPrefs): void {
    this.halo.setPrefs(prefs);
  }

  /** See `IRenderer.setRadarInsets`. */
  setRadarInsets(insets: RadarInsets): void {
    this.halo.setInsets(insets);
  }

  /** See `IRenderer.setRadarSuppressed`. */
  setRadarSuppressed(suppressed: boolean): void {
    this.halo.setSuppressed(suppressed);
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

  /**
   * Cinematic camera — play a cue script, or `null` to stop and hand the camera
   * back to gameplay. See `IRenderer.setCameraScript`. The halo ring re-anchors
   * on the camera centre while a script plays (the subject may not be the ship).
   */
  setCameraScript(cues: readonly CameraCue[] | null): void {
    if (cues === null || cues.length === 0) {
      this._director.stop();
      if (this.initialized) this.camera.clearDirector();
      this.halo.setCameraRelative(false);
      return;
    }
    this._director.play(cues, performance.now());
    this.halo.setCameraRelative(true);
  }

  /** Test/automation — true while a cinematic script owns the camera. */
  isCameraScripted(): boolean {
    return this._director.isActive();
  }

  /** Lookup over the sprite map for the director (pixi space). Built once. */
  private createDirectorLookup(): CameraTargetLookup {
    // Group-bounds accumulator state, shared by a single bound callback so the
    // per-frame Map.forEach scan allocates nothing (invariant #14).
    let group: CameraGroup = 'all';
    let count = 0;
    let acc: MutableBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    // A framed entity contributes its whole extent (radius `r`), not just its
    // centre: a 10x capital reaches kilometres past its centre (round 3).
    const add = (x: number, y: number, r = 0): void => {
      if (count === 0) {
        acc.minX = x - r; acc.maxX = x + r;
        acc.minY = y - r; acc.maxY = y + r;
      } else {
        if (x - r < acc.minX) acc.minX = x - r;
        if (x + r > acc.maxX) acc.maxX = x + r;
        if (y - r < acc.minY) acc.minY = y - r;
        if (y + r > acc.maxY) acc.maxY = y + r;
      }
      count++;
    };
    // Half the sprite's longer side: covers any rotation. Cinematic-only path.
    const extentOf = (sprite: Container): number => Math.max(sprite.width, sprite.height) / 2;
    const visit = (sprite: Container, key: string): void => {
      if (!sprite.visible) return;
      if (group !== 'all') {
        const isSwarm = key.startsWith('swarm-');
        if (group === 'ships') {
          if (isSwarm) return;
        } else {
          if (!isSwarm) return;
          const k = this._swarmSpriteKinds.get(key);
          const want = group === 'asteroids' ? 0 : group === 'drones' ? 1 : group === 'structures' ? 2 : 3;
          if (k !== want) return;
        }
      }
      add(sprite.x, sprite.y, extentOf(sprite));
    };
    return {
      pose: (id: string, out: MutablePoint): boolean => {
        const key = id === 'local' ? this._lastMirror?.localPlayerId ?? null : id;
        if (key === null) return false;
        const sp = this.sprites.get(key);
        if (!sp || !sp.visible) return false;
        out.x = sp.x;
        out.y = sp.y;
        return true;
      },
      groupBounds: (g: CameraGroup, out: MutableBounds): number => {
        group = g;
        count = 0;
        acc = out;
        this.sprites.forEach(visit);
        return count;
      },
      idsBounds: (ids: readonly string[], out: MutableBounds): number => {
        count = 0;
        acc = out;
        const localId = this._lastMirror?.localPlayerId ?? null;
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i]!;
          const sp = this.sprites.get(id === 'local' && localId !== null ? localId : id);
          if (sp && sp.visible) add(sp.x, sp.y, extentOf(sp));
        }
        return count;
      },
      viewport: (out: MutablePoint): void => {
        out.x = this.camera ? this.camera.screenWidth : 0;
        out.y = this.camera ? this.camera.screenHeight : 0;
      },
    };
  }

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

  /**
   * Effects subsystem (plan `wiggly-puppy` M9). Wipe per-entity continuous
   * emitters + in-flight bursts + shield rings. Called from
   * `ColyseusClient.resetPredictionState()`'s sibling-line in the
   * `transit_ready` handler. The diff trackers are cleared too so the
   * destination sector's first frame re-registers emitters against the
   * fresh mirror state.
   */
  resetEffectsForSectorHandoff(): void {
    this.effects?.resetForSectorHandoff();
    this._fxExplosions?.reset();
    this._fxShields?.reset();
    this._fxFences?.reset();
    this._activeThrustIds.clear();
    this._activeBoostIds.clear();
    this._activeShieldIds.clear();
  }

  /** Machined art status: the service's counts plus how many ship sprites
   *  are drawing Machined vs today's look right now. */
  artStats(): { mode: 'classic' | 'machined'; machinedSprites: number; classicShipSprites: number; backdrop: ReturnType<PixiRenderer['backdropStats']>; fxProjectiles: number; fxBeam: boolean; fxExplosions: number; fxShields: number; fxFences: number; fxFenceHits: number; fxFenceContacts: number; fxEngines: number; engineParticles: number; turrets: number; turretShots: number; lodDots: number; effectQuality: string; fxRibbons: number; localEngine: ReturnType<FxEngines['debugView']>; warpBursts: number; warpSpooling: number; spoolFxDrawn: number; ownArt: string | null } & Partial<ReturnType<NonNullable<ShipArtCtx['art']>['stats']>> {
    let machined = 0, classic = 0;
    for (const [id, sp] of this.sprites) {
      if (isMachinedSprite(sp)) machined++;
      else if (!id.startsWith('swarm-') || this._artCtx.handles.has(id)) classic++;
    }
    for (const e of this.lingeringSprites.values()) {
      if (isMachinedSprite(e.sprite)) machined++; else classic++;
    }
    const art = this._artCtx.art;
    return { mode: art ? 'machined' : 'classic', machinedSprites: machined, classicShipSprites: classic, backdrop: this.backdropStats(), fxProjectiles: this._fxProjectiles?.liveCount() ?? 0, fxBeam: this._fxLiveBeams?.container.visible === true, fxExplosions: this._fxExplosions?.activeCount() ?? 0, fxShields: this._fxShieldsOn ? this._fxShields!.count() : -1, fxFences: this._fxFences?.count() ?? 0, fxFenceHits: this._fxFences?.hitCount ?? 0, fxFenceContacts: this._fxFences?.contactCount() ?? 0, fxEngines: this._fxEngines?.drawn() ?? -1, engineParticles: this.effects ? this.effects.debugCopyEngineParticleWorld(this._engineDbgScratch) : 0, turrets: this.mountVisuals.machinedGunCount(), turretShots: this.mountVisuals.turretShotCount(), lodDots: this._lodDots.dotCount, effectQuality: this.effects?.getQuality() ?? 'none', fxRibbons: this._fxEngines?.ribbons() ?? -1, warpBursts: this._warpFx.burstCount(), warpSpooling: this._warpFx.spoolCount(), spoolFxDrawn: this._spoolFx.spooling, ownArt: this._lastMirror?.localPlayerId ? (this._artCtx.handles.get(this._lastMirror.localPlayerId)?.state ?? 'none') : null, localEngine: this._lastMirror?.localPlayerId ? (this._fxEngines?.debugView(this._lastMirror.localPlayerId) ?? null) : null, ...(art ? art.stats() : {}) };
  }

  dispose(): void {
    this._artCtx.art?.destroy();
    this._artCtx.art = null;
    this._artCtx.handles.clear();
    if (!this.initialized) return;
    // Flip the flag FIRST so any rAF / ResizeObserver callback that fires
    // between here and the actual destroy() short-circuits cleanly. Without
    // this, the queued requestAnimationFrame(resize) at the end of init()
    // could land post-destroy and read a null renderer.
    this.initialized = false;
    // Tear down the warp filter chain (removes its ticker handler).
    this.warp.destroy();
    // Wipe effects subsystem pools (particles, shock filters, etc.).
    if (this.effects) {
      this.effects.resetForSectorHandoff();
      this.effects = null;
    }
    // Clear the per-effect diff trackers so a re-init starts clean.
    this._activeThrustIds.clear();
    this._activeBoostIds.clear();
    this._activeShieldIds.clear();
    // Remove canvas pointer / wheel / touch listeners so an in-flight
    // event doesn't reach a destroyed Camera.
    const canvas = this.app?.canvas;
    if (canvas) {
      for (const { type, handler, options } of this.canvasListeners) {
        canvas.removeEventListener(type, handler, options);
      }
    }
    this.canvasListeners.length = 0;
    // P3.5 — the window-level placement-drag pointermove (lives on `window`,
    // capture phase — the removal flag MUST match the add or it won't detach).
    if (this._placementWindowMoveHandler) {
      window.removeEventListener('pointermove', this._placementWindowMoveHandler, true);
      this._placementWindowMoveHandler = null;
    }
    const handler = (this.app as unknown as Record<string, unknown>)['_resizeHandler'];
    if (typeof handler === 'function') {
      window.removeEventListener('resize', handler as EventListener);
      window.removeEventListener('orientationchange', handler as EventListener);
      window.visualViewport?.removeEventListener('resize', handler as EventListener);
    }
    const ro = (this.app as unknown as Record<string, unknown>)['_resizeObserver'];
    if (ro instanceof ResizeObserver) ro.disconnect();
    this.damageNumbers?.destroy();
    this.levelUpIcons?.destroy();
    this.healthBars?.destroy();
    this.labels?.destroy();
    this.selectionBracket?.destroy();
    this.hoverBracket?.destroy();
    this.mountVisuals.disposeAll();
    this.halo.destroy();
    this.backgroundGrid?.destroy();
    this.starfield?.destroy();
    // Warp stage + filters live on app.stage so `app.destroy({ children: true })`
    // tears them down. warp.destroy() already removed the ticker handler.
    this.app.destroy(true, { children: true });
  }
}
