/**
 * The pooled ctx of `PixiRenderer.update()`'s frame passes and its ticker
 * callback — lifted out of `PixiRenderer` (god-file split, slice 7).
 *
 * `refs` is the renderer's live-field view: a getter object built once by the
 * renderer (fields it reassigns in `init` are read through getters, constant
 * members are plain). The rest is the passes' own state and scratch (follow
 * sprite, server ghost, dt stamps, art-readiness flags, view/screen scratch),
 * created once by `createRendererFrameCtx`. Nothing here allocates per frame
 * (invariant #14).
 */

import type { Application, Container, Graphics, RenderLayer } from 'pixi.js';
import type { GameClock } from '@core/clock/GameClock';
import type { RendererFeedback } from '@core/contracts/IRenderer';
import type { Camera } from '../worker/Camera';
import type { FrameMarkers } from '../worker/protocol';
import type { ConnectorRenderer } from './ConnectorRenderer.js';
import type { EffectsService } from '../../effects/EffectsService';
import type { FxExplosions } from '../art/fx/FxExplosions.js';
import type { Backdrop } from '../art/fx/Backdrop.js';
import type { StarfieldBackground } from '../StarfieldBackground';
import type { BackgroundGrid } from '../BackgroundGrid';
import type { LabelManager } from '../Labels';
import type { SelectionBracket } from '../SelectionBracket';
import type { HoverBracket } from '../HoverBracket';
import type { AimFeedbackRenderer } from '../AimFeedbackRenderer';
import type { BeamSpritePool, BeamView } from '../BeamSpritePool';
import type { ShipSpriteCtx } from './shipSpriteUpdater.js';
import type { SwarmSpriteCtx } from './swarmSpriteUpdater.js';
import type { ProjectileSpriteCtx } from './projectileSpriteUpdater.js';
import type { MissileSpriteCtx } from './missileSpriteUpdater.js';
import type { BeamCtx } from './beamUpdater.js';
import type { RendererCameraDirector } from './cameraDirector.js';
import type { RendererInputController } from './rendererInputController.js';
import type { HudDrainCtx } from './hudDrainUpdater.js';
import type { HitEventCtx } from './hitEventUpdater.js';
import type { LitSceneCtx } from './litSceneUpdater.js';
import type { TurretShotCtx } from './turretShotUpdater.js';
import type { WarpFxCtx } from './warpFxUpdater.js';
import type { EngineShieldFxCtx } from './engineShieldFxUpdater.js';
import type { PlacementGhostCtx } from './placementGhostUpdater.js';
import type { DyingHullHold } from './dyingHullHold.js';
import type { FarZoomIcons } from './FarZoomIcons';
import type { CutFieldLayer } from '../field/CutFieldLayer';
import type { IncomingFireWarning } from '../incoming/IncomingFireWarning.js';
import type { HelmCourseMarker } from '../helm/HelmCourseMarker.js';
import type { HaloRadar } from '../HaloRadar';
import type { MountVisualManager } from '../MountVisualManager';
import type { ShipArtCtx } from '../art/shipArtSprites.js';
import type { ArtHandle } from '../art/ArtService.js';
import { newSpeedFxSample, type SpeedFxSample } from '../camera/speedFxSample';
import { LegacyExplosionSprites } from './legacyExplosionSprites.js';
import type { DeathBlast } from './deathBlast.js';

/** The renderer's members the frame passes read. Getters for what `init` (re)assigns. */
export interface RendererFrameRefs {
  readonly app: Application;
  readonly camera: Camera;
  readonly world: Container;
  readonly shipContainer: Container;
  readonly connectorRenderer: ConnectorRenderer;
  readonly effects: EffectsService | null;
  readonly fxExplosions: FxExplosions | null;
  readonly backdrop: Backdrop | null;
  readonly starfield: StarfieldBackground | null;
  readonly backgroundGrid: BackgroundGrid | null;
  readonly labels: LabelManager | null;
  readonly selectionBracket: SelectionBracket | null;
  readonly hoverBracket: HoverBracket | null;
  readonly aimFeedback: AimFeedbackRenderer | null;
  readonly tractorBeamPool: BeamSpritePool | null;
  readonly shipUpdaterCtx: ShipSpriteCtx;
  readonly swarmUpdaterCtx: SwarmSpriteCtx;
  readonly projectileUpdaterCtx: ProjectileSpriteCtx;
  readonly missileUpdaterCtx: MissileSpriteCtx;
  readonly beamCtx: BeamCtx;
  readonly spectator: boolean;
  readonly lockMarksVisible: boolean;
  readonly cleanWorld: boolean;
  readonly beamsDisabled: boolean;
  readonly ringProbeOn: boolean;
  readonly artStatsHook: (() => unknown) | null;
  readonly sprites: Map<string, Container>;
  readonly mountVisuals: MountVisualManager;
  readonly cameraDirector: RendererCameraDirector;
  readonly input: RendererInputController;
  readonly feedback: RendererFeedback;
  readonly frameMarkers: FrameMarkers;
  readonly hudCtx: HudDrainCtx;
  readonly hitEventCtx: HitEventCtx;
  readonly litSceneCtx: LitSceneCtx;
  readonly turretShotCtx: TurretShotCtx;
  readonly warpFxCtx: WarpFxCtx;
  readonly engineShieldFxCtx: EngineShieldFxCtx;
  readonly placementGhostCtx: PlacementGhostCtx;
  readonly dyingHulls: DyingHullHold;
  readonly farIcons: FarZoomIcons;
  readonly cutField: CutFieldLayer;
  readonly wreckFarLayer: RenderLayer;
  readonly incomingFire: IncomingFireWarning;
  readonly helmMarker: HelmCourseMarker;
  readonly halo: HaloRadar;
  readonly fxClock: GameClock;
  readonly artCtx: ShipArtCtx;
  readonly seenScratch: Set<string>;
  readonly remoteHitTargets: Set<string>;
  readonly localHitTargets: Set<string>;
  readonly tractorViews: BeamView[];
  readonly spriteShipKind: (id: string) => string | null | undefined;
  readonly forgetSprite: (id: string, held: boolean) => void;
  readonly rekeyShip: (from: string, to: string) => void;
  readonly captureFleetRingProbe: () => void;
  readonly fxNow: () => number;
}

