/**
 * Break-in rules (plan soft-leaping-truffle v3, phase C2). Shared so the
 * server's channel and the client's "Break in (≈ Ns)" label agree (#15).
 *
 * A pilot can break into cargo that doesn't open for them (another player's,
 * an NPC base's). It takes time, scaled by how much the target holds and its
 * level; it is a HOSTILE ACT from the first second (the owner's turrets turn
 * on you, the owner is alerted); and it ends if you leave range, take a hit,
 * or either side dies. Success opens the cargo to you for a short window.
 */

/** A small storage at level 1. */
export const BREAK_IN_BASE_MS = 10_000;
export const BREAK_IN_MAX_MS = 45_000;
/** How long the cargo stays open to you after a successful break-in. */
export const BREAK_IN_ACCESS_MS = 60_000;

/** Time to break into a structure with this hold capacity and level. */
export function breakInDurationMs(holdCapacity: number, level: number): number {
  const size = 1 + Math.max(0, holdCapacity) / 5000;
  const lvl = 1 + 0.25 * (Math.max(1, level) - 1);
  return Math.round(Math.min(BREAK_IN_MAX_MS, BREAK_IN_BASE_MS * size * lvl));
}
