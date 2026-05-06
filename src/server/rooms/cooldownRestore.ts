/**
 * Limbo cooldown-restore policy.
 *
 * When a player resumes from Limbo (brief disconnect or sector transit), the
 * server has the option to restore the previous session's `lastFireClientTick`
 * so a player can't bypass the weapon cooldown by reconnecting. That works
 * fine for **same-room reconnect** because the source and destination
 * `serverTick` share a counter, so the resumed value is within a few ticks
 * of the new `welcome.serverTick`.
 *
 * For **cross-room sector transit** the rooms have independent `serverTick`
 * counters. A resumed `lastFireClientTick` from room A (e.g., 200_000) ends
 * up in room B (e.g., 6_814) and every new fire fails the cooldown check
 * `tick - lastFireCt < WEAPON_COOLDOWN_TICKS` because the client's new
 * `inputTick` starts from B's `serverTick` which is hugely smaller than the
 * resumed value. Symptom: "all my shots are rejected" — see `docs/LESSONS.md`
 * 2026-05-06 final entry.
 *
 * The fix: only honour the resumed cooldown when the value is **plausibly in
 * the same tick space** as the destination room.
 *
 * - Client `inputTick` is at most `serverTick + leadTicks (~6)`. A resumed
 *   value > `serverTick + 60` is impossible same-room and definitely
 *   cross-room. **Discard.**
 * - A resumed value > 600 ticks (10 s) behind `serverTick` is from a
 *   long-stale session whose cooldown has long since expired. **Discard**
 *   for cleanliness; equivalent to keeping it (the negative cooldown
 *   delta would pass the check anyway).
 * - Otherwise the resumed cooldown is meaningful; keep it.
 */

/** Max ticks a client `inputTick` can lead `serverTick` (`leadTicks` ~6 in
 *  prod, with safety margin). Beyond this, the resumed value is from a
 *  different tick space. */
export const COOLDOWN_FUTURE_GUARD_TICKS = 60;
/** Max ticks a resumed value can lag `serverTick` before we treat it as a
 *  long-stale session. ~10 s at 60 Hz. */
export const COOLDOWN_PAST_GUARD_TICKS = 600;

export function shouldHonourResumedCooldown(
  resumedLastFireTick: number,
  destinationServerTick: number,
): boolean {
  const delta = resumedLastFireTick - destinationServerTick;
  return delta >= -COOLDOWN_PAST_GUARD_TICKS && delta <= COOLDOWN_FUTURE_GUARD_TICKS;
}
