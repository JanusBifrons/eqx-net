import { Application, Graphics, Container, RenderLayer, type Texture } from 'pixi.js';
import { Camera } from './worker/Camera';
import { DEFAULT_GRAPHICS_QUALITY, renderResolution, type GraphicsQuality } from './graphicsQuality';
import type { FleetOverlayModel, FleetPickKindWire, IRenderer, RenderMirror, RendererFeedback } from '@core/contracts/IRenderer';
import { GameClock } from '@core/clock/GameClock';
import { GalaxyMapLayer } from './galaxy/GalaxyMapLayer';
import { type FrameMarkers } from './worker/protocol';
import { LoadCurtain } from './pixi/LoadCurtain.js';
import { fillHitTargetSets } from './pixi/hitTargetSets.js';
import { updateShipSprites, shipSpriteKinds, type ShipSpriteCtx } from './pixi/shipSpriteUpdater.js';
import { type EntityPose } from './pixi/entityPoseFromSprite.js';
import { updateSwarmSprites, type SwarmSpriteCtx } from './pixi/swarmSpriteUpdater.js';
import { DyingHullHold, noteDyingHulls } from './pixi/dyingHullHold.js';
import { sweepUnseenSprites } from './pixi/spriteSweep.js';
import { type WreckBlast } from './pixi/wreckArt.js';
import { deathBlastFor, dyingHullDiameter, hullDeathBlastReplaced, type DeathBlast } from './pixi/deathBlast.js';
import { spawnVaporiseBlast, stackVaporiseOverBeams } from './pixi/vaporiseBlast.js';
import { raiseBeamsOverHulls } from './pixi/beamsOverHulls.js';
import { LegacyExplosionSprites } from './pixi/legacyExplosionSprites.js';
import { ConnectorRenderer } from './pixi/ConnectorRenderer.js';
import { updateProjectileSprites, type ProjectileSpriteCtx } from './pixi/projectileSpriteUpdater.js';
import { updateMissileSprites, type MissileSpriteCtx } from './pixi/missileSpriteUpdater.js';
import { createBeamCtx, updateBeams, type BeamCtx } from './pixi/beamUpdater.js';
import { createWarpFxCtx, updateWarpFx, type WarpFxCtx } from './pixi/warpFxUpdater.js';
import { createEngineShieldFxCtx, updateEngineShieldFx, clearEngineShieldFxIds, type EngineShieldFxCtx } from './pixi/engineShieldFxUpdater.js';
import { beginShieldFrame, createHitEventCtx, updateHitEvents, type HitEventCtx } from './pixi/hitEventUpdater.js';
import { createHudDrainCtx, spawnDamageNumbers, updateHudDrains, type HudDrainCtx } from './pixi/hudDrainUpdater.js';
import { createPlacementGhostCtx, updatePlacementGhost, type PlacementGhostCtx } from './pixi/placementGhostUpdater.js';
import { createLitSceneCtx, feedLitScene, type LitSceneCtx } from './pixi/litSceneUpdater.js';
import { createTurretShotCtx, noteTurretShots, type TurretShotCtx } from './pixi/turretShotUpdater.js';
import { resolveInitTarget, buildWorldScene, createGameplayCamera, setupMachinedArt, logInitFrameDiag, buildSceneLayers, buildOverlays } from './pixi/rendererSetup/initScene.js';
import { buildSpriteUpdaterCtxs } from './pixi/rendererSetup/initUpdaterCtxs.js';
import { buildFxWeapons, buildBeamPoolsAndEffects } from './pixi/rendererSetup/initFx.js';
import { installDomListeners } from './pixi/rendererSetup/initDomListeners.js';
import type { EffectQuality } from '@core/contracts/IEffects';
import { RendererInputController, type ForwardedPointerEvent, type RendererInputDeps } from './pixi/rendererInputController.js';
import { RendererCameraDirector, DEFAULT_GAMEPLAY_ZOOM, type RendererCameraDeps } from './pixi/cameraDirector.js';
import { artStats, backdropStats, shipVisualProbe, type ArtStats, type BackdropStats, type RendererProbeState, type ShipVisualProbe } from './pixi/rendererProbes.js';
import { type InterpolatedPose } from '../net/swarmInterpolation';
import { HaloRadar, type RadarDebugIcon } from './HaloRadar';
import { IncomingFireWarning } from './incoming/IncomingFireWarning.js';
import { HelmCourseMarker } from './helm/HelmCourseMarker.js';
import type { RadarInsets, RadarPrefs } from '../../shared-types/settings/radar.js';
import { LabelManager } from './Labels';
import { SelectionBracket } from './SelectionBracket';
import { AimFeedbackRenderer } from './AimFeedbackRenderer';
import { HoverBracket } from './HoverBracket';
import { FleetOverlay } from './FleetOverlay.js';
import { decideExplosionPosition } from './spriteUpdateDecisions';
import { shouldLatchFirstFrame } from './firstFrameLatch.js';
import { EffectsService, effectsDisabledByUrl } from '../effects/EffectsService';
import { readFxKillSwitches, type FxKillSwitches } from './fxKillSwitches';
import { type ArtHandle } from './art/ArtService.js';
import { MachinedShipSprite } from './art/MachinedShipSprite.js';
import { litPass } from './art/litPass.js';
import { MachinedFlatSprite } from './art/MachinedFlatSprite.js';
import { Backdrop } from './art/fx/Backdrop.js';
import { speedFxFullSpeed } from './art/fx/depth.js';
import { FxBeams, FxProjectiles } from './art/fx/FxWeapons.js';
import { blastRadiusFor, FxExplosions, FxMissileTrails } from './art/fx/FxExplosions.js';
import { FxEngines } from './art/fx/FxEngines.js';
import { FarZoomIcons } from './pixi/FarZoomIcons';
import { startZoomForScale } from '@shared-types/shipScale/tuning';
import { FxFences, FxShields } from './art/fx/FxShields.js';
import { ART_OFF, type ArtOptions } from './art/artMode.js';
import { updateArtShipLight, type ShipArtCtx } from './art/shipArtSprites.js';
import { BeamSpritePool, type BeamView } from './BeamSpritePool';
import { newSpeedFxSample, speedFxSampleInto } from './camera/speedFxSample';
import type { CameraCue } from '@core/contracts/cameraScript';
import { fillTractorBeams } from './tractorBeams';
import { MountVisualManager } from './MountVisualManager';
import { BackgroundGrid } from './BackgroundGrid';
import { CutFieldLayer } from './field/CutFieldLayer';
import { StarfieldBackground } from './StarfieldBackground';
import { logEvent, isDiagEnabled } from '../debug/ClientLogger';
import {
  buildGhostGfx,
} from './pixi/spriteBuilders.js';
import { FrameTimeRing } from '@core/perf/FrameTimeRing';
import { forEachShipRekey, moveKey, moveSetKey } from './shipRekey.js';
import type { RenderPerfReading, PerfProbeOp, RenderCountReading } from '@core/contracts/IRenderer';

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

