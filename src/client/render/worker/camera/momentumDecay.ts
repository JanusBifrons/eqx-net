/**
 * Exponential velocity decay for camera momentum (coast-after-release).
 *
 * State carrier — not a pure function, because the velocity persists
 * across frames. Camera.tick() calls `step()` once per frame while
 * no pointer is active; pointerdown calls `seed()` or `clear()` to
 * reset.
 */

export interface MomentumOptions {
  /** Per-tick decay multiplier. 1 = infinite coast; 0 = instant stop. Default 0.9. */
  decelFactor: number;
  /** Below this magnitude (px/tick) momentum stops entirely. Default 0.1. */
  epsilon: number;
}

export class MomentumDecay {
  private vx = 0;
  private vy = 0;

  constructor(private readonly opts: MomentumOptions) {}

  /** Seed the velocity from the most recent pointer-move delta. */
  seed(dx: number, dy: number): void {
    this.vx = dx;
    this.vy = dy;
  }

  /** Stop momentum instantly (used on pointerdown / cancel). */
  clear(): void {
    this.vx = 0;
    this.vy = 0;
  }

  /** Read-only velocity (test/diagnostic). */
  velocity(): { vx: number; vy: number } {
    return { vx: this.vx, vy: this.vy };
  }

  /** True while velocity magnitude is above the epsilon floor. */
  isAlive(): boolean {
    return Math.abs(this.vx) > this.opts.epsilon || Math.abs(this.vy) > this.opts.epsilon;
  }

  /**
   * Apply one decay step. Mutates `target` by adding the current
   * velocity, then decays the stored velocity. When velocity drops
   * below epsilon both components clamp to 0 (avoids endless ε tail).
   */
  step(target: { x: number; y: number }): void {
    if (this.isAlive()) {
      target.x += this.vx;
      target.y += this.vy;
      this.vx *= this.opts.decelFactor;
      this.vy *= this.opts.decelFactor;
    } else {
      this.vx = 0;
      this.vy = 0;
    }
  }
}
