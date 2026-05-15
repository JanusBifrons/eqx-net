/**
 * Regression lock — `shouldDetachWarpVisual` (the post-warp filter
 * tear-down decision in `tickWarpShockwaves`).
 *
 * The bug this test prevents:
 *
 *   setWarpMode(true) attaches the shockwave + burst + zoom-blur +
 *   bloom chain to `app.stage`. setWarpMode(false) starts the fade-out
 *   tween AND fires a 1.5 s burst+flash. The fade tween finishes
 *   first (700 ms < 1500 ms) — its completion branch only tears down
 *   the chain when the burst is NOT active, so during the overlap
 *   the chain has to stay attached. The burst then continues for
 *   another ~800 ms, and when it finally completes there used to be
 *   no tear-down call. The filter chain stayed glued to `app.stage`
 *   forever, burning ~4 no-op shader passes per frame.
 *
 *   On mid-range Android this surfaced as a 100–200 ms `raf_gap` storm
 *   after every warp event — the diagnostic captured 2026-05-15 shows
 *   the symptom. The fix added the same tear-down predicate to the
 *   burst-completion branch (both paths now defer to this helper).
 *
 * The unit test covers every meaningful combination of (burst, fade,
 * intensity); the helper is a pure 3-line conjunction so the cases
 * are exhaustive.
 */
import { describe, it, expect } from 'vitest';
import { shouldDetachWarpVisual } from './PixiRenderer.js';

describe('shouldDetachWarpVisual', () => {
  it('detaches when every state is idle (the regression case)', () => {
    // Burst has just expired (set to 0 in the burst-completion branch),
    // fade ended earlier, intensity is already at floor. Before the
    // fix the burst-completion branch didn't call this — filters
    // stayed glued to app.stage.
    expect(shouldDetachWarpVisual({
      burstStartedAt: 0,
      fadeStartedAt: 0,
      intensity: 0,
    })).toBe(true);
  });

  it('keeps filters attached while the burst is still playing', () => {
    // Fade has finished (zero intensity) but the 1.5 s burst is
    // mid-flight. The fade-completion path correctly skipped its own
    // tear-down for this reason.
    expect(shouldDetachWarpVisual({
      burstStartedAt: 123_456,
      fadeStartedAt: 0,
      intensity: 0,
    })).toBe(false);
  });

  it('keeps filters attached during the fade-out tween', () => {
    // Fade is in progress, intensity ramping 1 → 0. Filters must stay
    // attached to render the fade.
    expect(shouldDetachWarpVisual({
      burstStartedAt: 0,
      fadeStartedAt: 99_000,
      intensity: 0.4,
    })).toBe(false);
  });

  it('keeps filters attached while warp intensity is non-zero', () => {
    // Pre-fade spool / climax — warp is live, never detach.
    expect(shouldDetachWarpVisual({
      burstStartedAt: 0,
      fadeStartedAt: 0,
      intensity: 1.0,
    })).toBe(false);
  });

  it('keeps filters attached when both fade AND burst are active', () => {
    // Right at the exit moment — fade tween just started AND burst was
    // just fired. Both still alive ⇒ filters stay.
    expect(shouldDetachWarpVisual({
      burstStartedAt: 50_000,
      fadeStartedAt: 50_000,
      intensity: 1.0,
    })).toBe(false);
  });

  it('treats a slightly-negative intensity (float jitter) as idle', () => {
    // Defensive: the fade clamp can land at exactly 0 or a hair below
    // depending on floating-point order of operations.
    expect(shouldDetachWarpVisual({
      burstStartedAt: 0,
      fadeStartedAt: 0,
      intensity: -1e-9,
    })).toBe(true);
  });
});