export interface RendererFrameCtx {
  readonly r: RendererFrameRefs;
  /** A3 — visible rect for culling structure sprites (reused per frame). */
  readonly swarmViewScratch: Float64Array;
  /** WS-9 (R2.30) — reused scratch for the selection screen-projection (#14). */
  readonly selScreenScratch: { x: number; y: number };
  /** `deathBlastFor` out (reused, #14). */
  readonly deathBlastScratch: DeathBlast;
  readonly explosionSprites: LegacyExplosionSprites;
  /** Phase 4 travel state: the camera the sky is drawn from (shifted by the
   *  trip's approach jump). */
  readonly skyCam: { center: { x: number; y: number }; scale: { x: number }; screenWidth: number; screenHeight: number };
  /** The sprite the camera follows this frame (null: spectator / script),
   *  and the speed-effects sample built from it (`speedFxSampleInto`). */
  speedFollowSprite: { readonly x: number; readonly y: number } | null;
  readonly speedFollowPose: { x: number; y: number };
  readonly speedSample: SpeedFxSample;
  serverGhost: Graphics | null;
  /** Tractor beams drawn last frame (salvage PR 11b, tractorBeams.ts). */
  tractorViewCount: number;
  /** Capital death blasts left to the wreck break-up (test hook). */
  hullBlastsReplaced: number;
  /** Wall-clock (performance.now) of the previous swarm-sprite update — the dt
   *  source for the structure mount slew (P3.8). 0 ⇒ first frame (one 60 Hz step). */
  lastSwarmUpdateNow: number;
  /** Wall-clock of the last `effects.tick` call. Used to derive dt for the
   *  next call. 0 ⇒ first frame (use a default 16.67 ms to seed). */
  lastEffectsTickNowMs: number;
  /** Scratch for `feedback.artReady` (see `writeFrameFeedback`). */
  artPendingSeen: boolean;
  /** The own-ship art handle already moved to the front of the bake queue. */
  prioritizedArtKey: string | null;
  readonly noteArtPending: (h: { state: string }) => void;
  /** Frames since the last art collection, and its reused in-use sets. */
  artCollectFrame: number;
  readonly artInUse: Set<ArtHandle>;
  readonly artShown: Set<object>;
}

/** Build the frame ctx once (renderer construction). */
export function createRendererFrameCtx(refs: RendererFrameRefs): RendererFrameCtx {
  const ctx: RendererFrameCtx = {
    r: refs,
    swarmViewScratch: new Float64Array(4),
    selScreenScratch: { x: 0, y: 0 },
    deathBlastScratch: { scale: 1, linger: 1, vaporise: false, tint: 0, seconds: 0 },
    explosionSprites: new LegacyExplosionSprites(),
    skyCam: { center: { x: 0, y: 0 }, scale: { x: 1 }, screenWidth: 0, screenHeight: 0 },
    speedFollowSprite: null,
    speedFollowPose: { x: 0, y: 0 },
    speedSample: newSpeedFxSample(),
    serverGhost: null,
    tractorViewCount: 0,
    hullBlastsReplaced: 0,
    lastSwarmUpdateNow: 0,
    lastEffectsTickNowMs: 0,
    artPendingSeen: false,
    prioritizedArtKey: null,
    // Bound once: no per-frame closure (#14).
    noteArtPending: (h: { state: string }): void => {
      if (h.state === 'pending') ctx.artPendingSeen = true;
    },
    artCollectFrame: 0,
    artInUse: new Set<ArtHandle>(),
    artShown: new Set<object>(),
  };
  return ctx;
}
