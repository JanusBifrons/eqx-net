/**
 * Per-shooter weapon cooldown rate-limit (pure; `SectorRoom.handleFire`
 * defers to this — the `clampFireTick` / `shouldDetachWarpVisual`
 * precedent).
 *
 * Background — the "inconsistent damage" report (capture
 * `2026-05-19T13-43-06-710Z-76idw1`): the client logged ~133 `fire`
 * events but the server logged only ~28 `fire_received`. Once the
 * post-"shot accepted" funnel was made visible (plan Phase 1 — the
 * cooldown-rejected `hit_ack` is now recorded), the 133→~28 ratio is
 * explained ENTIRELY by this rate-limiter, NOT by silently dropped
 * damage: the client may emit a fire intent every input tick, but a
 * shooter may only land one accepted fire per `cooldownTicks` (10 ticks
 * ≈ 167 ms). `fire_received` is `serverLogEvent`'d AFTER this gate, so a
 * cooldown-rejected shot left no trace until Phase 1 added the rejected
 * `hit_ack` log. This is by-design anti-rapid-fire behaviour, not a bug.
 *
 * This module makes that accounting explicit and characterisation-locked
 * (`fireCooldown.test.ts`) so:
 *   - the 133→~28 funnel is provably the rate-limiter, not a damage drop;
 *   - the security-sensitive anti-rapid-fire semantics can't be silently
 *     changed by a future "fix" without a failing test (it is the only
 *     guard against fire-rate abuse — see `src/server/CLAUDE.md`).
 *
 * KNOWN, DEFERRED (NOT fixed here — repro-gated follow-up): under packet
 * reorder/jitter a later-tick fire processed first advances the
 * last-accepted tick past an in-flight earlier (legitimate) fire, which
 * then fails this check and is dropped. A reorder-robust cooldown
 * (a small recent-accepted-ticks window instead of a single scalar) is
 * the eventual fix; it is security-sensitive and MUST be driven by a
 * failing repro from a real capture, not speculation. This module
 * deliberately encodes ONLY today's exact behaviour so that work starts
 * from a locked baseline.
 */

/**
 * True ⇒ this fire claim is within the cooldown window of the shooter's
 * last ACCEPTED fire and must be rejected. Behaviour-identical to the
 * original inline guard `tick - lastFireCt < cooldownTicks` (strict `<`,
 * so a claim exactly `cooldownTicks` after the last accept is allowed).
 *
 * `lastAcceptedClientTick` is the caller-resolved last-accepted client
 * tick for this shooter (the caller substitutes a far-negative sentinel
 * when the shooter has never fired, so the first shot always passes).
 * Compares CLIENT tick values, never serverTick, so RTT jitter between
 * consecutive messages can't cause false rejections. Independent of the
 * temporal-plausibility clamp (`clampFireTick`) — that bounds the
 * lag-comp rewind; this bounds the fire RATE.
 */
export function isFireOnCooldown(
  claimedTick: number,
  lastAcceptedClientTick: number,
  cooldownTicks: number,
): boolean {
  return claimedTick - lastAcceptedClientTick < cooldownTicks;
}
