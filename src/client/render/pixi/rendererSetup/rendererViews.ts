/**
 * The renderer's getter views (input / camera deps, probe state, rekey refs,
 * frame refs, teardown refs) — lifted out of `PixiRenderer` (god-file split,
 * slice 11). The renderer builds ONE live getter view of its members,
 * `RendererViewHost`, first among its fields; each view below is built once
 * from it, at the field where the renderer built it before, so its plain
 * members are read at the same point as before and the rest stay getters.
 * Nothing here runs per frame (invariant #14); the getters allocate nothing.
 */
import type { Application, Container, RenderLayer } from 'pixi.js';
import type { GameClock } from '@core/clock/GameClock';
import type { RenderMirror, RendererFeedback } from '@core/contracts/IRenderer';
import type { Camera } from '../../worker/Camera';
import type { FrameMarkers } from '../../worker/protocol';
import type { GalaxyMapLayer } from '../../galaxy/GalaxyMapLayer';
import type { StarfieldBackground } from '../../StarfieldBackground';
import type { BeamView } from '../../BeamSpritePool';
import type { HaloRadar } from '../../HaloRadar';
import type { MountVisualManager } from '../../MountVisualManager';
import type { IncomingFireWarning } from '../../incoming/IncomingFireWarning.js';
import type { HelmCourseMarker } from '../../helm/HelmCourseMarker.js';
import type { CutFieldLayer } from '../../field/CutFieldLayer';
import type { ShipArtCtx } from '../../art/shipArtSprites.js';
import { rekeyShipVisuals, type ShipRekeyRefs } from '../../shipRekey.js';
import { shipSpriteKinds } from '../shipSpriteUpdater.js';
import type { FarZoomIcons } from '../FarZoomIcons';
import type { DyingHullHold } from '../dyingHullHold.js';
import type { HudDrainCtx } from '../hudDrainUpdater.js';
import type { HitEventCtx } from '../hitEventUpdater.js';
import type { LitSceneCtx } from '../litSceneUpdater.js';
import type { TurretShotCtx } from '../turretShotUpdater.js';
import type { WarpFxCtx } from '../warpFxUpdater.js';
import type { EngineShieldFxCtx } from '../engineShieldFxUpdater.js';
import type { PlacementGhostCtx } from '../placementGhostUpdater.js';
import type { RendererCameraDeps, RendererCameraDirector } from '../cameraDirector.js';
import type { RendererInputController } from '../rendererInputController.js';
import type { RendererInputDeps } from '../rendererCommandRouting.js';
import type { RendererFrameCtx, RendererFrameRefs } from '../frameCtx.js';
import { captureFleetRingProbe, type FleetRingProbeState, type RendererProbeState } from '../rendererProbes.js';
import type { RendererTeardownRefs } from './teardown.js';
import type { InitSceneHost, RendererInitState } from './initWiring.js';
import type { EffectsService } from '../../../effects/EffectsService';

/** The renderer's members, as one live getter view (`initialized` and
 *  `effects` and `shipRekeysApplied` are written back through setters). */
export interface RendererViewHost extends InitSceneHost {
  initialized: boolean;
  readonly app: Application;
  readonly world: Container;
  readonly camera: Camera;
  readonly starfield: StarfieldBackground | null;
  readonly galaxyLayer: GalaxyMapLayer | null;
  readonly spectator: boolean;
  readonly lockMarksVisible: boolean;
  readonly artStatsHook: (() => unknown) | null;
  shipRekeysApplied: number;
  readonly rekeyRefs: ShipRekeyRefs;
  readonly init: RendererInitState;
  readonly frame: RendererFrameCtx;
  readonly probes: RendererProbeState;
  readonly sprites: Map<string, Container>;
  readonly mountVisuals: MountVisualManager;
  readonly artCtx: ShipArtCtx;
  readonly engineDbgScratch: number[];
  readonly farIcons: FarZoomIcons;
  readonly warpFxCtx: WarpFxCtx;
  readonly helmMarker: HelmCourseMarker;
  readonly incomingFire: IncomingFireWarning;
  readonly halo: HaloRadar;
  readonly hitEventCtx: HitEventCtx;
  readonly litSceneCtx: LitSceneCtx;
  readonly turretShotCtx: TurretShotCtx;
  readonly engineShieldFxCtx: EngineShieldFxCtx;
  readonly placementGhostCtx: PlacementGhostCtx;
  readonly hudCtx: HudDrainCtx;
  readonly input: RendererInputController;
  readonly cameraDirector: RendererCameraDirector;
  readonly fleetRing: FleetRingProbeState;
  readonly feedback: RendererFeedback;
  readonly frameMarkers: FrameMarkers;
  readonly dyingHulls: DyingHullHold;
  readonly cutField: CutFieldLayer;
  readonly wreckFarLayer: RenderLayer;
  readonly fxClock: GameClock;
  readonly seenScratch: Set<string>;
  readonly remoteHitTargets: Set<string>;
  readonly localHitTargets: Set<string>;
  readonly tractorViews: BeamView[];
  readonly spriteShipKind: (id: string) => string | null | undefined;
  readonly forgetSprite: (id: string, held: boolean) => void;
  readonly rekeyShip: (from: string, to: string) => void;
  readonly fxNow: () => number;
}

