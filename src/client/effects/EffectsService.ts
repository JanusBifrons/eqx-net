/**
 * `EffectsService` — the single client-side seam for visual effects.
 *
 * Plan: `~/.claude/plans/i-d-like-you-to-wiggly-puppy.md`.
 *
 * Implements `IParticleEffects + IFilterEffects + IEffectsBudget`.
 *
 * Construction: instantiated INSIDE `PixiRenderer.init` (one construction
 * site per renderer instance, works in BOTH the worker and main-thread
 * fallback paths). `ColyseusClient` never imports this — it pushes onto
 * `RenderMirror.pendingEffectTriggers` (added in M2) and the renderer
 * drains it during `update(mirror)`.
 *
 * M1 ships the no-op skeleton. M4-M8 fill in the per-effect modules; M9
 * wires the budget + per-effect quality dials.
 */

import {
  type EffectQuality,
  type IEffects,
  type ParticleBurstKind,
  type ParticleBurstOpts,
  type ContinuousEffectKind,
  type OneShotFilterKind,
} from '@core/contracts/IEffects';
import { EffectsBudget } from './EffectsBudget';
import { DestructionFx } from './perEffect/DestructionFx';
import { buildDestructionFactories } from './perEffect/destructionFactories';
import { EngineEmitter, type EnginePoseFn } from './perEffect/EngineEmitter';
import { buildEngineFactories } from './perEffect/engineFactories';
import { LaserGlow, type LaserGlowBeams } from './perEffect/LaserGlow';
import { buildLaserGlowFactories } from './perEffect/laserGlowFactories';
import type { Application, Container } from 'pixi.js';

/**
 * Refs the service needs from the renderer. Passed at construct so the
 * service stays Pixi-handle-free at the type level (`unknown` would be too
 * lossy; concrete Pixi types live where the renderer does).
 *
 * M1: shape only; M3 wires `warpChain` and the per-effect modules consume
 * the rest.
 */
export interface EffectStageRefs {
  /** Pixi v8 `Application`. Used by one-shot filters that attach to app.stage. */
  app: Application;
  /** World container — parent for entity-glued continuous emitters + shield rings. */
  world: Container;
  /** Stage container — parent for one-shot filter overlays. */
  stage: Container;
  /** Camera surface — distance-cull math reads `center` + screen size. */
  camera: unknown;
  /** Optional direct reference to `WarpFilterChain` so the budget can call
   *  its `applyQuality(level)` method on tier transitions (added in M3). */
  warpChain?: { applyQuality: (level: EffectQuality) => void };
  /** Per-frame ship-pose lookup (game-space, Y-up — emitter Y-flips on
   *  write). Returns null if the entity is not in any mirror map. Used
   *  by EngineEmitter to position trails at the ship's stern each tick.
   *  Callee polls inside `tick`; pose is NEVER stored between frames. */
  getEntityPose?: EnginePoseFn;
  /** Optional beam Graphics for M6 laser glow. When present, `LaserGlow`
   *  is constructed and attaches one `GlowFilter` per beam (live + remote).
   *  Absent in tests / probe pages that don't render beams. */
  beams?: LaserGlowBeams;
}

interface ContinuousEntry {
  kind: ContinuousEffectKind;
  active: boolean;
}

export class EffectsService implements IEffects {
  private readonly budget = new EffectsBudget();
  /** Per-entity continuous effects, keyed by `${entityId}:${kind}`. */
  private readonly continuous = new Map<string, ContinuousEntry>();
  /** Counters fed to the budget every frame. */
  private readonly counters = { activeBursts: 0, activeContinuous: 0, activeFilters: 0 };
  /** Reusable stats object so getStats() doesn't allocate per call. */
  private readonly statsScratch = { activeBursts: 0, activeContinuous: 0, activeFilters: 0, quality: 'high' as import('@core/contracts/IEffects').EffectQuality };

  private readonly destruction: DestructionFx;
  private readonly engines: EngineEmitter;
  private readonly laserGlow: LaserGlow | null;
  /** Tier currently applied to per-effect modules — updated each tick
   *  when getQuality changes so M3 (warp) + M6 (laser glow) propagate. */
  private lastAppliedTier: EffectQuality = 'high';
  /** Last frame's wall-clock `now` — used to derive `dtSec` for per-effect ticks. */
  private lastTickNowMs = 0;

  constructor(private readonly refs: EffectStageRefs) {
    // Per-effect modules constructed eagerly so their pools are pre-warm.
    // World container hosts entity-glued effects (M4 destruction particles
    // sit here too — they're world-space, not screen-space).
    this.destruction = new DestructionFx(
      refs.world,
      refs.app,
      () => this.getQuality(),
      buildDestructionFactories(),
    );
    this.engines = new EngineEmitter(
      refs.world,
      () => this.getQuality(),
      buildEngineFactories(),
    );
    this.laserGlow = refs.beams
      ? new LaserGlow(refs.beams, buildLaserGlowFactories())
      : null;
  }

  // ── IParticleEffects ────────────────────────────────────────────────

