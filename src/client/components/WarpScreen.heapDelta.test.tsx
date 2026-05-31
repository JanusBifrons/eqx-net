/**
 * Heap-delta regression lock for the WarpScreen progress indicator.
 *
 * History:
 *   - Pre-fix (2026-05-30 capture, plan melodic-engelbart Step 4):
 *     a per-RAF `WARP STABILISATION ${pct}%` template literal at
 *     60 Hz ranked #2 in the hostile CDP allocation profile (28 KB /
 *     3.8 %).
 *   - Original fix: gate write on pct-change + self-terminate the
 *     RAF at 100%. Reduced churn but kept the RAF loop alive.
 *   - Plan crispy-kazoo Commit 9 (2026-05-31 smoke): user reported
 *     "loading text feels a bit jittery and weird", and the X%
 *     counter visibly stops mid-window once the curtain duration
 *     dropped to ~3 s. Replaced the JS RAF entirely with a CSS-
 *     animated 3-dot ellipsis — ZERO JS allocation per frame, the
 *     animation lives in the GPU compositor.
 *
 * This spec locks the structural invariant: NO `requestAnimationFrame`
 * is scheduled by WarpScreen at all. The strongest version of the
 * original concern.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { LayoutContext } from '../layout/useLayout.js';
import { WarpScreen } from './WarpScreen.js';
import { useUIStore } from '../state/store.js';

let host: HTMLDivElement;
let rafCallCount: number;
let originalRaf: typeof globalThis.requestAnimationFrame;

describe('WarpScreen — zero JS animation overhead', () => {
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    rafCallCount = 0;
    originalRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
      rafCallCount += 1;
      // Don't actually schedule — we just want to count attempts.
      void cb;
      return 0;
    }) as typeof globalThis.requestAnimationFrame;
    // Loading-active baseline so the curtain is visible.
    useUIStore.setState({
      phase: 'game',
      connectionStatus: 'connected',
      localShipInstanceId: 'ship-1',
      firstSnapshotApplied: false,
      rendererFirstFrameRendered: false,
      joinMinimumElapsed: false,
      clientReadySent: false,
      arrivalTickFromServer: null,
      arrivalAcked: false,
    });
  });

  afterEach(() => {
    host.remove();
    globalThis.requestAnimationFrame = originalRaf;
  });

  it('mounts without scheduling any requestAnimationFrame', () => {
    render(
      <LayoutContext.Provider value={{ fullscreen: host }}>
        <WarpScreen />
      </LayoutContext.Provider>,
    );
    expect(rafCallCount, 'WarpScreen must not schedule any RAF — the ellipsis animation is pure CSS').toBe(0);
  });

  it('renders the timer slot as a stable 3-dot ellipsis (no textContent churn)', () => {
    render(
      <LayoutContext.Provider value={{ fullscreen: host }}>
        <WarpScreen />
      </LayoutContext.Provider>,
    );
    const timer = host.querySelector('[data-testid="warp-screen-timer"]');
    expect(timer).not.toBeNull();
    // Three child dots, no text. The dots' alpha is CSS-keyframed.
    expect(timer?.children.length).toBe(3);
    expect(timer?.textContent).toBe('');
  });
});