/** Pointer / touch / wheel input deps (pixi/rendererInputController.ts). */
export function inputDepsView(h: RendererViewHost): RendererInputDeps {
  return {
    get camera() { return h.camera; }, get lastMirror(): RenderMirror | null { return h.lastMirror; }, get galaxyLayer() { return h.galaxyLayer; },
    get feedback() { return h.feedback; }, get selectionBracket() { return h.init.selectionBracket; }, get fleetOverlay() { return h.init.fleetOverlay; },
  };
}

/** The state the test / perf probes read (pixi/rendererProbes.ts). */
export function probeStateView(h: RendererViewHost): RendererProbeState {
  const s = h.init;
  return {
    get app() { return h.app; }, get sprites() { return h.sprites; }, get artCtx() { return h.artCtx; }, get swarmSpriteKinds() { return h.swarmSpriteKinds; },
    get mountVisuals() { return h.mountVisuals; }, get camera() { return h.camera; }, get starfield() { return h.starfield; },
    get backdrop() { return s.backdrop; }, get effects() { return h.effects; }, get engineDbgScratch() { return h.engineDbgScratch; },
    get farIcons() { return h.farIcons; }, get warpFx() { return h.warpFxCtx.warpFx; }, get spoolFx() { return h.warpFxCtx.spoolFx; },
    get helmMarker() { return h.helmMarker; }, get lastMirror() { return h.lastMirror; }, get fxEngines() { return s.fxEngines; },
    get fxExplosions() { return s.fxExplosions; }, get fxProjectiles() { return s.fxProjectiles; }, get fxLiveBeams() { return s.fxLiveBeams; },
    get fxShields() { return s.fxShields; }, get fxShieldsOn() { return h.hitEventCtx.fxShieldsOn; }, get fxFences() { return s.fxFences; },
    get wreckBreaks() { return s.wreckBreaks; }, get wreckBlastsSpawned() { return s.wreckBlastsSpawned; },
    get wreckRipplesSpawned() { return s.wreckRipplesSpawned; }, get hullBlastsReplaced() { return h.frame.hullBlastsReplaced; },
    get shipRekeysApplied() { return h.shipRekeysApplied; }, get selectionBracket() { return s.selectionBracket; }, get fleetRing() { return h.fleetRing; },
  };
}

/** What a ship re-key moves (shipRekey.ts `rekeyShipVisuals`). */
export function rekeyRefsView(h: RendererViewHost): ShipRekeyRefs {
  const s = h.init;
  return {
    get sprites() { return h.sprites; }, get artHandles() { return h.artCtx.handles; }, get mountVisuals() { return h.mountVisuals; },
    get healthBars() { return h.hudCtx.healthBars; }, get labels() { return s.labels; }, get farIcons() { return h.farIcons; },
    get fxEngines() { return s.fxEngines; }, get fxShields() { return s.fxShields; }, get input() { return h.input; }, forgetSprite: h.forgetSprite,
  };
}

/** Camera framing + cinematic director deps (pixi/cameraDirector.ts). */
export function cameraDepsView(h: RendererViewHost): RendererCameraDeps {
  return {
    get camera() { return h.camera; }, get lastMirror() { return h.lastMirror; }, get sprites() { return h.sprites; },
    get swarmSpriteKinds() { return h.swarmSpriteKinds; }, get spectator() { return h.spectator; },
    get initialized() { return h.initialized; }, get halo() { return h.halo; },
  };
}

/** The frame passes' and ticker's refs (pixi/frameCtx.ts). */
export function frameRefsView(h: RendererViewHost): RendererFrameRefs {
  const s = h.init;
  return {
    get app() { return h.app; }, get camera() { return h.camera; }, get world() { return h.world; },
    get shipContainer() { return s.shipContainer; }, get connectorRenderer() { return s.connectorRenderer; },
    get effects() { return h.effects; }, get fxExplosions() { return s.fxExplosions; }, get backdrop() { return s.backdrop; },
    get starfield() { return h.starfield; }, get backgroundGrid() { return s.backgroundGrid; }, get labels() { return s.labels; },
    get selectionBracket() { return s.selectionBracket; }, get hoverBracket() { return s.hoverBracket; },
    get aimFeedback() { return s.aimFeedback; }, get tractorBeamPool() { return s.tractorBeamPool; },
    get shipUpdaterCtx() { return s.shipUpdaterCtx; }, get swarmUpdaterCtx() { return s.swarmUpdaterCtx; },
    get projectileUpdaterCtx() { return s.projectileUpdaterCtx; }, get missileUpdaterCtx() { return s.missileUpdaterCtx; },
    get beamCtx() { return s.beamCtx; }, get spectator() { return h.spectator; }, get lockMarksVisible() { return h.lockMarksVisible; },
    get cleanWorld() { return s.cleanWorld; }, get beamsDisabled() { return s.beamsDisabled; }, get ringProbeOn() { return h.fleetRing.on; },
    get sectorKey() { return h.sectorKey; }, get artStatsHook() { return h.artStatsHook; }, get placementGhostCtx() { return h.placementGhostCtx; }, get halo() { return h.halo; },
    sprites: h.sprites, mountVisuals: h.mountVisuals, cameraDirector: h.cameraDirector, input: h.input,
    feedback: h.feedback, frameMarkers: h.frameMarkers, hudCtx: h.hudCtx, hitEventCtx: h.hitEventCtx,
    litSceneCtx: h.litSceneCtx, turretShotCtx: h.turretShotCtx, warpFxCtx: h.warpFxCtx, engineShieldFxCtx: h.engineShieldFxCtx,
    dyingHulls: h.dyingHulls, farIcons: h.farIcons, cutField: h.cutField, wreckFarLayer: h.wreckFarLayer,
    incomingFire: h.incomingFire, helmMarker: h.helmMarker, fxClock: h.fxClock, artCtx: h.artCtx,
    seenScratch: h.seenScratch, remoteHitTargets: h.remoteHitTargets, localHitTargets: h.localHitTargets,
    tractorViews: h.tractorViews, spriteShipKind: h.spriteShipKind, forgetSprite: h.forgetSprite, rekeyShip: h.rekeyShip,
    captureFleetRingProbe: () => captureFleetRingProbe(h.probes), fxNow: h.fxNow,
  };
}

