/**
 * `EffectsBudget` — passive quality-tier policy for the effects subsystem.
 *
 * Plan: `~/.claude/plans/i-d-like-you-to-wiggly-puppy.md` §"Throttle/budget
 * policy".
 *
 * Pure module (no Pixi, no DOM, no React, no Zustand). Lives client-side
 * because the budget is renderer-instance scoped, but has no rendering
 * dependencies — fully unit-testable.
 *
 * Inputs (per frame, EMA-smoothed):
 *   - rendererUpdateMs   (worker-local from frameMarkers)
 *   - rafGapMs           (main-thread observed; pushed via setQuality only
 *                         on tier transition — never per-frame)
 *
 * State transitions use AND-gates on (threshold crossed AND held for the
 * dwell ms). Recovery thresholds are 2 ms lower than the downshift trigger
 * and require a 3x-longer hold to prevent flicker between tiers.
 *
 * The budget keeps two independently-resolved tiers:
 *   - localTier:  computed from the metrics it sees directly
 *   - pushedTier: set by setQuality() from the main-thread PerfMonitor
 * and exposes `pickMoreRestrictive(localTier, pushedTier)` as `getQuality()`.
 * This way the worker can downshift immediately on its own metrics, and the
 * main thread can override DOWN (never up) on tail-latency stalls it sees
 * that the worker cannot.
 */

import {
  type EffectQuality,
  pickMoreRestrictiveQuality,
} from '@core/contracts/IEffects';

export interface BudgetSample {
  /** Worker-side per-frame Pixi cost in ms. */
  rendererUpdateMs: number;
  /** Wall-clock elapsed since last tick in ms (drives EMA cadence). */
  dtMs: number;
}

/** Thresholds — exported so unit tests + future tuning land in one place. */
export const BUDGET_THRESHOLDS = {
  /** EMA alpha — ~16 samples at 60 Hz = ~270 ms response. */
  emaAlpha: 0.06,
  /** Cold-start: until we've taken N samples, hold at `high`. */
  warmupSamples: 8,
  /** Downshift triggers: rendererUpdateMs > N for ≥ holdMs to transition. */
  high_to_medium: { ms: 6, holdMs: 500 },
  medium_to_low: { ms: 8, holdMs: 500 },
  low_to_minimal: { ms: 9, holdMs: 250 },
  /** Upshift triggers: 2 ms lower AND 3× hold. */
  minimal_to_low: { ms: 7, holdMs: 750 },
  low_to_medium: { ms: 6, holdMs: 1500 },
  medium_to_high: { ms: 4, holdMs: 1500 },
} as const;

interface BudgetCounters {
  activeBursts: number;
  activeContinuous: number;
  activeFilters: number;
}

export class EffectsBudget {
  /** Exponential moving average of `rendererUpdateMs`. NaN until warmup. */
  private emaRendererMs = NaN;
  /** Number of samples taken since construction. Drives warmup. */
  private samples = 0;
  /** Wall-clock ms the current threshold-crossing has been held. */
  private dwellMs = 0;
  /** Direction of the dwell-tracker: 'up' = wants downshift, 'down' = wants upshift. */
  private dwellDir: 'up' | 'down' | 'none' = 'none';
  /** Locally-resolved tier from the budget's own metrics. */
  private localTier: EffectQuality = 'high';
  /** Externally-pushed tier (main-thread PerfMonitor via setQuality). */
  private pushedTier: EffectQuality = 'high';
  /** Reusable counters object so getStats() doesn't allocate. */
  private readonly statsScratch: BudgetCounters & { quality: EffectQuality } = {
    activeBursts: 0,
    activeContinuous: 0,
    activeFilters: 0,
    quality: 'high',
  };

  /** Called by `EffectsService.tick` each frame. */
  sample(s: BudgetSample): void {
    this.samples++;
    if (Number.isNaN(this.emaRendererMs)) {
      this.emaRendererMs = s.rendererUpdateMs;
    } else {
      this.emaRendererMs += BUDGET_THRESHOLDS.emaAlpha * (s.rendererUpdateMs - this.emaRendererMs);
    }
    if (this.samples < BUDGET_THRESHOLDS.warmupSamples) return;

    const ema = this.emaRendererMs;
    const targetDir = this.computeDirection(ema);

    if (targetDir !== this.dwellDir) {
      this.dwellDir = targetDir;
      this.dwellMs = s.dtMs;
    } else {
      this.dwellMs += s.dtMs;
    }

    if (targetDir === 'up' && this.shouldDownshift(ema, this.dwellMs)) {
      this.localTier = this.nextLower(this.localTier);
      this.dwellMs = 0;
    } else if (targetDir === 'down' && this.shouldUpshift(ema, this.dwellMs)) {
      this.localTier = this.nextHigher(this.localTier);
      this.dwellMs = 0;
    }
  }

