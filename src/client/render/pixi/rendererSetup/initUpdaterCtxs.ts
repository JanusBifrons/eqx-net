/**
 * `PixiRenderer.init` setup step: the pooled ctx objects for the per-frame
 * sprite updaters (ship, swarm, projectile, missile). Built once; `init`
 * assigns them to its fields. Bodies moved verbatim from `init`; the
 * renderer's own counters and late-bound effects are reached through the
 * deps callbacks / getters (read at call time, as before).
 */
import type { Container } from 'pixi.js';
import type { EffectsService } from '../../../effects/EffectsService.js';
import type { FxExplosions } from '../../art/fx/FxExplosions.js';
import type { ShipArtCtx } from '../../art/shipArtSprites.js';
import type { MountVisualManager } from '../../MountVisualManager.js';
import type { CutFieldLayer } from '../../field/CutFieldLayer.js';
import type { InterpolatedPose } from '../../../net/swarmInterpolation.js';
import { WreckGeometryStore } from '../../../net/wreckGeometryStore.js';
import { WreckArtState, wreckBlasts, wreckRippleCap, WRECK_BLAST_LINGER, type WreckBlast } from '../wreckArt.js';
import type { DyingHullHold } from '../dyingHullHold.js';
import type { ShipSpriteCtx } from '../shipSpriteUpdater.js';
import type { SpriteBuildSig, SwarmSpriteCtx } from '../swarmSpriteUpdater.js';
import type { ProjectileSpriteCtx } from '../projectileSpriteUpdater.js';
import type { MissileSpriteCtx } from '../missileSpriteUpdater.js';
import type { Graphics } from 'pixi.js';
import type { EffectQuality } from '@core/contracts/IEffects';

export interface SpriteUpdaterCtxDeps {
  shipContainer: Container;
  sprites: Map<string, Container>;
  mountVisuals: MountVisualManager;
  remoteHitTargets: Set<string>;
  localHitTargets: Set<string>;
  seenScratch: Set<string>;
  art: ShipArtCtx;
  swarmPoseScratch: InterpolatedPose;
  structureMountAngles: Map<string, number[]>;
  spriteKinds: Map<string, number>;
  spriteBuildSigs: Map<string, SpriteBuildSig>;
  fieldRocks: CutFieldLayer;
  dyingHulls: DyingHullHold;
  projectileSprites: Map<string, Graphics>;
  projSeenScratch: Set<string>;
  missileSprites: Map<number, Graphics>;
  missileSeenScratch: Set<number>;
  activeExplosions: MissileSpriteCtx['activeExplosions'];
  /** The live effects service / new explosions (set later in `init`). */
  effects: () => EffectsService | null;
  fxExplosions: () => FxExplosions | null;
  effectsQuality: () => EffectQuality;
  fxNow: () => number;
  wreckBlastScratch: WreckBlast[];
  /** The renderer's wreck counters (read by the probes). */
  noteWreckBreak: () => void;
  noteWreckBlastSpawned: () => void;
  noteWreckRippleSpawned: () => void;
}

export interface SpriteUpdaterCtxs {
  ship: ShipSpriteCtx;
  swarm: SwarmSpriteCtx;
  projectile: ProjectileSpriteCtx;
  missile: MissileSpriteCtx;
}

