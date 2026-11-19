/**
 * `PixiRenderer.init` wiring step: the FX kill switches, the pooled sprite
 * updater ctxs, the new weapon effects (`?fx=new`), the beam pools +
 * `EffectsService` and the pooled beam ctx — lifted out of `PixiRenderer`
 * (god-file split, slice 10). Bodies and call order moved verbatim.
 *
 * `RendererInitState` is the holder of what this step builds (and the
 * scratch that only feeds those ctxs): created once with the renderer, its
 * fields assigned here in `init`; the renderer's getter views (frame refs,
 * probes, teardown, rekey) read it live. The renderer's other members are
 * reached through its frame refs (`../frameCtx.ts`). Nothing here runs per
 * frame (invariant #14).
 */
import type { Container, Graphics, Texture } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { EffectQuality } from '@core/contracts/IEffects';
import type { FxBeams, FxProjectiles } from '../../art/fx/FxWeapons.js';
import type { FxExplosions, FxMissileTrails } from '../../art/fx/FxExplosions.js';
import type { FxEngines } from '../../art/fx/FxEngines.js';
import type { FxFences, FxShields } from '../../art/fx/FxShields.js';
import type { ArtOptions } from '../../art/artMode.js';
import type { ShipArtCtx } from '../../art/shipArtSprites.js';
import type { BeamSpritePool } from '../../BeamSpritePool.js';
import type { FxKillSwitches } from '../../fxKillSwitches.js';
import type { InterpolatedPose } from '../../../net/swarmInterpolation.js';
import { effectsDisabledByUrl, type EffectsService } from '../../../effects/EffectsService.js';
import type { EntityPose } from '../entityPoseFromSprite.js';
import type { WreckBlast } from '../wreckArt.js';
import type { ShipSpriteCtx } from '../shipSpriteUpdater.js';
import type { SpriteBuildSig, SwarmSpriteCtx } from '../swarmSpriteUpdater.js';
import type { ProjectileSpriteCtx } from '../projectileSpriteUpdater.js';
import type { MissileSpriteCtx } from '../missileSpriteUpdater.js';
import type { BeamCtx } from '../beamUpdater.js';
import type { HudDrainCtx } from '../hudDrainUpdater.js';
import type { RendererFrameRefs } from '../frameCtx.js';
import { buildSpriteUpdaterCtxs } from './initUpdaterCtxs.js';
import { buildFxWeapons, buildBeamPoolsAndEffects, buildBeamCtx } from './initFx.js';

/** What `init` builds for the sprite / beam / fx passes, plus the scratch
 *  that only feeds those ctxs. Built once with the renderer. */
export interface RendererInitState {
  // Phone-stall thermal-isolation switches. Read once at init via
  // `readFxKillSwitches`; gated at render-time call sites to attribute
  // GPU heat to specific subsystems (beams / damage numbers / health
  // bars). Same pattern as `filtersDisabled` / `particlesDisabled`.
  beamsDisabled: boolean;
  cleanWorld: boolean;
  readonly projectileSprites: Map<string, Graphics>;
  /** Per-missile sprites, keyed by stable per-sector missileId. Pooled
   *  via the missileSpriteUpdater's seen-set; one sprite per in-flight
   *  missile, destroyed when the missile leaves the mirror. */
  readonly missileSprites: Map<number, Graphics>;
  /** Active missile-detonation explosion sprites (short-lived). */
  readonly missileExplosionsActive: MissileSpriteCtx['activeExplosions'];
  /** Reused per-frame seen-set for the missile sprite updater. */
  readonly updateMissileSeenScratch: Set<number>;
  readonly updateProjSeenScratch: Set<string>;
  /** Reused per-frame so swarm interpolation doesn't allocate. */
  readonly swarmPoseScratch: InterpolatedPose;
  /** Reused scratch for the `getEntityPose` effects poll — mutated per call
   *  by `entityPoseFromSprite` (+ vx/vy filled from `_lastMirror`) so the
   *  per-frame engine/shield pose lookup allocates nothing (Invariant #14).
   *  Read synchronously inside the effects tick; never stored across frames. */
  readonly enginePoseScratch: EntityPose;
  /** Break-up fireballs' scratch. */
  readonly wreckBlastScratch: WreckBlast[];
  /** S3: wreck break-ups played (test hook via `artStats`). */
  wreckBreaks: number;
  /** Break-up fireballs drawn (test hook via `artStats`). */
  wreckBlastsSpawned: number;
  wreckRipplesSpawned: number;
  /** 2026-05-26 heap-growth gate step 12 — pooled per-frame ctx objects
   *  for the extracted sprite updaters. Pre-fix each `update()` call
   *  allocated 3 fresh ctx literals (8/7/3 fields) at 60-90 Hz =
   *  ~180-270 obj/s, triggering brief GC compaction in the 22-30 ms
   *  inter-RAF gap band. Every field references a permanent member
   *  (Container, Map, Set, MountVisualManager) — built once in `init`
   *  after `shipContainer` is assigned. */
  shipUpdaterCtx: ShipSpriteCtx;
  swarmUpdaterCtx: SwarmSpriteCtx;
  projectileUpdaterCtx: ProjectileSpriteCtx;
  missileUpdaterCtx: MissileSpriteCtx;
  /** Pooled remote / mining / live beam ctx (pixi/beamUpdater.ts), built once in init. */
  beamCtx: BeamCtx;
  /** New weapon effects (`?fx=new`, B3). */
  fxLiveBeams: FxBeams | null;
  fxRemoteBeams: FxBeams | null;
  fxProjectiles: FxProjectiles | null;
  /** New explosions + missile smoke (`?fx=new`, B4). */
  fxExplosions: FxExplosions | null;
  fxMissileTrails: FxMissileTrails | null;
  fxEngines: FxEngines | null;
  /** New shields + fences (`?fx=new`, B5). */
  fxShields: FxShields | null;
  fxFences: FxFences | null;
  // Post-2026-06-01: beams now rendered via sprite pools (no Graphics
  // clear/redraw cycle). The `liveBeamGfx` / `remoteBeamGfx` accessor
  // fields are kept as Container types — same surface LaserGlow uses
  // to attach filters. Pools own the actual sprite lifecycle.
  liveBeamGfx: Container | null;
  remoteBeamGfx: Container | null;
  liveBeamPool: BeamSpritePool | null;
  remoteBeamPool: BeamSpritePool | null;
  /** WS-4 Phase 4 (R2.27) — dedicated pool for the Miner's mining beam
   *  (`laser_fired` mountId `drill`). Separate from `remoteBeamPool` so it can
   *  be tinted as a distinct fat amber drill beam AND so an E2E can isolate its
   *  `liveCount` (the shared remote pool can't tell a drill beam from a combat
   *  laser). The faint always-on link hint stays in `ConnectorRenderer`. */
  miningBeamPool: BeamSpritePool | null;
  tractorBeamPool: BeamSpritePool | null;
  miningBeamGfx: Container | null;
}