  /**
   * M4 (destruction): routes through `DestructionFx`. Other kinds remain
   * no-ops until M7 (impact sparks) etc. land.
   */
  spawnBurst(
    kind: ParticleBurstKind,
    worldX: number,
    worldY: number,
    opts?: ParticleBurstOpts,
  ): void {
    if (kind === 'destruction') {
      this.destruction.spawnBurst(worldX, worldY, opts);
    }
    // 'impact', 'shield-hit', 'warp-arrive' — wired in later milestones.
    this.refreshCounters();
  }

  /**
   * M1 records the entry so the test surface can observe it; M5 (engines)
   * + M8 (shields) attach real Pixi visuals.
   */
  setContinuous(entityId: string, kind: ContinuousEffectKind, active: boolean): void {
    const key = `${entityId}:${kind}`;
    const prev = this.continuous.get(key);
    if (prev?.active === active) return; // re-entrant: no-op on identical state
    if (active) {
      this.continuous.set(key, { kind, active });
    } else {
      this.continuous.delete(key);
    }
    // Dispatch to the per-effect manager.
    if (kind === 'thrust' || kind === 'boost') {
      this.engines.setActive(entityId, kind, active);
    }
    // 'shield' wired in M8.
    this.counters.activeContinuous = this.continuous.size;
  }

  /**
   * Per-frame poll. M1 only updates the budget. M3+ also advances per-effect
   * managers (engine emitter, shield breathe, in-flight bursts).
   *
   * MUST be called inside `PixiRenderer.update(mirror)` at the tail, AFTER
   * `updateSwarmSprites` — guarantees one-pose-per-frame (the rule at
   * `src/client/CLAUDE.md` "Drones are PURE snapshot-interpolated"
   * section). Never call from a separate Pixi ticker.
   */
  tick(nowMs: number, dtMs: number): void {
    // Feed the budget. M9 will replace the synthetic 1 ms with the
    // real `frameMarkers.rendererUpdateMs` reading.
    this.budget.sample({ rendererUpdateMs: 1, dtMs });

    // Propagate tier-change to per-effect dials (warp via warpChain
    // applyQuality, laser glow via LaserGlow.applyQuality). Only fires
    // on actual tier transition — both applyQuality methods are
    // idempotent but the != check saves the call overhead.
    const tier = this.getQuality();
    if (tier !== this.lastAppliedTier) {
      this.lastAppliedTier = tier;
      this.refs.warpChain?.applyQuality(tier);
      this.laserGlow?.applyQuality(tier);
    }

    const dtSec = dtMs / 1000;
    this.destruction.tick(dtSec);
    if (this.refs.getEntityPose) {
      this.engines.tick(dtSec, this.refs.getEntityPose);
    }
    this.lastTickNowMs = nowMs;

    this.refreshCounters();
  }

  /** Refresh the counters fed to the budget. Called after every spawn /
   *  tick so `getStats()` reflects reality without per-call allocation. */
  private refreshCounters(): void {
    const d = this.destruction.activeCount();
    const e = this.engines.activeCount();
    this.counters.activeBursts = d.bursts + e.particles;
    this.counters.activeFilters = d.filters;
    this.counters.activeContinuous = this.continuous.size;
    this.budget.recordCounts(this.counters);
  }

  /**
   * Called from `ColyseusClient.resetPredictionState()` on sector handoff.
   * Wipes per-entity continuous emitters + in-flight bursts to prevent
   * dead-entity-id leakage across sectors. M1 just clears the map; M5+
   * also destroys the live Pixi handles.
   */
  resetForSectorHandoff(): void {
    this.continuous.clear();
    this.destruction.resetForSectorHandoff();
    this.engines.resetForSectorHandoff();
    this.counters.activeBursts = 0;
    this.counters.activeContinuous = 0;
    this.counters.activeFilters = 0;
  }

  // ── IFilterEffects ──────────────────────────────────────────────────

  triggerOneShotFilter(
    kind: OneShotFilterKind,
    worldX: number,
    worldY: number,
  ): void {
    if (kind === 'destruction-shock') {
      this.destruction.spawnShockOnly(worldX, worldY);
      this.refreshCounters();
    }
    // 'shield-flash' wired in M8.
  }

  // ── IEffectsBudget ──────────────────────────────────────────────────

  setQuality(level: EffectQuality): void {
    this.budget.setQuality(level);
  }

  getQuality(): EffectQuality {
    return this.budget.getQuality();
  }

  getStats(): { activeBursts: number; activeContinuous: number; activeFilters: number; quality: EffectQuality } {
    this.statsScratch.activeBursts = this.counters.activeBursts;
    this.statsScratch.activeContinuous = this.counters.activeContinuous;
    this.statsScratch.activeFilters = this.counters.activeFilters;
    this.statsScratch.quality = this.budget.getQuality();
    return this.statsScratch;
  }
}

/**
 * URL-based escape hatch. Returning `null` skips `EffectsService`
 * construction entirely (the renderer falls back to today's inline
 * Graphics paths for destruction + flames). Mirrors `?worker=0` at
 * `src/client/CLAUDE.md` "Touch devices DEFAULT to main-thread" note.
 */
export function effectsDisabledByUrl(): boolean {
  if (typeof globalThis === 'undefined') return false;
  // Worker contexts have no `window.location` but main-thread does.
  // `location` is also defined inside dedicated workers via `self.location`.
  const loc = (globalThis as { location?: { search?: string } }).location;
  if (!loc?.search) return false;
  return /\beffects=0\b/.test(loc.search);
}
