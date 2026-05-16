/**
 * Regression lock — `warpEventFiresBurst` (the single source of truth
 * for WHEN the warp burst+flash fires).
 *
 * The bug this prevents (on-device 2026-05-16, user smoke test):
 *
 *   Phase G made the load curtain rise at `transit_ready` (re-arm →
 *   !gameReady → loading=true), i.e. BEFORE the SPOOLING→IN_TRANSIT
 *   transition. `setWarpMode(false)` (the spool-exit) used to ALSO
 *   `fireBurst()` — the "climax". Post-Phase-G that climax burst now
 *   ALWAYS fires under the (already-raised) curtain: never a visible
 *   climax, and the ~200 ms curtain-rise tween vs the fast room-swap
 *   means it BLEEDS through → a leaky flash "while the cover is on",
 *   then the 5 s minimum-display floor, then the curtain drops and
 *   `triggerWarpIn` fires the real arrival flash. Net: a reordered
 *   double-flash with a blackout between. The earlier theoretical
 *   "keep the climax, mask it" (Option B) was falsified on-device —
 *   a climax that is always occluded is pure downside. Option A:
 *   exactly ONE warp flash per inter-sector transit, the arrival
 *   reveal (`triggerWarpIn`); the warp-out (`setWarpMode(false)`) only
 *   fades the filter chain out, no burst.
 *
 * `warpEventFiresBurst` is the policy both `PixiRenderer` burst
 * call-sites defer to (mirrors how `shouldDetachWarpVisual` is the
 * extracted, unit-tested tear-down decision — see
 * `PixiRenderer.warpDetach.test.ts`). Locking the policy here means a
 * future re-introduction of a warp-out / spool-start burst fails
 * loudly without needing a full Pixi app.
 */
import { describe, it, expect } from 'vitest';
import { warpEventFiresBurst } from './PixiRenderer.js';

describe('warpEventFiresBurst — single arrival flash policy', () => {
  it('warp-in (arrival reveal) fires the burst — the ONE visible flash', () => {
    expect(warpEventFiresBurst('warp-in')).toBe(true);
  });

  it('warp-mode-off (spool exit) does NOT burst — was the leaky under-curtain double-flash', () => {
    // THE LOCK: pre-fix `setWarpMode(false)` fired the climax burst
    // unconditionally; post-Phase-G that was always an occluded,
    // bleeding second flash on every inter-sector transit.
    expect(warpEventFiresBurst('warp-mode-off')).toBe(false);
  });

  it('warp-mode-on (spool start) does NOT burst — the spool ramps, no pulse', () => {
    expect(warpEventFiresBurst('warp-mode-on')).toBe(false);
  });
});