/** The holder, empty until `init` (ctxs are assigned there before any read). */
export function createRendererInitState(): RendererInitState {
  return {
    beamsDisabled: false, cleanWorld: false,
    projectileSprites: new Map(), missileSprites: new Map(), missileExplosionsActive: [],
    updateMissileSeenScratch: new Set(), updateProjSeenScratch: new Set(),
    swarmPoseScratch: { x: 0, y: 0, angle: 0 }, enginePoseScratch: { x: 0, y: 0, angle: 0, vx: 0, vy: 0 },
    wreckBlastScratch: [], wreckBreaks: 0, wreckBlastsSpawned: 0, wreckRipplesSpawned: 0,
    shipUpdaterCtx: null!, swarmUpdaterCtx: null!, projectileUpdaterCtx: null!, missileUpdaterCtx: null!, beamCtx: null!,
    fxLiveBeams: null, fxRemoteBeams: null, fxProjectiles: null, fxExplosions: null,
    fxMissileTrails: null, fxEngines: null, fxShields: null, fxFences: null,
    liveBeamGfx: null, remoteBeamGfx: null, liveBeamPool: null, remoteBeamPool: null,
    miningBeamPool: null, tractorBeamPool: null, miningBeamGfx: null,
  };
}

/** The bisected FX kill switches, read once at init (beams + HUD drains). */
export function applyFxKillSwitches(s: RendererInitState, hudCtx: HudDrainCtx, fxKillSwitches: FxKillSwitches): void {
  s.beamsDisabled = fxKillSwitches.beamsDisabled;
  hudCtx.dmgNumbersDisabled = fxKillSwitches.dmgNumbersDisabled;
  hudCtx.selfDmgNumbersDisabled = fxKillSwitches.selfDmgNumbersDisabled;
  hudCtx.healthBarsDisabled = fxKillSwitches.healthBarsDisabled;
}

/** The renderer members the wiring needs beyond its frame refs. */
export interface InitWiringDeps {
  artOpts: ArtOptions;
  effectsQuality: () => EffectQuality;
  fxKillSwitches: FxKillSwitches;
  structureMountAngles: Map<string, number[]>;
  spriteKinds: Map<string, number>;
  spriteBuildSigs: Map<string, SpriteBuildSig>;
  fxShieldPose: (id: string, out: { x: number; y: number }) => boolean;
  lastMirror: () => RenderMirror | null;
}

/** The baked glow texture for impact sparks (null until baked). */
function fxGlowTexture(artCtx: ShipArtCtx): () => Texture | null {
  const h = artCtx.art!.fx('glow', undefined, undefined, false);
  return () => (h.state === 'ready' && h.fx ? h.fx.tex : null);
}

/** Sprite updater ctxs → new weapons → beam pools + effects → beam ctx, in
 *  that order. Returns the `EffectsService` it built (null under `?effects=0`). */