/**


// Sprite/Graphics builders moved to ./pixi/spriteBuilders.ts — pure
// constructors of Pixi Graphics instances, no class state. The
// orchestrator below imports them from that module.

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
  /** A3 — visible rect for culling structure sprites (reused per frame). */
  private readonly _swarmViewScratch = new Float64Array(4);
  /** Load curtain (full-canvas dark overlay at join). Constructed in `init()`. */
  private curtain!: LoadCurtain;
  /** Effects subsystem (plan `wiggly-puppy`). Owns destruction particles,
   *  engine emitters, shield aura, impact sparks, etc. Constructed in
   *  `init()` AFTER `app`, `world`, `shipContainer`, and `curtain` exist.
   *  `null` when `?effects=0` escape hatch is active — destruction +
   *  flames then fall back to today's inline Graphics paths. */
  private effects: EffectsService | null = null;
  // Phone-stall thermal-isolation switches. Read once at init via
  // `readFxKillSwitches`; gated at render-time call sites to attribute
  // GPU heat to specific subsystems (beams / damage numbers / health
  // bars). Same pattern as `filtersDisabled` / `particlesDisabled`.
  private _beamsDisabled = false;
  private _cleanWorld = false;
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
  /** Pooled remote / mining / live beam ctx (pixi/beamUpdater.ts), built once in init. */
  private _beamCtx!: BeamCtx;
  /** Live getter view of the state the test / perf probes read (pixi/rendererProbes.ts). */
  private readonly _probes: RendererProbeState = this.probeState();
  private probeState(): RendererProbeState {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- getters read the renderer's live fields
    const r = this;
    return {
      get sprites() { return r.sprites; }, get artCtx() { return r._artCtx; }, get swarmSpriteKinds() { return r._swarmSpriteKinds; },
      get mountVisuals() { return r.mountVisuals; }, get camera() { return r.camera; }, get starfield() { return r.starfield; },
      get backdrop() { return r._backdrop; }, get effects() { return r.effects; }, get engineDbgScratch() { return r._engineDbgScratch; },
      get farIcons() { return r._farIcons; }, get warpFx() { return r._warpFxCtx.warpFx; }, get spoolFx() { return r._warpFxCtx.spoolFx; },
      get helmMarker() { return r.helmMarker; }, get lastMirror() { return r._lastMirror; }, get fxEngines() { return r._fxEngines; },
      get fxExplosions() { return r._fxExplosions; }, get fxProjectiles() { return r._fxProjectiles; }, get fxLiveBeams() { return r._fxLiveBeams; },
      get fxShields() { return r._fxShields; }, get fxShieldsOn() { return r._hitEventCtx.fxShieldsOn; }, get fxFences() { return r._fxFences; },
      get wreckBreaks() { return r._wreckBreaks; }, get wreckBlastsSpawned() { return r._wreckBlastsSpawned; },
      get wreckRipplesSpawned() { return r._wreckRipplesSpawned; }, get hullBlastsReplaced() { return r._hullBlastsReplaced; },
      get shipRekeysApplied() { return r._shipRekeysApplied; },
    };
  }
  private readonly explosionSprites = new LegacyExplosionSprites();
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
  private _liveBeamPool: BeamSpritePool | null = null;
  private _remoteBeamPool: BeamSpritePool | null = null;
  /** WS-4 Phase 4 (R2.27) — dedicated pool for the Miner's mining beam
   *  (`laser_fired` mountId `drill`). Separate from `_remoteBeamPool` so it can
   *  be tinted as a distinct fat amber drill beam AND so an E2E can isolate its
   *  `liveCount` (the shared remote pool can't tell a drill beam from a combat
   *  laser). The faint always-on link hint stays in `ConnectorRenderer`. */
  private _miningBeamPool: BeamSpritePool | null = null;
  private _tractorBeamPool: BeamSpritePool | null = null; private readonly _tractorViews: BeamView[] = []; private _tractorViewCount = 0; // salvage PR 11b (tractorBeams.ts)
  private miningBeamGfx: Container | null = null;
  private initialized = false;
  /** Reused per-frame so swarm interpolation doesn't allocate. */
  private readonly swarmPoseScratch: InterpolatedPose = { x: 0, y: 0, angle: 0 };
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
  /** Bound once (#14): the per-pair step of `applyShipRekeys`. */
  private readonly _rekeyShip = (from: string, to: string): void => {
    this.rekeyShip(from, to);
  };

  /**
   * RTS Part A seamless hand-over: a ship's mirror key changed (someone took
   * or let go of its controls; `ColyseusClient.rekeyShip` queued the pair on
   * `mirror.pendingShipRekeys`, which crosses the worker boundary with the
   * mirror). Every per-ship piece of renderer state MOVES to the new key, so
   * `updateShipSprites` finds the ship's sprite already built and the sweep
   * never destroys it: same sprite and art handle, same turret cluster (guns,
   * recoil, angles), health bar, label, exhaust, shield view, selection.
   * A stale sprite under `to` is torn down first, exactly as the sweep would.
   * Legacy effects (engine particles, shield ring) re-register by id on their
   * own each frame; their visuals don't depend on the key's history.
   */
  private rekeyShip(from: string, to: string): void {
    if (from === to) return;
    const sprite = this.sprites.get(from);
    if (sprite === undefined) return;
    const stale = this.sprites.get(to);
    if (stale !== undefined) {
      this.sprites.delete(to);
      stale.parent?.removeChild(stale);
      this._forgetSprite(to, false);
      stale.destroy({ children: true });
    }
    moveKey(this.sprites, from, to);
    moveKey(this._artCtx.handles, from, to);
    this.mountVisuals.rekeyShip(from, to);
    this._hudCtx.healthBars?.rekey(from, to);
    this.labels?.rekey(from, to);
    this._farIcons.forgetShip(from, sprite);
    this._fxEngines?.rekey(from, to);
    this._fxShields?.rekey(from, to);
    if (this._input._focusId === from) this._input._focusId = to;
    if (this._input._hoveredId === from) this._input._hoveredId = to;
    if (moveSetKey(this._input._selShips, from, to)) this._input.publishFleetSelection();
    this._shipRekeysApplied++;
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
  /** S3: wreck break-ups played (test hook via `artStats`). */
  private _wreckBreaks = 0;
  /** Break-up fireballs drawn (test hook via `artStats`), and their scratch. */
  private _wreckBlastsSpawned = 0;
  private _wreckRipplesSpawned = 0;
  /** Capital death blasts left to the wreck break-up (test hook). */
  private _hullBlastsReplaced = 0;
  private readonly _wreckBlastScratch: WreckBlast[] = [];
  /** `deathBlastFor` out (reused, #14). */
  private readonly _deathBlastScratch: DeathBlast = { scale: 1, linger: 1, vaporise: false, tint: 0, seconds: 0 };
  private _projectileUpdaterCtx!: ProjectileSpriteCtx;
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
    fleetSelSeq: 0,
    fleetSelIds: [],
    orderSeq: 0,
    orderKind: 'move',
    orderX: 0,
    orderY: 0,
    orderTargetId: null,
    takeControlsSeq: 0,
    takeControlsId: null,
    fleetPickPoints: 0,
    fleetPickSeq: 0,
    fleetPickResult: null,
    placementPreviewConnectionCount: 0,
    selectedPickId: null,
    selectedPickKind: null,
    hoveredPickId: null,
    miningBeamCount: 0, viewX: 0, viewY: 0, viewHalf: 0,
  };

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
    const fxNow = (): number => this.fxNow();

    const backdrop = setupMachinedArt({
      artOpts: this._artOpts, isTouch: this._isTouch, quality: this.quality, artCtx: this._artCtx,
      mountVisuals: this.mountVisuals, app: this.app, worldHost: this.worldHost, sectorKey: this._sectorKey, effectsQuality,
    });
    if (backdrop) this._backdrop = backdrop;
    // DEV/E2E hook (main-thread path, `?worker=0`): what the art service is
    // doing. Assigned from `update()`, so it always follows the LIVE renderer
    // (a dev StrictMode remount can leave a disposed one behind).
    if (isDom) this._artStatsHook = () => this.artStats();
    this._beamsDisabled = fxKillSwitches.beamsDisabled;
    this._hudCtx.dmgNumbersDisabled = fxKillSwitches.dmgNumbersDisabled;
    this._hudCtx.selfDmgNumbersDisabled = fxKillSwitches.selfDmgNumbersDisabled;
    this._hudCtx.healthBarsDisabled = fxKillSwitches.healthBarsDisabled;

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
    this._cameraDirector._zoomPinned = resolvedZoom !== startZoomForScale(DEFAULT_GAMEPLAY_ZOOM);
    this.camera.setZoom(resolvedZoom);

    logInitFrameDiag(this.app, this.world, target);

    this._cleanWorld = fxKillSwitches.cleanWorld; // `?cleanworld=1` (showcase capture)
    const layers = buildSceneLayers({
      app: this.app, frameMarkers: this.frameMarkers, camera: this.camera, cleanWorld: this._cleanWorld,
      mountVisuals: this.mountVisuals, cutField: this._cutField, placementGhostCtx: this._placementGhostCtx,
      wreckFarLayer: this._wreckFarLayer, farIcons: this._farIcons, lockMarksVisible: this._lockMarksVisible, warpFxCtx: this._warpFxCtx,
    });
    this.curtain = layers.curtain;
    if (layers.backgroundGrid) this.backgroundGrid = layers.backgroundGrid;
    this.shipContainer = layers.shipContainer;
    this.connectorRenderer = layers.connectorRenderer;

    const ctxs = buildSpriteUpdaterCtxs({
      shipContainer: this.shipContainer, sprites: this.sprites, mountVisuals: this.mountVisuals,
      remoteHitTargets: this._updateRemoteHitTargetsScratch, localHitTargets: this._updateLocalHitTargetsScratch,
      seenScratch: this._updateSeenScratch, art: this._artCtx, swarmPoseScratch: this.swarmPoseScratch,
      structureMountAngles: this._structureMountSlew, spriteKinds: this._swarmSpriteKinds, spriteBuildSigs: this._swarmSpriteSigs,
      fieldRocks: this._cutField, dyingHulls: this._dyingHulls,
      projectileSprites: this.projectileSprites, projSeenScratch: this._updateProjSeenScratch,
      missileSprites: this.missileSprites, missileSeenScratch: this._updateMissileSeenScratch, activeExplosions: this.missileExplosionsActive,
      effects: () => this.effects, fxExplosions: () => this._fxExplosions, effectsQuality, fxNow, wreckBlastScratch: this._wreckBlastScratch,
      noteWreckBreak: () => { this._wreckBreaks++; },
      noteWreckBlastSpawned: () => { this._wreckBlastsSpawned++; },
      noteWreckRippleSpawned: () => { this._wreckRipplesSpawned++; },
    });
    this._shipUpdaterCtx = ctxs.ship;
    this._swarmUpdaterCtx = ctxs.swarm;
    this._projectileUpdaterCtx = ctxs.projectile;
    this._missileUpdaterCtx = ctxs.missile;
    // New weapons (B3, `?fx=new`): beam glow + flow over today's beam pools,
    // and bolts / tracers as batched sprites. Nothing draws until baked.
    if (this._artOpts.fx === true && this._artCtx.art) {
      const fx = buildFxWeapons({
        art: this._artCtx.art, shipContainer: this.shipContainer, connectorRenderer: this.connectorRenderer, effectsQuality, fxNow,
        litSceneCtx: this._litSceneCtx, projectileUpdaterCtx: this._projectileUpdaterCtx, missileUpdaterCtx: this._missileUpdaterCtx,
        engineShieldFxCtx: this._engineShieldFxCtx, turretShotCtx: this._turretShotCtx, hitEventCtx: this._hitEventCtx,
      });
      this._fxLiveBeams = fx.liveBeams; this._fxRemoteBeams = fx.remoteBeams; this._fxProjectiles = fx.projectiles;
      this._fxExplosions = fx.explosions; this._fxMissileTrails = fx.missileTrails; this._fxEngines = fx.engines;
      this._fxShields = fx.shields; this._fxFences = fx.fences;
    }

    // Effects subsystem (plan `wiggly-puppy` M3+). Constructed inside
    // PixiRenderer.init so the same single seam serves both the worker
    // path (this whole file runs inside the renderer worker) AND the
    // main-thread fallback (touch devices, Safari < 17). ?effects=0 URL
    // hatch skips construction entirely.
    if (!effectsDisabledByUrl()) {
      const fx = buildBeamPoolsAndEffects({
        app: this.app, world: this.world, camera: this.camera, shipContainer: this.shipContainer,
        fxGlowTexture: this._artOpts.fx === true && this._artCtx.art ? () => this.fxGlowTexture() : null,
        sprites: this.sprites, enginePoseScratch: this._enginePoseScratch, lastMirror: () => this._lastMirror, fxKillSwitches,
      });
      this._liveBeamPool = fx.liveBeamPool; this.liveBeamGfx = fx.liveBeamGfx;
      this._remoteBeamPool = fx.remoteBeamPool; this.remoteBeamGfx = fx.remoteBeamGfx;
      this._miningBeamPool = fx.miningBeamPool; this.miningBeamGfx = fx.miningBeamGfx;
      this._tractorBeamPool = fx.tractorBeamPool;
      this.effects = fx.effects;
    }

    // Beams leave from the turrets on top of the hull, so they draw over every
    // hull (ships spawn later and would otherwise stack above them).
    raiseBeamsOverHulls(this.shipContainer, [this._fxRemoteBeams?.container, this._fxLiveBeams?.container],
      [this._liveBeamPool, this._remoteBeamPool, this._miningBeamPool, this._tractorBeamPool]);
    // Pooled beam ctx (pixi/beamUpdater.ts): every reference is final by here.
    this._beamCtx = createBeamCtx({
      beamsDisabled: this._beamsDisabled, fxNow: () => this.fxNow(),
      remoteBeamPool: this._remoteBeamPool, remoteBeamGfx: this.remoteBeamGfx,
      miningBeamPool: this._miningBeamPool, miningBeamGfx: this.miningBeamGfx,
      liveBeamPool: this._liveBeamPool, liveBeamGfx: this.liveBeamGfx,
      fxRemoteBeams: this._fxRemoteBeams, fxLiveBeams: this._fxLiveBeams,
      fxShields: this._fxShields, fxFences: this._fxFences, fxShieldPose: this._fxShieldPose,
      swarmPoseScratch: this.swarmPoseScratch, feedback: this.feedback,
    });
    this._litSceneCtx.beamCtx = this._beamCtx; // GPU-lit beam lights (pixi/litSceneUpdater.ts)
    stackVaporiseOverBeams(this.shipContainer, this._fxExplosions); // the vaporise flash reads over the beams
    ({
      fleetOverlay: this.fleetOverlay, labels: this.labels, selectionBracket: this.selectionBracket,
      hoverBracket: this.hoverBracket, aimFeedback: this.aimFeedback,
    } = buildOverlays({
      app: this.app, camera: this.camera, world: this.world, incomingFire: this.incomingFire,
      helmMarker: this.helmMarker, halo: this.halo, hudCtx: this._hudCtx, cleanWorld: this._cleanWorld,
    }));

    // Drive Camera momentum + follow each frame (works in both contexts).
    this.app.ticker.add(() => {
      // deltaMS keeps the Camera's zoom-ease framerate-independent
      // (60 / 90 / 120 Hz devices ease at the same wall-clock rate).
      this.camera.tick(this.app.ticker.deltaMS);
      // Screen-space overlays project through THIS frame's camera (after its
      // tick), the transform the world renders with below.
      this._input.drawFleetOverlay();
      if (this._ringProbeOn) this.captureFleetRingProbe();
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
      installDomListeners({
        app: () => this.app, domContainer, input: this._input, cameraDirector: this._cameraDirector,
        isInitialized: () => this.initialized, resolutionFor: (dpr, w, h) => this.resolutionFor(dpr, w, h),
        starfield: () => this.starfield,
      });
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
    this._cameraDirector.applyHullZoom(mirror);
    this.mountVisuals.setFrame(this.fxNow(), this.effects?.getQuality() ?? 'medium');
    // Seamless hand-over (RTS Part A): move re-keyed ships' state BEFORE the
    // sprite pass, so it finds each sprite under its new key (no rebuild).
    forEachShipRekey(mirror.pendingShipRekeys, this._rekeyShip);
    updateShipSprites(mirror, this._shipUpdaterCtx);

    // Explosion sprites spawned this frame for destroyed ships.
    // 2026-05-13 — the "explosion appeared at zero zero" bug (a parked
    // hull's sprite lived in a separate map). Since RTS Part A S3 every
    // ship's sprite is in `this.sprites` (active by playerId, parked by
    // shipInstanceId). Helper in `spriteUpdateDecisions.ts`, unit-tested.
    // A capital dying into a wreck stays drawn until its pieces are (marked
    // here while its sprite is still mapped; the sweeps below hand it over).
    noteDyingHulls(mirror.explodingShips, mirror.capitalWrecks, this._spriteShipKind, this._dyingHulls, this.fxNow(), mirror.subcapWrecks, mirror.vaporisedShips);
    if (mirror.explodingShips) {
      for (const targetId of mirror.explodingShips) {
        // PRESERVE the decideExplosionPosition lookup (the 2026-05-13 fix):
        // the dying ship's mirror entry is already gone (killEntity), so the
        // pose comes from its still-mapped SPRITE, never a (0,0) default.
        const pose = decideExplosionPosition({
          targetId,
          shipSprites: this.sprites,
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
        // Burned away by a cut kill (fracture v11): no wreck follows.
        const vaporised = mirror.vaporisedShips?.has(targetId) === true;
        // Capital wrecks on: a dying capital explodes where it broke (the wreck
        // break-up at its kill point), not as a hull-sized blast over the whole
        // hull (money-shot review).
        if (hullDeathBlastReplaced(mirror.capitalWrecks, dying instanceof MachinedShipSprite && dying.capital, this._spriteShipKind(targetId), vaporised)) {
          this._hullBlastsReplaced++;
          continue;
        }
        const diameter = dyingHullDiameter(dying, this._spriteShipKind(targetId)); // a parked hull: its kind's size
        // A sub-cap breaking into wreck pieces (welcome `subcapWrecks`) gets a
        // smaller blast with shorter smoke (profile fx.deathBlastScale/Linger).
        const db = deathBlastFor(mirror.subcapWrecks, mirror.capitalWrecks, this._spriteShipKind(targetId), this._deathBlastScratch, vaporised);
        // The vaporise variant (flash, glow, ash puff; no fireball, smoke or
        // wreck); its art not ready: fall through to today's fallback below.
        if (db.vaporise && spawnVaporiseBlast(this.effects, this._fxExplosions, pose.x, -pose.y, diameter, this.fxNow(), db)) continue;
        if (!db.vaporise && this._fxExplosions?.spawn(pose.x, -pose.y, blastRadiusFor(diameter) * db.scale, this.fxNow(), db.linger)) {
          // drawn by FxExplosions
        } else if (this.effects) {
          this.effects.spawnBurst('destruction', pose.x, -pose.y);
          this.effects.triggerOneShotFilter('destruction-shock', pose.x, -pose.y);
        } else {
          this.explosionSprites.spawn(this.shipContainer, pose.x, pose.y);
        }
      }
    }

    // Advance and remove expired explosion sprites (only the legacy
    // fallback path uses this; the EffectsService manages its own
    // particles + shock filters in its tick).
    this.explosionSprites.tick(this.shipContainer);

    // Structures plan, Phase 3 — grid connector web (behind sprites). Joins
    // mirror.structures → mirror.swarm positions; no-op when no structures.
    // Item C: feed the connector preview the pointer-chosen ghost point (so the
    // preview lines emanate from where the ghost is actually drawn), then read
    // the would-connect count back into the feedback channel.
    this.connectorRenderer.ghostWorldX = this._input._placementChosenX;
    this.connectorRenderer.ghostWorldY = this._input._placementChosenY;
    // Phase 5 — bolder defensive range ring on the hovered/selected turret. The
    // selection/hover ids are `swarm-<entityId>` (structures ride the swarm
    // channel); prefer the selected one.
    const highlightedSel = this._input._focusId ?? this._input._hoveredId;
    this.connectorRenderer.highlightedStructureId =
      highlightedSel !== null && highlightedSel.startsWith('swarm-')
        ? parseInt(highlightedSel.slice('swarm-'.length), 10)
        : null;
    this.connectorRenderer.update(mirror, this.world.scale.x, this.fxNow());
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
    // eslint-disable-next-line no-restricted-properties -- real time: swarm poses are wall-stamped arrivals
    const swarmNow = performance.now();
    this._swarmUpdaterCtx.slewDtSec =
      this._lastSwarmUpdateNow > 0
        ? Math.min(0.05, Math.max(0, (swarmNow - this._lastSwarmUpdateNow) / 1000))
        : 1 / 60;
    this._lastSwarmUpdateNow = swarmNow;
    this._swarmUpdaterCtx.viewBounds = this.camera.visibleBoundsInto(this._swarmViewScratch);
    this._swarmUpdaterCtx.fxNowMs = this.fxNow(); // wreck glow follows the game speed
    this._swarmUpdaterCtx.cameraScale = this.world.scale.x; // wreck-piece far-zoom LOD
    this._swarmUpdaterCtx.wreckFarLayer = this._wreckFarLayer;
    updateSwarmSprites(mirror, this._swarmUpdaterCtx);
    this._farIcons.update(mirror, this.sprites, this.world.scale.x);
    noteTurretShots(mirror, this._turretShotCtx); // pixi/turretShotUpdater.ts
    this._litSceneCtx.tractorViewCount = this._tractorViewCount;
    feedLitScene(mirror, this._litSceneCtx); // pixi/litSceneUpdater.ts

    // Sprites whose entity left the mirror this frame. Boost flame and
    // mount-visual cluster are children — destroy({ children: true }) frees
    // them too, but the map entries go so a respawn rebuilds cleanly. A
    // capital that died leaving a wreck is held (drawn) until its pieces are.
    sweepUnseenSprites(this.sprites, seen, this._forgetSprite, this._dyingHulls, this.fxNow());

    // Projectile + ghost-projectile sprites — see pixi/projectileSpriteUpdater.ts.
    // Ctx pooled to `this._projectileUpdaterCtx`.
    this._projectileUpdaterCtx.cameraScale = this.world.scale.x;
    updateProjectileSprites(mirror, this._projectileUpdaterCtx);

    // Missile sprites + detonation VFX. Reads single-pose-per-frame via
    // resolveMissileDisplayPose (one-pose-per-frame rule — same as drones).
    // eslint-disable-next-line no-restricted-properties -- real time: missile poses are wall-stamped arrivals
    updateMissileSprites(mirror, this._missileUpdaterCtx, performance.now());
    this._fxExplosions?.tick(this.fxNow());

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

    // New shields (B5): open the frame here; beams and hits feed it below,
    // the shield sync closes it (pixi/hitEventUpdater.ts).
    beginShieldFrame(this._hitEventCtx);
    this._tractorViewCount = this._beamsDisabled || !this._tractorBeamPool ? 0 : fillTractorBeams(mirror, this.fxNow(), this.world.scale.x, this._tractorViews);
    this._tractorBeamPool?.setBeams(this._tractorViews, this._tractorViewCount, this.world.scale.x);
    // Remote, mining + live beams: see pixi/beamUpdater.ts. Ctx pooled to
    // `this._beamCtx` (built once in init); camera scale + shield gate per frame.
    this._beamCtx.cameraScale = this.world.scale.x;
    this._beamCtx.fxShieldsOn = this._hitEventCtx.fxShieldsOn;
    updateBeams(mirror, this._beamCtx);

    const local = mirror.localPlayerId ? this.sprites.get(mirror.localPlayerId) : null;
    this._speedFollowSprite = null;
    // Phase 4 WS-A1 — in spectator/construction mode the camera free-roams; do
    // NOT re-issue the local-ship follow (which would yank the view back / snap
    // to a ship that no longer exists). `setSpectator(true)` already detached
    // the follow target; the gameplay pointer path keeps panning/zooming it.
    this._speedFollowSprite = this._cameraDirector.updateFrame(mirror, local);

    // Structure placement ghost + confirm-UI projection: see pixi/placementGhostUpdater.ts.
    this._placementGhostCtx.spectator = this._spectator;
    updatePlacementGhost(mirror, this._placementGhostCtx);

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
    // The speed is measured from the followed ship's drawn pose at the frame
    // time it was drawn for, shifted like the sky (capital jitter, 2026-11-12).
    const followed = this._speedFollowSprite;
    const follow = this._speedFollowPose;
    if (followed) {
      follow.x = followed.x - (mirror.travelJumpX ?? 0);
      follow.y = followed.y + (mirror.travelJumpY ?? 0);
    }
    // Game time (time scale): the pose's wall frame time goes through the
    // presentation clock, so speed effects follow the sector's speed like every
    // other effect (at 1× `at(t)` is `t`).
    const speedFrameMs = mirror.frameTimeMs !== undefined ? this.fxClock.at(mirror.frameTimeMs) : undefined;
    // Command view's free camera is moved by hand, not flown: no speed effects.
    const speedSample = speedFxSampleInto(this._speedSample, followed ? follow : null, speedFrameMs, skyCam.center, this.fxNow(), this._spectator && !this._cameraDirector.isCameraScripted());
    const backdropOn = this._backdrop?.update(skyCam, this.fxNow(), speedFxFullSpeed(speedShip?.kind), speedSample) ?? false;
    // Speed effects (C3): the backdrop's eased speed asks the camera to zoom
    // out a little; applied on the camera's next tick (none while it's baking).
    this.camera.setSpeedZoom(backdropOn ? this._backdrop!.speedZoom() : 1);
    if (backdropOn) this.starfield?.setHidden(true);
    else this.starfield?.update(this.camera);
    this.backgroundGrid?.update(this.camera);

    // Damage numbers (spawn drain, before hit events): see pixi/hudDrainUpdater.ts.
    spawnDamageNumbers(mirror, this._hudCtx);
    // Hit events (impacts, wall hits, shield contacts): see pixi/hitEventUpdater.ts.
    this._hitEventCtx.effects = this.effects;
    updateHitEvents(mirror, this._hitEventCtx);
    // Damage-number cancels + tick, level-up icons, health bars: see pixi/hudDrainUpdater.ts.
    updateHudDrains(mirror, this._hudCtx);
    if (this._lockMarksVisible) this.aimFeedback?.update(mirror, this.camera.scale.x);
    else this.aimFeedback?.hide();

    // The selection's focus (Item B4; RTS Part A). The renderer owns
    // `_focusId`; the bracket resolves its live pose from the mirror each frame
    // (the markers themselves are drawn in the ticker, `drawFleetOverlay`). If
    // the focus has vanished from the mirror (despawned / left interest), clear
    // it so the panel + stats channel tear down.
    const focusPresent = this.selectionBracket?.resolveFocus(mirror, this._input._focusId) ?? false;
    if (!focusPresent && this._input._focusId !== null) {
      this._input._focusId = null;
      this._input._focusKind = null;
    }
    // Publish the current selection for the main thread → Zustand bridge.
    this.feedback.selectedPickId = this._input._focusId;
    this.feedback.selectedPickKind = this._input._focusKind;

    // WS-10 (R2.4) — hover outline. Suppress it on the already-SELECTED entity so
    // the two brackets never stack on the same target. If the hovered entity
    // vanished from the mirror, clear `_hoveredId`. Renderer-local id published
    // for the E2E bridge (data-hover-pick-id) — NEVER Zustand (#2).
    // Below the full HUD (showcase `?hud=`) the hover outline is not drawn.
    const hovered = this._input._hoveredId;
    const hoverTarget = hovered === null || hovered === this._input._focusId || this._input._selShips.has(hovered) || !this._lockMarksVisible ? null : hovered;
    if (hoverTarget !== null) {
      const stillHovered = this.hoverBracket?.update(mirror, hoverTarget) ?? false;
      if (!stillHovered) this._input._hoveredId = null;
    } else {
      this.hoverBracket?.update(mirror, null);
    }
    this.feedback.hoveredPickId = this._input._hoveredId;
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

    this._cutField.update(mirror, this._artCtx.sunAz, this.camera.scale.x, this.camera.visibleBoundsInto(this._swarmViewScratch)); // cut-field chunks + view (far-zoom tiles culled to it)

    // Phase 1 — name labels above remote ships and drones (skip self).
    this.labels?.update(mirror);

    // Dying capitals: hand over to wreck pieces drawn this frame, or give up
    // at the deadline; the rest keep their light frame at the last pose.
    this._dyingHulls.settle(this.fxNow());
    for (let i = 0; i < this._dyingHulls.heldCountNow(); i++) updateArtShipLight(this._artCtx, this._dyingHulls.heldSprite(i));

    // Halo arrows for off-screen POIs. Runs after moveCenter so the visibility
    // test uses this frame's viewport bounds, not last frame's. Incoming fire
    // first: the radar reads its groups for the off-screen chevron.
    this.incomingFire.update(mirror, this.fxNow()); // countdowns are game seconds
    // eslint-disable-next-line no-restricted-properties -- real time: the helm order marker is UI
    this.helmMarker.update(mirror, performance.now());
    this._input.updateFleetSelection(mirror);
    this.halo.update(mirror);

    // ---------- RendererFeedback (end-of-frame, main-thread readable) ----------
    // Populate the feedback struct that main reads after update() returns.
    // Today this is sync-mutate (renderer and main share a process).
    // Phase 4 of the worker migration will replace this with a FEEDBACK
    // postMessage from the renderer worker; the contract surface stays
    // the same (caller does `renderer.getFeedback()`).
    // Every ship, parked hulls included (R2.32: the worker-boundary probe
    // asserts a parked hull's barrels render; covers ACTIVE + LINGERING, #17).
    this.feedback.mountCounts.clear();
    for (const shipId of mirror.ships.keys()) {
      const count = this.mountVisuals.mountCountForShip(shipId);
      if (count > 0) this.feedback.mountCounts.set(shipId, count);
    }
    this.feedback.haloArrowCount = this.halo.getDebugVisibleArrowCount();
    this.feedback.damageNumberActiveCount = this._hudCtx.damageNumbers?.getActiveCount() ?? 0;
    const vb = this.camera.visibleBoundsInto(this._swarmViewScratch); // Pixi space: y flips back to game
    this.feedback.viewX = (vb[0]! + vb[2]!) / 2; this.feedback.viewY = -(vb[1]! + vb[3]!) / 2; this.feedback.viewHalf = Math.max(vb[2]! - vb[0]!, vb[3]! - vb[1]!) / 2;
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
    // `this.backgroundGrid?.update(this.camera)`). `warpTickMs` is
    // written by the separate `LoadCurtain` ticker callback. `rendererUpdateMs`
    // closes the bracket opened at method entry. The worker posts these only when diagnostics are on.
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
    // Warp / spool FX: see pixi/warpFxUpdater.ts (ctx pooled; camera scale per frame).
    this._warpFxCtx.cameraScale = this.world.scale.x;
    updateWarpFx(mirror, this._warpFxCtx);

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
      // See pixi/engineShieldFxUpdater.ts; the shield gate is shared with beams + hit FX.
      this._engineShieldFxCtx.effects = this.effects;
      this._engineShieldFxCtx.fxShieldsOn = this._hitEventCtx.fxShieldsOn;
      updateEngineShieldFx(mirror, this._engineShieldFxCtx);

      const nowMs = this.fxNow();
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

    // eslint-disable-next-line no-restricted-properties -- real time: cost measurement
    this.frameMarkers.rendererUpdateMs = performance.now() - updateStart;
    this._perfRing?.push(this.frameMarkers.rendererUpdateMs);
  }

  /** Wall-clock of the last `effects.tick` call. Used to derive dt for the
   *  next call. 0 ⇒ first frame (use a default 16.67 ms to seed). */
  private lastEffectsTickNowMs = 0;

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

  /** The baked glow texture for impact sparks (null until baked). */
  private fxGlowTexture(): () => Texture | null {
    const h = this._artCtx.art!.fx('glow', undefined, undefined, false);
    return () => (h.state === 'ready' && h.fx ? h.fx.tex : null);
  }

  /** New shields + fences (`?fx=new`, B5). */
  private _fxShields: FxShields | null = null;
  private _fxFences: FxFences | null = null;
  /** Pixi-space pose of an entity's sprite, for the new shields. */
  private readonly _fxShieldPose = (id: string, out: { x: number; y: number }): boolean => {
    const sp = this.sprites.get(id);
    if (!sp) return false;
    out.x = sp.x; out.y = sp.y;
    return true;
  };

  /** New explosions + missile smoke (`?fx=new`, B4). */
  private _fxExplosions: FxExplosions | null = null;
  private _fxMissileTrails: FxMissileTrails | null = null;
  private _fxEngines: FxEngines | null = null;
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
  /** Phase 4 travel state: the camera the sky is drawn from (shifted by the
   *  trip's approach jump). */
  private readonly _skyCam = { center: { x: 0, y: 0 }, scale: { x: 1 }, screenWidth: 0, screenHeight: 0 };
  /** The sprite the camera follows this frame (null: spectator / script),
   *  and the speed-effects sample built from it (`speedFxSampleInto`). */
  private _speedFollowSprite: { readonly x: number; readonly y: number } | null = null;
  private readonly _speedFollowPose = { x: 0, y: 0 };
  private readonly _speedSample = newSpeedFxSample();
  /** Scratch for the test-only particle count in `artStats`. */
  private readonly _engineDbgScratch: number[] = [];

  /** New weapon effects (`?fx=new`, B3). */
  private _fxLiveBeams: FxBeams | null = null;
  private _fxRemoteBeams: FxBeams | null = null;
  private _fxProjectiles: FxProjectiles | null = null;

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

  /** Test-only ring probe state (RTS review 2026-11-14). Off until first read. */
  private _ringProbeOn = false;
  private readonly _ringProbe = { id: '', ringX: NaN, ringY: NaN, shipX: NaN, shipY: NaN, frames: 0 };
  private readonly _ringProbePt = { x: 0, y: 0 };

  /** Ticker, after the camera tick (the transform this frame renders with):
   *  the first selection marker as drawn vs its ship sprite's screen point. */
  private captureFleetRingProbe(): void {
    const o = this.selectionBracket;
    const id = o?.lastMarkerId ?? null;
    if (o === null || id === null) return;
    const sp = this.sprites.get(id);
    if (sp === undefined) return;
    const g = sp.parent ? sp.parent.toGlobal(sp.position, this._ringProbePt) : null;
    if (g === null) return;
    const p = this._ringProbe;
    p.id = id; p.ringX = o.lastMarker.x; p.ringY = o.lastMarker.y; p.shipX = g.x; p.shipY = g.y; p.frames++;
  }

  /**
   * Test-only (RTS review 2026-11-14): turns the per-frame ring probe on and
   * returns the latest capture: the first selection marker's drawn centre and its
   * ship's screen point, both as the frame renders. Read by the
   * `__eqxFleetRingProbe` DEV hook (`?worker=0`). Not used by gameplay.
   */
  /** Test-only ship identity probe (`__eqxShipVisualProbe`): see pixi/rendererProbes.ts. */
  shipVisualProbe(key: string): ShipVisualProbe { return shipVisualProbe(this._probes, key); }

  fleetRingProbe(): { id: string; ringX: number; ringY: number; shipX: number; shipY: number; frames: number } {
    this._ringProbeOn = true;
    return { ...this._ringProbe };
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
    this.incomingFire.reset();
    this.helmMarker.reset();
    this._fxShields?.reset();
    this._fxFences?.reset();
    clearEngineShieldFxIds(this._engineShieldFxCtx);
  }

  /** Machined art status (DEV/perf probe): see pixi/rendererProbes.ts. */
  artStats(): ArtStats { return artStats(this._probes); }

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
    this.curtain.destroy();
    // Wipe effects subsystem pools (particles, shock filters, etc.).
    if (this.effects) {
      this.effects.resetForSectorHandoff();
      this.effects = null;
    }
    // Clear the per-effect diff trackers so a re-init starts clean.
    clearEngineShieldFxIds(this._engineShieldFxCtx);
    // Remove canvas pointer / wheel / touch listeners so an in-flight
    // event doesn't reach a destroyed Camera.
    this._input.removeEventListeners(this.app?.canvas);
    const handler = (this.app as unknown as Record<string, unknown>)['_resizeHandler'];
    if (typeof handler === 'function') {
      window.removeEventListener('resize', handler as EventListener);
      window.removeEventListener('orientationchange', handler as EventListener);
      window.visualViewport?.removeEventListener('resize', handler as EventListener);
    }
    const ro = (this.app as unknown as Record<string, unknown>)['_resizeObserver'];
    if (ro instanceof ResizeObserver) ro.disconnect();
    this._hudCtx.damageNumbers?.destroy();
    this._hudCtx.levelUpIcons?.destroy();
    this._hudCtx.healthBars?.destroy();
    this.labels?.destroy();
    this.selectionBracket?.destroy();
    this.hoverBracket?.destroy();
    this.mountVisuals.disposeAll();
    this.halo.destroy();
    this.incomingFire.destroy();
    this.helmMarker.destroy();
    this.fleetOverlay?.destroy();
    this.backgroundGrid?.destroy();
    this.starfield?.destroy();
    // Warp stage + filters live on app.stage so `app.destroy({ children: true })`
    // tears them down. warp.destroy() already removed the ticker handler.
    this.app.destroy(true, { children: true });
  }
}
