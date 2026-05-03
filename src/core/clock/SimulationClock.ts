/**
 * SimulationClock — the Phase 6 "Temporal Anomaly" safety valve.
 *
 * Owned by the server. The worker reads the resulting rate via SAB and scales
 * its accumulator input (NOT Rapier's integration_parameters.dt — see the
 * Phase 6 plan for why that distinction matters: scaling the accumulator
 * preserves deterministic per-step physics; scaling Rapier's dt would change
 * collision behaviour.)
 *
 * Rule: rate ramps toward FLOOR when totalMs > OVER_BUDGET_MS for WINDOW_TICKS
 * consecutive ticks; ramps back toward 1.0 when under-budget for the same
 * window. Ramp speed is RAMP_PER_TICK per tick. The 30-tick hysteresis
 * dominates the ±0.005 ramp step, so spawn/despawn storms cannot oscillate
 * the rate.
 *
 * Pure: no I/O, no time source. Determinism is the contract — tests drive it
 * synthetically.
 */
import type { Bus } from '../events/Bus.js';

export const TIDI_FLOOR = 0.7;
export const TIDI_CEIL = 1.0;
export const OVER_BUDGET_MS = 14;
export const WINDOW_TICKS = 30;
export const RAMP_PER_TICK = 0.005;
/** Bus emit epsilon — only emit TIDI_RATE_CHANGED when rate moves at least this much. */
export const EMIT_EPSILON = RAMP_PER_TICK - 1e-9;

export class SimulationClock {
  private _rate = TIDI_CEIL;
  private _targetRate = TIDI_CEIL;
  private consecutiveOver = 0;
  private consecutiveUnder = 0;
  private lastEmittedRate = TIDI_CEIL;

  constructor(private readonly bus?: Bus) {}

  get rate(): number {
    return this._rate;
  }

  get targetRate(): number {
    return this._targetRate;
  }

  /**
   * Report the wall-clock duration of the most recent server tick. Adjusts
   * the target rate after WINDOW_TICKS of consecutive over/under, and steps
   * the live rate toward the target by RAMP_PER_TICK.
   */
  report(tickMs: number): void {
    if (tickMs > OVER_BUDGET_MS) {
      this.consecutiveOver += 1;
      this.consecutiveUnder = 0;
      if (this.consecutiveOver >= WINDOW_TICKS) {
        this._targetRate = TIDI_FLOOR;
      }
    } else {
      this.consecutiveUnder += 1;
      this.consecutiveOver = 0;
      if (this.consecutiveUnder >= WINDOW_TICKS) {
        this._targetRate = TIDI_CEIL;
      }
    }

    if (this._rate < this._targetRate) {
      this._rate = Math.min(this._targetRate, this._rate + RAMP_PER_TICK);
    } else if (this._rate > this._targetRate) {
      this._rate = Math.max(this._targetRate, this._rate - RAMP_PER_TICK);
    }

    if (Math.abs(this._rate - this.lastEmittedRate) >= EMIT_EPSILON) {
      this.lastEmittedRate = this._rate;
      this.bus?.emit('TIDI_RATE_CHANGED', { type: 'TIDI_RATE_CHANGED', rate: this._rate });
    }
  }
}