/** The state teardown reads (pixi/rendererSetup/teardown.ts). `halo` is a
 *  getter: the renderer assigns it in its constructor body, after the field
 *  initialisers that build this view. */
export function teardownRefsView(h: RendererViewHost): RendererTeardownRefs {
  const s = h.init;
  return {
    get initialized() { return h.initialized; }, set initialized(v: boolean) { h.initialized = v; },
    get effects() { return h.effects; }, set effects(v: EffectsService | null) { h.effects = v; },
    get app() { return h.app; }, get curtain() { return s.curtain; }, get labels() { return s.labels; },
    get selectionBracket() { return s.selectionBracket; }, get hoverBracket() { return s.hoverBracket; }, get fleetOverlay() { return s.fleetOverlay; },
    get backgroundGrid() { return s.backgroundGrid; }, get starfield() { return h.starfield; }, get fxExplosions() { return s.fxExplosions; },
    get fxShields() { return s.fxShields; }, get fxFences() { return s.fxFences; }, get halo() { return h.halo; },
    artCtx: h.artCtx, engineShieldFxCtx: h.engineShieldFxCtx, input: h.input, hudCtx: h.hudCtx,
    mountVisuals: h.mountVisuals, incomingFire: h.incomingFire, helmMarker: h.helmMarker,
  };
}

/** The renderer's per-sprite callbacks (moved from `PixiRenderer`, god-file
 *  split slice 12), bound once over the view host: no per-frame closure (#14).
 *  Every member reads the host's live fields at call time. */
export interface RendererSpriteFns {
  readonly spriteShipKind: (id: string) => string | null | undefined;
  readonly forgetSprite: (id: string, held: boolean) => void;
  readonly rekeyShip: (from: string, to: string) => void;
  readonly fxShieldPose: (id: string, out: { x: number; y: number }) => boolean;
}

/** Built once by the renderer, before the ctxs that take its members. */
export function spriteFnsView(h: RendererViewHost): RendererSpriteFns {
  return {
    /** Sprite key → the ship kind it was built for (every ship, swarm).
     *  Bound once (no per-frame closure, #14). */
    spriteShipKind: (id: string): string | null | undefined => {
      const sp = h.sprites.get(id);
      if (sp !== undefined) return shipSpriteKinds.get(sp) ?? h.swarmSpriteSigs.get(id)?.shipKind;
      return undefined;
    },
    /** The sweep's per-id cleanup; `held` keeps the turret cluster on the
     *  still-drawn sprite. Bound once (#14). */
    forgetSprite: (id: string, held: boolean): void => {
      if (held) h.mountVisuals.detachShip(id);
      else h.mountVisuals.removeShip(id);
      h.structureMountSlew.delete(id); // P3.8 — drop slew state with the sprite
      h.swarmSpriteKinds.delete(id); // #20 — drop kind tracker with the sprite
      h.swarmSpriteSigs.delete(id); // campaign 3.2 — drop build signature with the sprite
      h.artCtx.handles.delete(id); // Machined art — drop the handle with the sprite
    },
    /** Bound once (#14): the per-pair step of `applyShipRekeys` (shipRekey.ts `rekeyShipVisuals`). */
    rekeyShip: (from: string, to: string): void => {
      if (rekeyShipVisuals(h.rekeyRefs, from, to)) h.shipRekeysApplied++;
    },
    /** Pixi-space pose of an entity's sprite, for the new shields. */
    fxShieldPose: (id: string, out: { x: number; y: number }): boolean => {
      const sp = h.sprites.get(id);
      if (!sp) return false;
      out.x = sp.x; out.y = sp.y;
      return true;
    },
  };
}
