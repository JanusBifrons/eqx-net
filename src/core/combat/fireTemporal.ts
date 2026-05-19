/**
 * Fire-claim temporal resolution (pure; `SectorRoom.handleFire` defers to
 * this — the `shouldDetachWarpVisual` precedent).
 *
 * Background: see `fireTemporal.test.ts` and diagnostic capture
 * `2026-05-19T11-22-22-628Z-uf0o8g`. The old temporal guard HARD-REJECTED
 * any fire whose claimed tick was older than `serverTick - lagCompWindow`.
 * After a client main-thread stall the wall-clock-anchored `inputTick`
 * falls behind `serverTick` and recovers slowly (capped catch-up), so a
 * long run of legitimate held-fires gets timestamped with stale ticks and
 * dropped (37% of fires in that capture). The shots are real — only the
 * timestamp is stale.
 */

/**
 * Resolve the SnapshotRing rewind tick for a fire claim. NEVER rejects:
 *
 *  - `claimedTick < serverTick - lagCompWindow` (stale — the bug): clamp
 *    UP to the window floor. The shot is lag-comp-resolved against the
 *    OLDEST available ring pose instead of being dropped. The rewind is
 *    bounded identically to a legitimate edge-of-window claim, so a
 *    client spamming ancient ticks gains no advantage and incurs no
 *    extra rewind cost. The per-shooter cooldown rate-limit is a
 *    SEPARATE check (raw client-tick spacing) and is unaffected.
 *  - `claimedTick >= serverTick - lagCompWindow` (in-window OR future):
 *    pass through unchanged. Future claims (client running ahead — the
 *    steady state under this prediction model) keep their existing
 *    behaviour: `SnapshotRing.getPoseAt(future)` misses and the caller
 *    falls back to the live pose cache, exactly as before this fix.
 *
 * The result is always in `[serverTick - lagCompWindow, max(serverTick,
 * claimedTick)]`, i.e. the rewind can never exceed `lagCompWindow` —
 * the same hard bound the reject used to enforce.
 */
export function clampFireTick(claimedTick: number, serverTick: number, lagCompWindow: number): number {
  const floor = serverTick - lagCompWindow;
  return claimedTick < floor ? floor : claimedTick;
}
