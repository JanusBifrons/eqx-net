/**
 * `PixiRenderer.init` setup steps for the effects: the new weapon /
 * explosion / engine / shield effects (`?fx=new`) and the beam sprite
 * pools + `EffectsService`. Each step takes a narrow deps object and
 * returns what it built; `init` assigns the results to its fields in the
 * same order as before (bodies moved verbatim).
 */
import type { Application, Container, Texture } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { EffectQuality } from '@core/contracts/IEffects';
import type { Camera } from '../../worker/Camera.js';
import type { ArtService } from '../../art/ArtService.js';
import { FxBeams, FxProjectiles } from '../../art/fx/FxWeapons.js';
import { FxExplosions, FxMissileTrails } from '../../art/fx/FxExplosions.js';
import { FxEngines } from '../../art/fx/FxEngines.js';
import { FxFences, FxShields } from '../../art/fx/FxShields.js';
import type { ConnectorRenderer } from '../ConnectorRenderer.js';
import type { ProjectileSpriteCtx } from '../projectileSpriteUpdater.js';
import type { MissileSpriteCtx } from '../missileSpriteUpdater.js';
import type { EngineShieldFxCtx } from '../engineShieldFxUpdater.js';
import type { TurretShotCtx } from '../turretShotUpdater.js';
import type { HitEventCtx } from '../hitEventUpdater.js';
import { noteBlastLight, type LitSceneCtx } from '../litSceneUpdater.js';
import { entityPoseFromSprite, type EntityPose } from '../entityPoseFromSprite.js';
import { BeamSpritePool } from '../../BeamSpritePool.js';
import { REMOTE_BEAM_STYLE, LIVE_BEAM_STYLE, TRACTOR_BEAM_STYLE, MINING_BEAM_STYLE } from '../../beamStyles.js';
import { EffectsService } from '../../../effects/EffectsService.js';
import type { FxKillSwitches } from '../../fxKillSwitches.js';

export interface FxWeaponDeps {
  art: ArtService;
  shipContainer: Container;
  connectorRenderer: ConnectorRenderer;
  effectsQuality: () => EffectQuality;
  fxNow: () => number;
  litSceneCtx: LitSceneCtx;
  projectileUpdaterCtx: ProjectileSpriteCtx;
  missileUpdaterCtx: MissileSpriteCtx;
  engineShieldFxCtx: EngineShieldFxCtx;
  turretShotCtx: TurretShotCtx;
  hitEventCtx: HitEventCtx;
}

export interface FxWeapons {
  liveBeams: FxBeams;
  remoteBeams: FxBeams;
  projectiles: FxProjectiles;
  explosions: FxExplosions;
  missileTrails: FxMissileTrails;
  engines: FxEngines;
  shields: FxShields;
  fences: FxFences;
}

/** New weapons (B3), explosions (B4), engines and shields / fences (B5),
 *  added to the ship container and wired into the updater ctxs. */
export function buildFxWeapons(deps: FxWeaponDeps): FxWeapons {
  const art = deps.art;
  const liveBeams = new FxBeams(art, 0x6fd0ff);
  const remoteBeams = new FxBeams(art, 0xffaa44);
  // Railgun slug wakes read the effects tier and the game-time fx clock (#20).
  const projectiles = new FxProjectiles(art, deps.effectsQuality, deps.fxNow);
  deps.shipContainer.addChild(remoteBeams.container, liveBeams.container, projectiles.wakeLayer, projectiles.container);
  deps.projectileUpdaterCtx.fx = projectiles;
  // B4: explosions (ship / drone / structure deaths, missile detonations)
  // and missile smoke trails.
  const explosions = new FxExplosions(art, deps.effectsQuality);
  explosions.onSpawn = (x, y, r): void => noteBlastLight(deps.litSceneCtx, x, y, r);
  const missileTrails = new FxMissileTrails(art);
  deps.shipContainer.addChild(missileTrails.smokeLayer, explosions.smokeLayer, missileTrails.glowLayer, explosions.fireLayer);
  deps.missileUpdaterCtx.fxTrails = missileTrails;
  // Engine exhaust: a flame + ribbon at every Machined nozzle, for every
  // ship (players and drones). Under the hulls; ship sprites are added later.
  const engines = new FxEngines(art, deps.effectsQuality);
  deps.shipContainer.addChild(engines.trailLayer, engines.flameLayer, engines.glowLayer);
  deps.engineShieldFxCtx.fxEngines = engines;
  deps.missileUpdaterCtx.fxExplosions = deps.turretShotCtx.fxExplosions = explosions;
  // B5: shields (invisible at rest; hit ripples, held laser contacts,
  // break) and fences (energy line, raise / power-loss / gate).
  const shields = new FxShields(art);
  deps.engineShieldFxCtx.fxShields = deps.hitEventCtx.fxShields = shields;
  const fences = new FxFences(art);
  deps.shipContainer.addChild(shields.container);
  // Fences sit just above the connector web, below the sprites.
  deps.shipContainer.addChildAt(fences.container, deps.shipContainer.getChildIndex(deps.connectorRenderer.gfx) + 1);
  deps.connectorRenderer.fxFences = deps.hitEventCtx.fxFences = fences;
  return { liveBeams, remoteBeams, projectiles, explosions, missileTrails, engines, shields, fences };
}

