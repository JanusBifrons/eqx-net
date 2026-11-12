/**
 * Game time: the ONE time source for gameplay and presentation (game time
 * scale stream, Phase 2; design docs/architecture/game-time-scale.md).
 *
 * Game time runs at `scale` × real time, 0.25× to 4×. The scale lives ONLY
 * here: every gameplay timer, cooldown and effect reads `now()` (or
 * schedules with `after` / `every`) and follows the speed with no code of
 * its own. Real time (persistence flushes, networking, UI) keeps the wall
 * clock and is the lint-listed exception.
 *
 * `now()` is continuous: a speed change re-anchors, so game time never jumps.
 * At scale 1 it equals the wall clock it was built over (offset 0), so code
 * that moves from `Date.now()` to a `GameClock` over `Date.now` behaves
 * exactly as before.
 *
 * Pure: the wall source and the timer host are injected (DI, invariant #5).
 */
import type { Clock } from './Clock.js';

export const MIN_TIME_SCALE = 0.25;
export const MAX_TIME_SCALE = 4;

export function clampTimeScale(s: number): number {
  if (!Number.isFinite(s)) return 1;
  return Math.min(MAX_TIME_SCALE, Math.max(MIN_TIME_SCALE, s));
}

/** The host's real timers (Node and browsers both fit). */
export interface TimerHost {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** A timer on game time. `cancel()` is idempotent. */
export interface GameTimer {
  cancel(): void;
}

interface Pending {
  fn: () => void;
  /** Game ms at which it fires. */
  dueAt: number;
  /** Game ms between repeats; 0 = one-shot. */
  periodMs: number;
  handle: unknown;
  live: boolean;
  timer: GameTimer;
}

export class GameClock implements Clock {
  private _scale = 1;
  /** True until the first speed change: `now()` is then the wall clock itself. */
  private exact = true;
  private anchorWall: number;
  private anchorGame: number;
  private readonly pending = new Set<Pending>();
  private readonly listeners = new Set<(scale: number) => void>();

  constructor(
    private readonly wall: () => number,
    private readonly host: TimerHost | null = null,
  ) {
    this.anchorWall = wall();
    this.anchorGame = this.anchorWall;
  }

  /** Current game time, ms. */
  now(): number {
    // Exact at 1× until the first speed change: `a + (b − a)` is not always
    // exactly `b` in floating point, and 1× must be byte-identical.
    if (this.exact) return this.wall();
    return this.anchorGame + (this.wall() - this.anchorWall) * this._scale;
  }

  /** Game time at a given WALL time (e.g. a RAF timestamp). Exact at 1× until
   *  the first speed change. */
  at(wallMs: number): number {
    if (this.exact) return wallMs;
    return this.anchorGame + (wallMs - this.anchorWall) * this._scale;
  }

  get scale(): number { return this._scale; }

  /** Change the speed (clamped to 0.25–4×). Game time stays continuous, and
   *  every pending game timer is re-armed for the new speed. */
  setScale(s: number): void {
    const next = clampTimeScale(s);
    if (next === this._scale) return;
    const wallNow = this.wall();
    this.anchorGame = this.anchorGame + (wallNow - this.anchorWall) * this._scale;
    this.anchorWall = wallNow;
    this.exact = false;
    this._scale = next;
    for (const p of this.pending) this.arm(p);
    for (const l of this.listeners) l(next);
  }

  /** Called on every speed change (e.g. to tell a physics worker). */
  onScaleChange(fn: (scale: number) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Run `fn` once after `ms` of GAME time. */
  after(ms: number, fn: () => void): GameTimer {
    return this.schedule(fn, Math.max(0, ms), 0);
  }

  /** Run `fn` every `ms` of GAME time (like `setInterval`). */
  every(ms: number, fn: () => void): GameTimer {
    const period = Math.max(1, ms);
    return this.schedule(fn, period, period);
  }

  /** Cancel every pending timer (room dispose, test teardown). */
  cancelAll(): void {
    for (const p of [...this.pending]) p.timer.cancel();
  }

  private schedule(fn: () => void, delayMs: number, periodMs: number): GameTimer {
    if (!this.host) throw new Error('GameClock: timers need a TimerHost');
    const p: Pending = {
      fn, dueAt: this.now() + delayMs, periodMs, handle: undefined, live: true,
      timer: { cancel: () => this.cancel(p) },
    };
    this.pending.add(p);
    this.arm(p);
    return p.timer;
  }

  private cancel(p: Pending): void {
    if (!p.live) return;
    p.live = false;
    this.pending.delete(p);
    if (p.handle !== undefined) this.host!.clearTimeout(p.handle);
    p.handle = undefined;
  }

  /** (Re)arm a real timer for the game time left at the current speed. */
  private arm(p: Pending): void {
    const host = this.host!;
    if (p.handle !== undefined) host.clearTimeout(p.handle);
    const wallDelay = Math.max(0, (p.dueAt - this.now()) / this._scale);
    p.handle = host.setTimeout(() => this.fire(p), wallDelay);
  }

  private fire(p: Pending): void {
    if (!p.live) return;
    p.handle = undefined;
    if (p.periodMs > 0) {
      // Next due from the scheduled time, not from now, so a repeat never
      // drifts; a long stall fires once and skips ahead (no burst).
      p.dueAt += p.periodMs;
      const now = this.now();
      if (p.dueAt <= now) p.dueAt = now + p.periodMs;
      this.arm(p);
    } else {
      p.live = false;
      this.pending.delete(p);
    }
    p.fn();
  }
}