export function wireUpdatersAndFx(s: RendererInitState, r: RendererFrameRefs, deps: InitWiringDeps): EffectsService | null {
  const effectsQuality = deps.effectsQuality;
  const fxNow = r.fxNow;
  const ctxs = buildSpriteUpdaterCtxs({
    shipContainer: r.shipContainer, sprites: r.sprites, mountVisuals: r.mountVisuals,
    remoteHitTargets: r.remoteHitTargets, localHitTargets: r.localHitTargets,
    seenScratch: r.seenScratch, art: r.artCtx, swarmPoseScratch: s.swarmPoseScratch,
    structureMountAngles: deps.structureMountAngles, spriteKinds: deps.spriteKinds, spriteBuildSigs: deps.spriteBuildSigs,
    fieldRocks: r.cutField, dyingHulls: r.dyingHulls,
    projectileSprites: s.projectileSprites, projSeenScratch: s.updateProjSeenScratch,
    missileSprites: s.missileSprites, missileSeenScratch: s.updateMissileSeenScratch, activeExplosions: s.missileExplosionsActive,
    effects: () => r.effects, fxExplosions: () => s.fxExplosions, effectsQuality, fxNow, wreckBlastScratch: s.wreckBlastScratch,
    noteWreckBreak: () => { s.wreckBreaks++; },
    noteWreckBlastSpawned: () => { s.wreckBlastsSpawned++; },
    noteWreckRippleSpawned: () => { s.wreckRipplesSpawned++; },
  });
  s.shipUpdaterCtx = ctxs.ship;
  s.swarmUpdaterCtx = ctxs.swarm;
  s.projectileUpdaterCtx = ctxs.projectile;
  s.missileUpdaterCtx = ctxs.missile;
  // New weapons (B3, `?fx=new`): beam glow + flow over today's beam pools,
  // and bolts / tracers as batched sprites. Nothing draws until baked.
  if (deps.artOpts.fx === true && r.artCtx.art) {
    const fx = buildFxWeapons({
      art: r.artCtx.art, shipContainer: r.shipContainer, connectorRenderer: r.connectorRenderer, effectsQuality, fxNow,
      litSceneCtx: r.litSceneCtx, projectileUpdaterCtx: s.projectileUpdaterCtx, missileUpdaterCtx: s.missileUpdaterCtx,
      engineShieldFxCtx: r.engineShieldFxCtx, turretShotCtx: r.turretShotCtx, hitEventCtx: r.hitEventCtx,
    });
    s.fxLiveBeams = fx.liveBeams; s.fxRemoteBeams = fx.remoteBeams; s.fxProjectiles = fx.projectiles;
    s.fxExplosions = fx.explosions; s.fxMissileTrails = fx.missileTrails; s.fxEngines = fx.engines;
    s.fxShields = fx.shields; s.fxFences = fx.fences;
  }

  // Effects subsystem (plan `wiggly-puppy` M3+). Constructed inside
  // PixiRenderer.init so the same single seam serves both the worker
  // path (this whole file runs inside the renderer worker) AND the
  // main-thread fallback (touch devices, Safari < 17). ?effects=0 URL
  // hatch skips construction entirely.
  let effects: EffectsService | null = null;
  if (!effectsDisabledByUrl()) {
    const fx = buildBeamPoolsAndEffects({
      app: r.app, world: r.world, camera: r.camera, shipContainer: r.shipContainer,
      fxGlowTexture: deps.artOpts.fx === true && r.artCtx.art ? () => fxGlowTexture(r.artCtx) : null,
      sprites: r.sprites, enginePoseScratch: s.enginePoseScratch, lastMirror: deps.lastMirror, fxKillSwitches: deps.fxKillSwitches,
    });
    s.liveBeamPool = fx.liveBeamPool; s.liveBeamGfx = fx.liveBeamGfx;
    s.remoteBeamPool = fx.remoteBeamPool; s.remoteBeamGfx = fx.remoteBeamGfx;
    s.miningBeamPool = fx.miningBeamPool; s.miningBeamGfx = fx.miningBeamGfx;
    s.tractorBeamPool = fx.tractorBeamPool;
    effects = fx.effects;
  }

  s.beamCtx = buildBeamCtx({ // stacks the beams over the hulls (rendererSetup/initFx.ts)
    beamsDisabled: s.beamsDisabled, fxNow,
    remoteBeamPool: s.remoteBeamPool, remoteBeamGfx: s.remoteBeamGfx,
    miningBeamPool: s.miningBeamPool, miningBeamGfx: s.miningBeamGfx,
    liveBeamPool: s.liveBeamPool, liveBeamGfx: s.liveBeamGfx,
    fxRemoteBeams: s.fxRemoteBeams, fxLiveBeams: s.fxLiveBeams,
    fxShields: s.fxShields, fxFences: s.fxFences, fxShieldPose: deps.fxShieldPose,
    swarmPoseScratch: s.swarmPoseScratch, feedback: r.feedback,
    shipContainer: r.shipContainer, tractorBeamPool: s.tractorBeamPool, fxExplosions: s.fxExplosions, litSceneCtx: r.litSceneCtx,
  });
  return effects;
}
