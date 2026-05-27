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

/**
 * Refs the service needs from the renderer. Passed at construct so the
 * service stays Pixi-handle-free at the type level (`unknown` would be too
 * lossy; concrete Pixi types live where the renderer does).
 *
 * M1: shape only; M3 wires `warpChain` and the per-effect modules consume
 * the rest.
 */
export interface EffectStageRefs {
  /** Pixi v8 `Application`. Typed as unknown here; renderer narrows it. */
  app: unknown;
  /** World container — parent for entity-glued continuous emitters + shield rings. */
  world: unknown;
  /** Stage container — parent for one-shot filter overlays. */
  stage: unknown;
  /** Camera surface — distance-cull math reads `center` + screen size. */
  camera: unknown;
  /** Optional direct reference to `WarpFilterChain` so the budget can call
   *  its `applyQuality(level)` method on tier transitions (added in M3). */
  warpChain?: unknown;
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

  // M1 stores refs but doesn't yet touch them — per-effect modules in
  // M3-M8 will use them.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly refs: EffectStageRefs) {}

  // ── IParticleEffects ────────────────────────────────────────────────

  /**
   * M1 no-op. M4 (destruction), M7 (impact sparks) implement.
   */
  spawnBurst(
    _kind: ParticleBurstKind,
    _worldX: number,
    _worldY: number,
    _opts?: ParticleBurstOpts,
  ): void {
    // No-op until per-effect modules land.
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
  tick(_nowMs: number, dtMs: number): void {
    // M1: feed the budget a synthetic 1 ms rendererUpdateMs so the EMA
    // settles. Real value lands in M9 (PerfMonitor wiring).
    this.budget.sample({ rendererUpdateMs: 1, dtMs });
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
    this.counters.activeBursts = 0;
    this.counters.activeContinuous = 0;
    this.counters.activeFilters = 0;
  }

  // ── IFilterEffects ──────────────────────────────────────────────────

  triggerOneShotFilter(
    _kind: OneShotFilterKind,
    _worldX: number,
    _worldY: number,
  ): void {
    // No-op until M4 (destruction shock) / M8 (shield flash) land.
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
