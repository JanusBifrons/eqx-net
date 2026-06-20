/**
 * #7 — the remote-warp ripple must NOT bleed onto the galaxy map.
 *
 * The WarpFilterChain is attached to the shared `app.stage`. The GalaxyMapLayer
 * (selector full-screen OR in-game additive overlay) is a child of that same
 * `app.stage`, so a stage-level warp filter ripples the map overlay too — a
 * remote ship's warp-in distorts the hexes the player is reading. The
 * `pendingWarpEvents` drain (`PixiRenderer.drainRemoteWarp`) guards the visual
 * on the pure decision: skip the visual entirely when the galaxy map is open.
 *
 * Two layers of lock:
 *   1. the pure decisions (`shouldFireRemoteWarpVisual` / `remoteWarpEventFires`)
 *   2. the ACTUAL drain — `PixiRenderer.drainRemoteWarp` is driven directly and
 *      its observable counters (`debugRemoteWarpCounts`) are asserted. This is
 *      the lock the adversarial review found MISSING: the prior test only
 *      exercised the trivial pure helper, and the DEV hook re-derived the
 *      decision independently, so REVERTING the real guard in the drain left
 *      both green. Driving the drain + reading its counters fails loudly on a
 *      reverted guard (see the revert-verify note on each `it`).
 */
import { describe, it, expect } from 'vitest';
import { shouldFireRemoteWarpVisual, remoteWarpEventFires } from './pixi/warpHelpers';
import { PixiRenderer } from './PixiRenderer';
import type { RenderMirror } from '@core/contracts/IRenderer';

describe('shouldFireRemoteWarpVisual (#7 galaxy-map gate)', () => {
  it('fires the remote-warp visual when the galaxy map is CLOSED', () => {
    expect(shouldFireRemoteWarpVisual({ galaxyMapOpen: false })).toBe(true);
  });

  it('SKIPS the remote-warp visual when the galaxy map is OPEN', () => {
    expect(shouldFireRemoteWarpVisual({ galaxyMapOpen: true })).toBe(false);
  });
});

describe('remoteWarpEventFires (#7 composed drain decision)', () => {
  it('fires only when the map is closed AND no burst is in flight', () => {
    expect(remoteWarpEventFires({ galaxyMapOpen: false, burstInFlight: false })).toBe(true);
  });

  it('SKIPS when the galaxy map is open (even with no burst in flight)', () => {
    expect(remoteWarpEventFires({ galaxyMapOpen: true, burstInFlight: false })).toBe(false);
  });

  it('SKIPS when a burst is already in flight (even with the map closed)', () => {
    expect(remoteWarpEventFires({ galaxyMapOpen: false, burstInFlight: true })).toBe(false);
  });
});

/**
 * Lock the ACTUAL drain wiring (the review's core finding). A full PixiRenderer
 * is impractical headlessly (WebGL `Application`), so we drive `drainRemoteWarp`
 * on a prototype-backed instance with the exact fields the method touches:
 * `_galaxyLayer.visible`, `warp.isBurstInFlight`, `triggerWarpIn`/`initialized`,
 * and the two counters. This exercises the real `remoteWarpEventFires` guard
 * inside the drain, not a re-derivation — reverting the guard reds these.
 */
type DrainHarness = {
  drainRemoteWarp(mirror: RenderMirror): void;
  debugRemoteWarpCounts(): { fired: number; suppressed: number };
};

/**
 * Build a prototype-backed partial PixiRenderer with ONLY the fields
 * `drainRemoteWarp` + `triggerWarpIn` read. `triggerWarpIn` is the REAL method
 * (it checks `initialized` then calls `warp.triggerWarpIn`), so this drives the
 * genuine call chain — not a stub of the drain. The fire-count is returned so
 * each test reads the post-call mutation via closure.
 */
function makeDrainRenderer(opts: { galaxyMapVisible: boolean; burstInFlight: boolean }): {
  renderer: DrainHarness;
  triggerCount(): number;
} {
  let fired = 0;
  const renderer = Object.create(PixiRenderer.prototype) as DrainHarness & Record<string, unknown>;
  renderer._galaxyLayer = { visible: opts.galaxyMapVisible };
  renderer.warp = { isBurstInFlight: () => opts.burstInFlight, triggerWarpIn: () => { fired++; } };
  renderer.initialized = true;
  renderer._remoteWarpFiredCount = 0;
  renderer._remoteWarpSuppressedCount = 0;
  return { renderer, triggerCount: () => fired };
}

function mirrorWith(events: Array<{ x: number; y: number }>): RenderMirror {
  // Minimal mirror — only `pendingWarpEvents` is read by `drainRemoteWarp`.
  return { pendingWarpEvents: events } as unknown as RenderMirror;
}

describe('PixiRenderer.drainRemoteWarp (#7 ACTUAL drain wiring lock)', () => {
  it('FIRES the ripple + drains the queue when the galaxy map is CLOSED', () => {
    const { renderer, triggerCount } = makeDrainRenderer({ galaxyMapVisible: false, burstInFlight: false });
    const mirror = mirrorWith([{ x: 10, y: 20 }]);
    renderer.drainRemoteWarp(mirror);

    // The happy path: fired ticked, suppressed unchanged, the real
    // `triggerWarpIn` ran, and the queue drained.
    expect(renderer.debugRemoteWarpCounts()).toEqual({ fired: 1, suppressed: 0 });
    expect(triggerCount()).toBe(1);
    expect(mirror.pendingWarpEvents!.length).toBe(0);
  });

  it('SUPPRESSES the ripple while the galaxy map is OPEN (still drains the queue)', () => {
    const { renderer, triggerCount } = makeDrainRenderer({ galaxyMapVisible: true, burstInFlight: false });
    const mirror = mirrorWith([{ x: 10, y: 20 }]);
    renderer.drainRemoteWarp(mirror);

    // REVERT-VERIFY (the load-bearing assertion): remove the
    // `remoteWarpEventFires` / `shouldFireRemoteWarpVisual` guard in
    // `drainRemoteWarp` and the drain fires the ripple while the map is open —
    // `suppressed` stays 0, `fired` becomes 1, and the real `triggerWarpIn`
    // runs (triggerCount 1). ALL THREE assertions go red. The pure-helper test
    // (flagged worthless on its own by the review) cannot catch that; this can.
    expect(renderer.debugRemoteWarpCounts()).toEqual({ fired: 0, suppressed: 1 });
    expect(triggerCount()).toBe(0);
    expect(mirror.pendingWarpEvents!.length).toBe(0);
  });

  it('SUPPRESSES while a burst is in flight (map closed) — drains, no extra fire', () => {
    const { renderer, triggerCount } = makeDrainRenderer({ galaxyMapVisible: false, burstInFlight: true });
    const mirror = mirrorWith([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
    renderer.drainRemoteWarp(mirror);

    expect(renderer.debugRemoteWarpCounts()).toEqual({ fired: 0, suppressed: 1 });
    expect(triggerCount()).toBe(0);
    expect(mirror.pendingWarpEvents!.length).toBe(0);
  });

  it('does nothing on an empty queue (no counter movement)', () => {
    const { renderer } = makeDrainRenderer({ galaxyMapVisible: false, burstInFlight: false });
    renderer.drainRemoteWarp(mirrorWith([]));
    expect(renderer.debugRemoteWarpCounts()).toEqual({ fired: 0, suppressed: 0 });
  });
});
