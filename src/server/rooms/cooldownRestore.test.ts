import { describe, it, expect } from 'vitest';
import {
  shouldHonourResumedCooldown,
  COOLDOWN_FUTURE_GUARD_TICKS,
  COOLDOWN_PAST_GUARD_TICKS,
} from './cooldownRestore.js';

/**
 * Regression coverage for the limbo cooldown-restore policy.
 *
 * The 2026-05-06 mobile diagnostic surfaced "all my shots are rejected"
 * after a sector transit. Cause: the source room's `lastFireClientTick`
 * (e.g., 200_000) was restored verbatim into the destination room
 * (`serverTick = 6_814`); the destination's client `inputTick` started at
 * 6_814 → every fire failed `tick - lastFireCt < WEAPON_COOLDOWN_TICKS`
 * (the delta was hugely negative). The fix gates restoration on a "same
 * tick space" plausibility window.
 *
 * If anyone ever widens the future-guard or removes the past-guard, the
 * cross-room transit case fails again silently in production.
 */

describe('shouldHonourResumedCooldown', () => {
  // Same-room reconnect: resumed tick is at or just behind the new welcome's
  // serverTick. This is the case the cooldown was DESIGNED for.
  it('honours a resumed cooldown a few ticks behind the new serverTick (brief same-room reconnect)', () => {
    expect(shouldHonourResumedCooldown(199_995, 200_000)).toBe(true);
    expect(shouldHonourResumedCooldown(199_990, 200_000)).toBe(true);
  });

  // The client's inputTick can lead serverTick by `leadTicks` (~6) at the
  // moment of fire, so the resumed value can be slightly *ahead* of the new
  // welcome's serverTick — must still be honoured.
  it('honours a resumed cooldown a few ticks ahead of the new serverTick (in-flight fire across reconnect)', () => {
    expect(shouldHonourResumedCooldown(200_006, 200_000)).toBe(true);
    expect(shouldHonourResumedCooldown(200_060, 200_000)).toBe(true); // exact boundary
  });

  // Cross-room transit: source and destination rooms have independent
  // serverTick counters. Resumed value can be wildly larger than the
  // destination's serverTick — must NOT be honoured.
  it('discards a resumed cooldown wildly ahead (cross-room transit)', () => {
    expect(shouldHonourResumedCooldown(200_000, 6_814)).toBe(false);
    expect(shouldHonourResumedCooldown(200_061, 200_000)).toBe(false); // just past the future guard
  });

  // Long-stale resume (player closed tab for hours then reopened): the
  // cooldown is expired anyway — safe to drop.
  it('discards a long-stale resumed cooldown (>10 s behind)', () => {
    expect(shouldHonourResumedCooldown(0, 1_000)).toBe(false);
    expect(shouldHonourResumedCooldown(199_399, 200_000)).toBe(false); // just past the past guard
  });

  // Fence-post: exact boundary is INSIDE the window.
  it('treats the past-guard boundary as honoured', () => {
    expect(shouldHonourResumedCooldown(200_000 - COOLDOWN_PAST_GUARD_TICKS, 200_000)).toBe(true);
  });

  it('treats the future-guard boundary as honoured', () => {
    expect(shouldHonourResumedCooldown(200_000 + COOLDOWN_FUTURE_GUARD_TICKS, 200_000)).toBe(true);
  });

  // Reproduction of the exact 2026-05-06 incident values.
  it('reproduces the 2026-05-06 mobile case (welcome.serverTick=6814, resumed=very-large) and discards', () => {
    const destinationServerTick = 6_814;
    const resumedFromOtherRoom = 200_000;
    expect(shouldHonourResumedCooldown(resumedFromOtherRoom, destinationServerTick)).toBe(false);
  });
});