  /** External push (from main-thread PerfMonitor on tier transition). */
  setQuality(level: EffectQuality): void {
    this.pushedTier = level;
  }

  /** Effective quality for this frame — the more restrictive of local + pushed. */
  getQuality(): EffectQuality {
    return pickMoreRestrictiveQuality(this.localTier, this.pushedTier);
  }

  /** Update active-effect counters (called by EffectsService when bursts /
   *  continuous / filter counts change). Mutates in place to avoid allocation. */
  recordCounts(active: BudgetCounters): void {
    this.statsScratch.activeBursts = active.activeBursts;
    this.statsScratch.activeContinuous = active.activeContinuous;
    this.statsScratch.activeFilters = active.activeFilters;
  }

  getStats(): BudgetCounters & { quality: EffectQuality } {
    this.statsScratch.quality = this.getQuality();
    return this.statsScratch;
  }

  /** Test surface — read the locally-resolved tier separately from `getQuality()`. */
  getLocalTier(): EffectQuality {
    return this.localTier;
  }

  /** Test surface — current EMA value. NaN until first sample. */
  getEmaMs(): number {
    return this.emaRendererMs;
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private computeDirection(ema: number): 'up' | 'down' | 'none' {
    // 'up' = pressure rising (wants downshift to a lower tier).
    // 'down' = pressure falling (wants upshift to a higher tier).
    switch (this.localTier) {
      case 'high':
        return ema > BUDGET_THRESHOLDS.high_to_medium.ms ? 'up' : 'none';
      case 'medium':
        if (ema > BUDGET_THRESHOLDS.medium_to_low.ms) return 'up';
        if (ema < BUDGET_THRESHOLDS.medium_to_high.ms) return 'down';
        return 'none';
      case 'low':
        if (ema > BUDGET_THRESHOLDS.low_to_minimal.ms) return 'up';
        if (ema < BUDGET_THRESHOLDS.low_to_medium.ms) return 'down';
        return 'none';
      case 'minimal':
        return ema < BUDGET_THRESHOLDS.minimal_to_low.ms ? 'down' : 'none';
    }
  }

  private shouldDownshift(ema: number, dwell: number): boolean {
    switch (this.localTier) {
      case 'high':
        return ema > BUDGET_THRESHOLDS.high_to_medium.ms && dwell >= BUDGET_THRESHOLDS.high_to_medium.holdMs;
      case 'medium':
        return ema > BUDGET_THRESHOLDS.medium_to_low.ms && dwell >= BUDGET_THRESHOLDS.medium_to_low.holdMs;
      case 'low':
        return ema > BUDGET_THRESHOLDS.low_to_minimal.ms && dwell >= BUDGET_THRESHOLDS.low_to_minimal.holdMs;
      case 'minimal':
        return false;
    }
  }

  private shouldUpshift(ema: number, dwell: number): boolean {
    switch (this.localTier) {
      case 'minimal':
        return ema < BUDGET_THRESHOLDS.minimal_to_low.ms && dwell >= BUDGET_THRESHOLDS.minimal_to_low.holdMs;
      case 'low':
        return ema < BUDGET_THRESHOLDS.low_to_medium.ms && dwell >= BUDGET_THRESHOLDS.low_to_medium.holdMs;
      case 'medium':
        return ema < BUDGET_THRESHOLDS.medium_to_high.ms && dwell >= BUDGET_THRESHOLDS.medium_to_high.holdMs;
      case 'high':
        return false;
    }
  }

  private nextLower(t: EffectQuality): EffectQuality {
    return t === 'high' ? 'medium' : t === 'medium' ? 'low' : t === 'low' ? 'minimal' : 'minimal';
  }

  private nextHigher(t: EffectQuality): EffectQuality {
    return t === 'minimal' ? 'low' : t === 'low' ? 'medium' : t === 'medium' ? 'high' : 'high';
  }
}
