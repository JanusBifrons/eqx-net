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
import { EngineEmitter, type EnginePoseFn, type EngineProfileInput } from './perEffect/EngineEmitter';
import { buildEngineFactories } from './perEffect/engineFactories';
import { LaserGlow, type LaserGlowBeams } from './perEffect/LaserGlow';
import { buildLaserGlowFactories } from './perEffect/laserGlowFactories';
import { ImpactSparks } from './perEffect/ImpactSparks';
import { buildImpactFactories } from './perEffect/impactFactories';
import { ShieldAura } from './perEffect/ShieldAura';
import { buildShieldFactories } from './perEffect/shieldFactories';
import type { FxKillSwitches } from '../render/fxKillSwitches';
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
  /** Bisected FX kill switches (plan: melodic-engelbart, Step 2) — when
   *  `filtersDisabled` is true, LaserGlow / ShieldAura / DestructionFx skip
   *  every GPU-filter attach; when `particlesDisabled` is true, the
   *  particle emitters (engines, impact sparks, destruction particles)
   *  skip every spawn. Both default to false (today's behaviour). */
  fxKillSwitches?: FxKillSwitches;
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
  private readonly impactSparks: ImpactSparks;
  private readonly shieldAura: ShieldAura;
  /** Tier currently applied to per-effect modules — updated each tick
   *  when getQuality changes so M3 (warp) + M6 (laser glow) + M8 (shield
   *  aura) propagate. Initialised to 'minimal' (sentinel — ALWAYS
   *  differs from the budget's default 'high') so the first tick fires
   *  the tier-change branch and lazily constructs the per-effect filters
   *  that touch DOM (ShieldAura's GlowFilter, LaserGlow's GlowFilter
   *  when present). Test environments override quality before tick(),
   *  keeping the lazy filter construction skipped. */
  private lastAppliedTier: EffectQuality = 'minimal';
  /** Last frame's wall-clock `now` — used to derive `dtSec` for per-effect ticks. */
  private lastTickNowMs = 0;

  constructor(private readonly refs: EffectStageRefs) {
    // Per-effect modules constructed eagerly so their pools are pre-warm.
    // World container hosts entity-glued effects (M4 destruction particles
    // sit here too — they're world-space, not screen-space).
    const filtersDisabled = refs.fxKillSwitches?.filtersDisabled === true;
    const particlesDisabled = refs.fxKillSwitches?.particlesDisabled === true;
    this.destruction = new DestructionFx(
      refs.world,
      refs.app,
      () => this.getQuality(),
      buildDestructionFactories(),
      { filtersDisabled, particlesDisabled },
    );
    this.engines = new EngineEmitter(
      refs.world,
      () => this.getQuality(),
      buildEngineFactories(),
      { particlesDisabled },
    );
    this.laserGlow = refs.beams
      ? new LaserGlow(refs.beams, buildLaserGlowFactories(), { filtersDisabled })
      : null;
    this.impactSparks = new ImpactSparks(
      refs.world,
      () => this.getQuality(),
      buildImpactFactories(),
      { particlesDisabled },
    );
    this.shieldAura = new ShieldAura(
      refs.world,
      () => this.getQuality(),
      buildShieldFactories(),
      { filtersDisabled },
    );
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
    } else if (kind === 'impact' || kind === 'shield-hit') {
      // 'shield-hit' shares the ImpactSparks visual at M7 — caller passes
      // a cyan/white tint to distinguish. M8 may layer a dedicated shield
      // pulse on top.
      this.impactSparks.spawnBurst(worldX, worldY, opts);
    }
    // 'warp-arrive' — wired in M8 / M11.
    this.refreshCounters();
  }

  /**
   * M1 records the entry so the test surface can observe it; M5 (engines)
   * + M8 (shields) attach real Pixi visuals.
   */
  setContinuous(
    entityId: string,
    kind: ContinuousEffectKind,
    active: boolean,
    radius?: number,
    engine?: EngineProfileInput,
  ): void {
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
      // `engine` carries the per-kind nozzle offset + plume scale (computed
      // by the renderer from the ship catalogue). `radius` stays shield-only.
      this.engines.setActive(entityId, kind, active, engine);
    } else if (kind === 'shield') {
      // Threading `radius` through is what makes the visible shield aura
      // match the physics ball collider per-kind. Without it, ShieldAura
      // falls back to `DEFAULT_RADIUS=28` for every entity — a heavy
      // (kind.radius=16) gets the same aura as a scout (kind.radius=10).
      // PixiRenderer reads from `mirror.ships.get(id).kind` / swarm equivalent.
      this.shieldAura.setActive(entityId, active, radius);
    }
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
  tick(nowMs: number, dtMs: number, rendererUpdateMs?: number): void {
    // M9 (plan wiggly-puppy): feed the budget the real per-frame Pixi
    // cost when the caller knows it (PixiRenderer passes its frame
    // markers value), otherwise fall back to a small synthetic value so
    // tests that don't supply a metric don't trigger spurious downshifts.
    this.budget.sample({ rendererUpdateMs: rendererUpdateMs ?? 1, dtMs });

    // Propagate tier-change to per-effect dials (warp via warpChain
    // applyQuality, laser glow via LaserGlow.applyQuality, shield aura
    // attach/detach). Only fires on actual tier transition.
    const tier = this.getQuality();
    if (tier !== this.lastAppliedTier) {
      this.lastAppliedTier = tier;
      this.refs.warpChain?.applyQuality(tier);
      this.laserGlow?.applyQuality(tier);
      this.shieldAura.applyQuality(tier);
    }

    const dtSec = dtMs / 1000;
    this.destruction.tick(dtSec);
    this.impactSparks.tick(dtSec);
    if (this.refs.getEntityPose) {
      this.engines.tick(dtSec, this.refs.getEntityPose);
      this.shieldAura.tick(dtMs, this.refs.getEntityPose);
    }
    this.lastTickNowMs = nowMs;

    this.refreshCounters();
  }

  /** Refresh the counters fed to the budget. Called after every spawn /
   *  tick so `getStats()` reflects reality without per-call allocation. */
  private refreshCounters(): void {
    const d = this.destruction.activeCount();
    const e = this.engines.activeCount();
    const s = this.impactSparks.activeCount();
    this.counters.activeBursts = d.bursts + e.particles + s;
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
    this.impactSparks.resetForSectorHandoff();
    this.shieldAura.resetForSectorHandoff();
    this.counters.activeBursts = 0;
    this.counters.activeContinuous = 0;
    this.counters.activeFilters = 0;
  }

  pulseShield(entityId: string): void {
    this.shieldAura.pulse(entityId);
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
