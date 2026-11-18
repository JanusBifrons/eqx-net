/**
 * Test / perf probes of the Pixi renderer — lifted out of `PixiRenderer`
 * (god-file split, Phase 4). Read only by DEV hooks, e2e specs and the perf
 * harness, never by gameplay. Each takes the renderer state it reads
 * (`RendererProbeState`, a getter view the renderer builds once), and
 * PixiRenderer keeps a one-line public delegate so callers are unchanged.
 * A new probe goes here, not inline in PixiRenderer.
 */

import type { Container } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { Camera } from '../worker/Camera';
import type { EffectsService } from '../../effects/EffectsService';
import type { MountVisualManager } from '../MountVisualManager';
import type { HelmCourseMarker } from '../helm/HelmCourseMarker.js';
import type { StarfieldBackground } from '../StarfieldBackground';
import type { Backdrop } from '../art/fx/Backdrop.js';
import type { FxBeams, FxProjectiles } from '../art/fx/FxWeapons.js';
import type { FxExplosions } from '../art/fx/FxExplosions.js';
import type { FxEngines } from '../art/fx/FxEngines.js';
import type { FxFences, FxShields } from '../art/fx/FxShields.js';
import { litPass } from '../art/litPass.js';
import { isMachinedSprite, type ShipArtCtx } from '../art/shipArtSprites.js';
import { probeIdentity } from '../shipRekey.js';
import { WreckPieceSprite } from './wreckArt.js';
import type { FarZoomIcons } from './FarZoomIcons';
import type { WarpFx } from './WarpFx.js';
import type { WarpSpoolFx } from './WarpSpoolFx.js';

/** The renderer state the probes read (live values: getters on the renderer). */
export interface RendererProbeState {
  readonly sprites: Map<string, Container>;
  readonly artCtx: ShipArtCtx;
  readonly swarmSpriteKinds: Map<string, number>;
  readonly mountVisuals: MountVisualManager;
  readonly camera: Camera;
  readonly starfield: StarfieldBackground | null;
  readonly backdrop: Backdrop | null;
  readonly effects: EffectsService | null;
  readonly engineDbgScratch: number[];
  readonly farIcons: FarZoomIcons;
  readonly warpFx: WarpFx;
  readonly spoolFx: WarpSpoolFx;
  readonly helmMarker: HelmCourseMarker;
  readonly lastMirror: RenderMirror | null;
  readonly fxEngines: FxEngines | null;
  readonly fxExplosions: FxExplosions | null;
  readonly fxProjectiles: FxProjectiles | null;
  readonly fxLiveBeams: FxBeams | null;
  readonly fxShields: FxShields | null;
  readonly fxShieldsOn: boolean;
  readonly fxFences: FxFences | null;
  readonly wreckBreaks: number;
  readonly wreckBlastsSpawned: number;
  readonly wreckRipplesSpawned: number;
  readonly hullBlastsReplaced: number;
  readonly shipRekeysApplied: number;
}

export interface BackdropStats { classicStars: boolean; motes: { near: number; fore: number } | null; deep: number; on: boolean; nebula: string | null; landmarks: number; sky: string; density: number; speed: number; speedZoom: number; speedLevel: string }

export type ArtStats = { mode: 'classic' | 'machined'; machinedSprites: number; classicShipSprites: number; backdrop: BackdropStats; fxProjectiles: number; fxWakes: number; fxBeam: boolean; fxExplosions: number; fxShields: number; fxFences: number; fxFenceHits: number; fxFenceContacts: number; fxEngines: number; engineParticles: number; turrets: number; turretShots: number; turretAim: ReturnType<MountVisualManager['aimProbe']>; lodDots: number; effectQuality: string; fxRibbons: number; localEngine: ReturnType<FxEngines['debugView']>; warpBursts: number; warpSpooling: number; spoolFxDrawn: number; ownArt: string | null; helmMarker: boolean; wreckPieces: number; wreckTextured: number; wreckGlowing: number; wreckBreaks: number; wreckEngines: number; wreckLit: number; wreckRawMaps: number; wreckFarLod: number; wreckBlasts: number; wreckRipples: number; hullBlastsReplaced: number; litMeshes: number } & Partial<ReturnType<NonNullable<ShipArtCtx['art']>['stats']>>;

export interface ShipVisualProbe { sprite: number | null; cluster: number | null; artHandle: number | null; rekeys: number }

/** DEV/E2E: what the backdrop is showing. */
export function backdropStats(r: RendererProbeState): BackdropStats {
  const b = r.backdrop;
  return { classicStars: r.starfield?.isVisible() === true, motes: b?.moteCounts() ?? null, deep: b?.deepSpace() ?? 0, on: b?.sky.visible === true, nebula: b?.nebulaKey() ?? null, landmarks: b?.visibleLandmarks ?? 0, sky: b?.skySignature ?? '', density: b?.density ?? 0,
    speed: b?.speed.sf ?? 0, speedZoom: r.camera.speedZoom(), speedLevel: b?.speedLevel ?? 'off' };
}

