/**
 * The server's game clock: ONE per process, so the whole galaxy runs at one
 * speed (owner decision, docs/architecture/game-time-scale.md).
 *
 * Gameplay code reads `gameNow()` instead of `Date.now()`, and schedules with
 * `gameClock.after` / `gameClock.every` instead of `setTimeout` /
 * `setInterval`. It is built over `Date.now`, so at 1× every value is exactly
 * the old one. Real-time work (persistence, networking, auth, diagnostics)
 * keeps the wall clock; the lint rule's allowlist names those files.
 */
import { GameClock, type TimerHost } from '../../core/clock/GameClock.js';

// Wall-clock access lives here, the one place the server's game time is
// built from real time.
const nodeTimers: TimerHost = {
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    // A game timer never keeps the process alive on its own (shutdown).
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export const gameClock = new GameClock(() => Date.now(), nodeTimers);

/** Current game time in ms (epoch-based; equals `Date.now()` at 1×). */
export function gameNow(): number {
  return gameClock.now();
}

export type { GameTimer } from '../../core/clock/GameClock.js';
import type { GameTimer } from '../../core/clock/GameClock.js';

/** `setTimeout` on game time (fires after `ms` of GAME time). Unref'd. */
export function gameSetTimeout(fn: () => void, ms: number): GameTimer {
  return gameClock.after(ms, fn);
}

/** `setInterval` on game time. Unref'd. */
export function gameSetInterval(fn: () => void, ms: number): GameTimer {
  return gameClock.every(ms, fn);
}

/** `clearTimeout` / `clearInterval` for game timers (null-safe). */
export function gameClearTimer(t: GameTimer | null | undefined): void {
  t?.cancel();
}

/**
 * A SECTOR's game clock (game speed is per sector). Each `SectorRoom` owns one:
 * its gameplay, subsystems and timers follow that sector's speed. The process
 * clock above stays for cross-sector world time (directors, economy, convoys,
 * wallets, holds). Both start equal to `Date.now()`; at 1× they never diverge.
 */
export function createSectorClock(): GameClock {
  return new GameClock(() => Date.now(), nodeTimers);
}