export interface EffectsDeps {
  app: Application;
  world: Container;
  camera: Camera;
  shipContainer: Container;
  /** `?fx=new` glow texture for impact sparks (called only when present). */
  fxGlowTexture: (() => () => Texture | null) | null;
  sprites: Map<string, Container>;
  enginePoseScratch: EntityPose;
  lastMirror: () => RenderMirror | null;
  fxKillSwitches: FxKillSwitches;
}

export interface BeamPoolsAndEffects {
  liveBeamPool: BeamSpritePool;
  liveBeamGfx: Container;
  remoteBeamPool: BeamSpritePool;
  remoteBeamGfx: Container;
  miningBeamPool: BeamSpritePool;
  miningBeamGfx: Container;
  tractorBeamPool: BeamSpritePool;
  effects: EffectsService;
}

/** The beam sprite pools and the effects subsystem (skipped by `?effects=0`
 *  at the call site). */
export function buildBeamPoolsAndEffects(deps: EffectsDeps): BeamPoolsAndEffects {
  // Eagerly create the beam sprite pools (post-2026-06-01 — was
  // Pixi Graphics). Each pool's Container is exposed as
  // `liveBeamGfx` / `remoteBeamGfx` so LaserGlow can attach a
  // GlowFilter to it at construct time. Empty pools render as
  // nothing — no visual change before first beam.
  const liveBeamPool = new BeamSpritePool(LIVE_BEAM_STYLE);
  const liveBeamGfx = liveBeamPool.container;
  deps.shipContainer.addChild(liveBeamGfx, liveBeamPool.styledContainer); // heavy beams: unfiltered sibling
  const remoteBeamPool = new BeamSpritePool(REMOTE_BEAM_STYLE);
  const remoteBeamGfx = remoteBeamPool.container;
  deps.shipContainer.addChild(remoteBeamGfx, remoteBeamPool.styledContainer); // heavy beams: unfiltered sibling
  // WS-4 Phase 4 — the Miner's mining beam: a distinct fat warm-amber drill
  // beam, separate pool so its `liveCount` is isolatable + its look differs
  // from the combat laser. Styles are named consts (beamStyles.ts) so the
  // distinction is greppable + regression-locked. Sits behind the sprites.
  const miningBeamPool = new BeamSpritePool(MINING_BEAM_STYLE);
  const miningBeamGfx = miningBeamPool.container;
  deps.shipContainer.addChild(miningBeamGfx);
  const tractorBeamPool = new BeamSpritePool(TRACTOR_BEAM_STYLE); deps.shipContainer.addChild(tractorBeamPool.container, tractorBeamPool.styledContainer); // look A (beamStyles.ts)

  const effects = new EffectsService({
    app: deps.app,
    world: deps.world,
    stage: deps.app.stage,
    camera: deps.camera,
    ...(deps.fxGlowTexture ? { fxGlow: deps.fxGlowTexture() } : {}),
    // Per-frame pose lookup. Reads the RENDERED sprite position so
    // it stays in lockstep with whatever frame the engine emitter
    // ticks on (one-pose-per-frame invariant for drones too — the
    // sprite was just set from the resolved swarm pose by
    // updateSwarmSprites). Returns null for entities not in the
    // sprite map (despawned, never spawned, off-interest).
    getEntityPose: (entityId: string) => {
      // Every ship (parked hulls too, RTS Part A S3) + drones live in
      // `sprites`, so a parked hull's shield aura resolves its pose
      // (P3.12 / WS-C3: the "lingering ships don't draw a shield" bug).
      const sp = deps.sprites.get(entityId);
      if (!sp) return null;
      // Pure seam helper: converts the Pixi sprite pose BACK to game
      // space (Y-up, angle un-negated). Mutates the reused scratch so
      // the per-frame poll allocates nothing (Invariant #14); the
      // emitter reads it synchronously and never stores it.
      const pose = entityPoseFromSprite(sp, deps.enginePoseScratch);
      // Velocity for speed-scaled emission + coherent streaming. The
      // sprite carries no velocity; read it from this frame's mirror.
      // Ships only (drones live in mirror.swarm and don't emit engine
      // particles) → undefined for non-ships ⇒ 0.
      const ship = deps.lastMirror()?.ships.get(entityId);
      pose.vx = ship?.vx ?? 0;
      pose.vy = ship?.vy ?? 0;
      return pose;
    },
    beams: { liveBeamGfx, remoteBeamGfx },
    fxKillSwitches: deps.fxKillSwitches,
  });
  return { liveBeamPool, liveBeamGfx, remoteBeamPool, remoteBeamGfx, miningBeamPool, miningBeamGfx, tractorBeamPool, effects };
}