/**
 * Test-only (RTS Part A seamless hand-over): the identity of the ship drawn
 * under `key`: its sprite's and turret cluster's Pixi `uid`, its art handle's
 * probe id, and how many re-keys this renderer has applied. A spec reads it
 * before and after taking a ship's controls: the same numbers under the new
 * key mean nothing was rebuilt. Read by the `__eqxShipVisualProbe` DEV hook
 * (`?worker=0`). Not used by gameplay.
 */
export function shipVisualProbe(r: RendererProbeState, key: string): ShipVisualProbe {
  const sp = r.sprites.get(key);
  const cl = r.mountVisuals.clusterOf(key);
  const h = r.artCtx.handles.get(key);
  return {
    sprite: sp?.uid ?? null,
    cluster: cl?.uid ?? null,
    artHandle: h === undefined ? null : probeIdentity(h),
    rekeys: r.shipRekeysApplied,
  };
}

/** Machined art status: the service's counts plus how many ship sprites
 *  are drawing Machined vs today's look right now. */
export function artStats(r: RendererProbeState): ArtStats {
  let machined = 0, classic = 0;
  for (const [id, sp] of r.sprites) {
    if (isMachinedSprite(sp)) machined++;
    else if (!id.startsWith('swarm-') || r.artCtx.handles.has(id)) classic++;
  }
  // Capital destruction S2b: drawn wreck pieces (visible sprites of kind 4).
  // S3: textured pieces (parent art), pieces whose cut edges still glow,
  // and break-ups played.
  // wreckEngines: pieces drawing engine exhaust this frame. Must stay 0: a
  // piece wears the dead ship's art handle (nozzles and all), but a wreck
  // has no engines.
  let wreckPieces = 0, wreckTextured = 0, wreckGlowing = 0, wreckEngines = 0, wreckLit = 0, wreckRawMaps = 0, wreckFarLod = 0;
  for (const [id, k] of r.swarmSpriteKinds) {
    if (k !== 4) continue;
    if (r.fxEngines?.drew(id) === true) wreckEngines++;
    const sp = r.sprites.get(id);
    if (sp?.visible !== true) continue;
    wreckPieces++;
    if (sp instanceof WreckPieceSprite) {
      if (sp.art !== null) wreckTextured++;
      if (sp.glowAlpha() > 0) wreckGlowing++;
      if (sp.farZoom) wreckFarLod++;
      const am = sp.artMode();
      if (am === 'lit') wreckLit++;
      else if (am === 'raw-maps') wreckRawMaps++;
    }
  }
  const wreckBreaks = r.wreckBreaks;
  const art = r.artCtx.art;
  return { wreckPieces, wreckTextured, wreckGlowing, wreckBreaks, wreckEngines, wreckLit, wreckRawMaps, wreckFarLod, wreckBlasts: r.wreckBlastsSpawned, wreckRipples: r.wreckRipplesSpawned, hullBlastsReplaced: r.hullBlastsReplaced, litMeshes: litPass.settings ? litPass.count : -1, mode: art ? 'machined' : 'classic', machinedSprites: machined, classicShipSprites: classic, backdrop: backdropStats(r), fxProjectiles: r.fxProjectiles?.liveCount() ?? 0, fxWakes: r.fxProjectiles?.wakeCount() ?? 0, fxBeam: r.fxLiveBeams?.container.visible === true, fxExplosions: r.fxExplosions?.activeCount() ?? 0, fxShields: r.fxShieldsOn ? r.fxShields!.count() : -1, fxFences: r.fxFences?.count() ?? 0, fxFenceHits: r.fxFences?.hitCount ?? 0, fxFenceContacts: r.fxFences?.contactCount() ?? 0, fxEngines: r.fxEngines?.drawn() ?? -1, engineParticles: r.effects ? r.effects.debugCopyEngineParticleWorld(r.engineDbgScratch) : 0, turrets: r.mountVisuals.machinedGunCount(), turretShots: r.mountVisuals.turretShotCount(), turretAim: r.mountVisuals.aimProbe(), lodDots: r.farIcons.iconCount, effectQuality: r.effects?.getQuality() ?? 'none', fxRibbons: r.fxEngines?.ribbons() ?? -1, warpBursts: r.warpFx.burstCount(), warpSpooling: r.warpFx.spoolCount(), spoolFxDrawn: r.spoolFx.spooling, helmMarker: r.helmMarker.isVisible(), ownArt: r.lastMirror?.localPlayerId ? (r.artCtx.handles.get(r.lastMirror.localPlayerId)?.state ?? 'none') : null, localEngine: r.lastMirror?.localPlayerId ? (r.fxEngines?.debugView(r.lastMirror.localPlayerId) ?? null) : null, ...(art ? art.stats() : {}) };
}