export function buildSpriteUpdaterCtxs(deps: SpriteUpdaterCtxDeps): SpriteUpdaterCtxs {
  // 2026-05-26 heap-growth gate step 12 — pool ctx objects for the
  // per-frame sprite updaters. All fields are permanent references;
  // initialised once here, mutated never. Object identity stable for
  // the renderer's lifetime. Eliminates ~180-270 obj/s of per-frame
  // ctx-literal allocation introduced by the god-file refactor.
  const ship: ShipSpriteCtx = {
    shipContainer: deps.shipContainer,
    sprites: deps.sprites,
    mountVisuals: deps.mountVisuals,
    remoteHitTargets: deps.remoteHitTargets,
    localHitTargets: deps.localHitTargets,
    seenScratch: deps.seenScratch,
    art: deps.art,
  };
  const swarm: SwarmSpriteCtx = {
    shipContainer: deps.shipContainer,
    sprites: deps.sprites,
    mountVisuals: deps.mountVisuals,
    swarmPoseScratch: deps.swarmPoseScratch,
    remoteHitTargets: deps.remoteHitTargets,
    localHitTargets: deps.localHitTargets,
    seenScratch: deps.seenScratch,
    structureMountAngles: deps.structureMountAngles,
    spriteKinds: deps.spriteKinds,
    spriteBuildSigs: deps.spriteBuildSigs,
    slewDtSec: 1 / 60, // overwritten per frame before updateSwarmSprites
    art: deps.art,
    // Capital destruction S2b: wreck piece geometry rebuilt from mirror.wrecks.
    wrecks: new WreckGeometryStore(),
    fieldRocks: deps.fieldRocks,
    // S3: each wreck's death clock; a fresh wreck's break-up (dust, shards,
    // flash at the kill point) goes through the effects system, tier-capped.
    wreckArt: new WreckArtState((x, y, radius, snap, seed, wfx, channel, cut) => {
      // Money-shot review: a short small core flash + dust + shards
      // (WreckBreakFx) and fireballs at the kill point, sized by the hull
      // (FxExplosions, the same blasts every death uses), never a disc
      // over the whole hull. Once per wreck, each part only where the
      // wreck's destruction profile asks for it (capitals: both; a
      // sub-capital never reaches here: its ship's own death blast plays).
      if (wfx.breakBurst) {
        deps.noteWreckBreak();
        // A weapon's kill cut: the shards are toned down (WreckBreakFx) so
        // the cut reads first (beam take 8 review: "confetti").
        deps.effects()?.spawnBurst('wreck-break', x, y, { radius, ...(snap ? { flashScale: 1.6 } : {}), ...(cut ? { cutKill: true } : {}) });
        // A railgun channel kill: glowing ash and sparks along the channel
        // (a line emitter on the same break-up pool, tier-capped there).
        if (channel !== null) {
          deps.effects()?.spawnBurst('wreck-ash', channel.ax, channel.ay, { radius, lineToX: channel.bx, lineToY: channel.by });
        }
      }
      const fx = wfx.killBlasts ? deps.fxExplosions() : null;
      if (fx !== null) {
        const n = wreckBlasts(x, y, radius, seed, deps.wreckBlastScratch);
        const now = deps.fxNow();
        for (let i = 0; i < n; i++) {
          const b = deps.wreckBlastScratch[i]!;
          if (fx.spawn(b.x, b.y, b.r, now, WRECK_BLAST_LINGER)) deps.noteWreckBlastSpawned();
        }
      }
    }, (x, y, r) => {
      // Cracks spread, then it breaks (owner 2026-11-13): small blasts
      // ripple along the cracks while the hull holds together. Pooled
      // FxExplosions bursts; how many per wreck follows the effects tier.
      if (deps.fxExplosions()?.spawn(x, y, r, deps.fxNow())) deps.noteWreckRippleSpawned();
    }, () => wreckRippleCap(deps.effectsQuality()), deps.effectsQuality),
    dyingHulls: deps.dyingHulls,
  };
  const projectile: ProjectileSpriteCtx = {
    shipContainer: deps.shipContainer,
    projectileSprites: deps.projectileSprites,
    projSeenScratch: deps.projSeenScratch,
  };
  const missile: MissileSpriteCtx = {
    shipContainer: deps.shipContainer,
    missileSprites: deps.missileSprites,
    missileSeenScratch: deps.missileSeenScratch,
    activeExplosions: deps.activeExplosions,
  };
  return { ship, swarm, projectile, missile };
}
