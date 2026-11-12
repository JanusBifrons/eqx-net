/**
 * The automatic slowdown (time scale stream, Phase 5): a sector under load
 * slows ITSELF a little rather than stuttering. Per sector, pure, alloc-free.
 *
 * Inputs, once per telemetry window (~1 game second):
 *  - LATENESS: how far the sector's game time fell behind what real time
 *    allowed at its current speed (`latenessTicks / wallTicks`, step 1). This
 *    is the starved-host signal: ticks arrive late but cheap, so tick COST
 *    never saw it (docs/SHELF.md).
 *  - COST: the existing `SimulationClock` rate (0.7–1, from tick cost > 14 ms).
 *
 * Output: a load factor in [floor, 1]. The room's speed is the CHOSEN speed
 * (1×, or a forced demo/test speed) × this factor, so load only ever slows a
 * sector, and recovery returns to the chosen speed, never past it.
 *
 * Shape: slow FAST (straight to the speed the deficit implies), recover SLOWLY
 * (a small step after several calm windows), and hold in a dead band between
 * the two thresholds so the speed doesn't hunt.
 */

export interface LoadSpeedOptions {
  /** Lowest automatic factor (owner floor until there is data). */
  floor: number;
  /** Lateness fraction above which the sector slows. */
  slowAbove: number;
  /** Lateness fraction below which a window counts as calm. */
  calmBelow: number;
  /** Calm windows in a row before each recovery step. */
  recoverAfter: number;
  /** Factor added per recovery step. */
  recoverStep: number;
}

export const LOAD_SPEED_DEFAULTS: LoadSpeedOptions = {
  floor: 0.7,
  slowAbove: 0.05,
  calmBelow: 0.01,
  recoverAfter: 3,
  recoverStep: 0.05,
};

export class LoadSpeedController {
  /** The lateness-driven part of the factor, [floor, 1]. */
  private lateFactor = 1;
  private calm = 0;
  private readonly o: LoadSpeedOptions;

  constructor(opts: Partial<LoadSpeedOptions> = {}) {
    this.o = { ...LOAD_SPEED_DEFAULTS, ...opts };
  }

  /**
   * Feed one telemetry window. `latenessTicks` / `wallTicks` are the window's
   * game-time deficit and the ticks real time allowed AT THE CURRENT SPEED;
   * `costRate` is the cost signal (1 = healthy). Returns the load factor.
   */
  window(latenessTicks: number, wallTicks: number, costRate: number): number {
    const o = this.o;
    const late = wallTicks > 0 ? Math.max(0, latenessTicks) / wallTicks : 0;
    if (late > o.slowAbove) {
      // Fast: drop to the speed that would have kept up this window. Slowing
      // reduces the ticks real time asks for, so this converges, not spirals.
      this.lateFactor = Math.max(o.floor, Math.min(this.lateFactor, this.lateFactor * (1 - late)));
      this.calm = 0;
    } else if (late < o.calmBelow) {
      this.calm++;
      if (this.calm >= o.recoverAfter && this.lateFactor < 1) {
        this.lateFactor = Math.min(1, this.lateFactor + o.recoverStep);
        this.calm = 0;
      }
    } else {
      // Dead band: hold the speed (hysteresis).
      this.calm = 0;
    }
    return this.factor(costRate);
  }

  /** The load factor now: the slower of lateness and cost, never below the floor. */
  factor(costRate = 1): number {
    const c = Number.isFinite(costRate) ? costRate : 1;
    return Math.max(this.o.floor, Math.min(this.lateFactor, c));
  }
}
