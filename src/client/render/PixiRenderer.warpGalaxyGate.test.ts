/**
 * #7 — the remote-warp ripple must NOT bleed onto the galaxy map.
 *
 * The WarpFilterChain is attached to the shared `app.stage`. The GalaxyMapLayer
 * (selector full-screen OR in-game additive overlay) is a child of that same
 * `app.stage`, so a stage-level warp filter ripples the map overlay too — a
 * remote ship's warp-in distorts the hexes the player is reading. The
 * `pendingWarpEvents` drain in `PixiRenderer.update` guards `triggerWarpIn` on
 * the pure `shouldFireRemoteWarpVisual` decision: skip the visual entirely when
 * the galaxy map is open.
 *
 * Locked here (the pure decision); the integration that the drain reads it is
 * covered by the renderer wiring + the written-not-run E2E.
 */
import { describe, it, expect } from 'vitest';
import { shouldFireRemoteWarpVisual } from './pixi/warpHelpers';

describe('shouldFireRemoteWarpVisual (#7 galaxy-map gate)', () => {
  it('fires the remote-warp visual when the galaxy map is CLOSED', () => {
    expect(shouldFireRemoteWarpVisual({ galaxyMapOpen: false })).toBe(true);
  });

  it('SKIPS the remote-warp visual when the galaxy map is OPEN', () => {
    expect(shouldFireRemoteWarpVisual({ galaxyMapOpen: true })).toBe(false);
  });
});
