/**
 * Capital wreck timing shared by the server and the client
 * (docs/architecture/capital-destruction.md "Heavy break-up").
 *
 * When a capital dies its pieces spawn at once, but they stay together for
 * `WRECK_CRACK_MS` of GAME time: each piece moves with the dead hull (its
 * velocity v + ω × r, the hull's spin), so the hull holds its shape. Only
 * then does the server give the pieces their slow separating push and spin.
 * A client effect (the crack-and-ripple explosions before the split) reads
 * the same window from the wreck descriptor's `deathTick`:
 * the split happens at `deathTick + wreckCrackTicks()` server ticks.
 *
 * Game time, not wall time: the server counts it in fixed ticks, which run at
 * the sector's game speed (root invariant #20).
 */

/** Game milliseconds a dead capital holds together before its pieces part. */
export const WRECK_CRACK_MS = 1200;

/** Fixed simulation ticks per game second (`world.step(1/60)`, invariant #4). */
const TICKS_PER_SECOND = 60;

/** `WRECK_CRACK_MS` in server ticks (72 at 60 Hz). */
export function wreckCrackTicks(): number {
  return Math.round((WRECK_CRACK_MS * TICKS_PER_SECOND) / 1000);
}
