/**
 * Plan: crispy-kazoo, Commit 8 — WarpScreen stall robustness lock.
 *
 * Bug class: the user gets stuck on the loading screen with no
 * escape hatch. Symptom from the 2026-05-31 smoke:
 *   - Curtain stays up indefinitely
 *   - No Cancel button
 *   - No timeout fallback
 *   - User has to refresh the page to recover
 *
 * The fix:
 *   - After LOADING_STALL_TIMEOUT_MS (20 s) of continuous
 *     loading-active, the WarpScreen renders a Cancel button + an
 *     explanatory message.
 *   - The Cancel handler routes back to galaxy-map with a sector
 *     alert toast.
 *
 * This spec drives the real WarpScreen via Zustand state mutation
 * and asserts the Cancel surface appears AND clicking it routes
 * back to galaxy-map. Pre-fix the Cancel button does not exist —
 * the test fails at the `getByTestId('warp-screen-cancel')` lookup.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { LayoutContext } from '../layout/useLayout.js';
import { WarpScreen } from './WarpScreen.js';
import { useUIStore } from '../state/store.js';

let host: HTMLDivElement;

function renderWarp(): void {
  render(
    <LayoutContext.Provider value={{ fullscreen: host }}>
      <WarpScreen />
    </LayoutContext.Provider>,
  );
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  vi.useFakeTimers();
  // Drive into a loading-active state (phase=game, no readiness yet).
  useUIStore.setState({
    phase: 'game',
    connectionStatus: 'connected',
    localShipInstanceId: 'ship-1',
    firstSnapshotApplied: false,
    rendererFirstFrameRendered: false,
    joinMinimumElapsed: false,
    localPoseResolved: false,
    clientReadySent: false,
    arrivalTickFromServer: null,
    arrivalAcked: false,
  });
});

afterEach(() => {
  host.remove();
  vi.useRealTimers();
});

describe('WarpScreen — stall detection + Cancel escape hatch (Commit 8)', () => {
  it('Cancel button is NOT rendered before the stall timeout fires', () => {
    renderWarp();
    expect(screen.queryByTestId('warp-screen-cancel')).toBeNull();
    expect(screen.queryByTestId('warp-screen-stall-msg')).toBeNull();
    // data-warp-stalled is "0" pre-timeout.
    expect(screen.getByTestId('warp-screen').getAttribute('data-warp-stalled')).toBe('0');
  });

  it('after 20 s of continuous loading-active, Cancel + stall message appear', () => {
    renderWarp();

    act(() => {
      vi.advanceTimersByTime(19_999);
    });
    // Just before the timeout — no escape yet.
    expect(screen.queryByTestId('warp-screen-cancel')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(2);
    });
    // Timeout fired — escape surface is up.
    expect(screen.getByTestId('warp-screen-cancel')).toBeVisible();
    expect(screen.getByTestId('warp-screen-stall-msg')).toBeVisible();
    expect(screen.getByTestId('warp-screen').getAttribute('data-warp-stalled')).toBe('1');
  });

  it('clicking Cancel routes back to galaxy-map and sets a sector alert', () => {
    renderWarp();
    act(() => {
      vi.advanceTimersByTime(LOADING_TIMEOUT_MS);
    });
    const cancel = screen.getByTestId('warp-screen-cancel');

    fireEvent.click(cancel);

    const s = useUIStore.getState();
    expect(s.phase).toBe('galaxy-map');
    expect(s.localShipInstanceId).toBeNull();
    expect(s.isGalaxyMapOpen).toBe(false);
    expect(s.sectorAlert).toMatch(/connection|retry/i);
  });

  it('if loading clears before the timeout, stall surface never appears', () => {
    renderWarp();
    // Resolve loading after 10 s — bootstrap completed normally.
    act(() => {
      vi.advanceTimersByTime(10_000);
      useUIStore.setState({
        firstSnapshotApplied: true,
        rendererFirstFrameRendered: true,
        joinMinimumElapsed: true,
        localPoseResolved: true,
        clientReadySent: true,
        arrivalTickFromServer: 123,
        arrivalAcked: true,
      });
    });
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    // Past the original 20 s deadline — but loading cleared at 10 s
    // so the timeout was cancelled by the visible→false cleanup.
    expect(screen.queryByTestId('warp-screen-cancel')).toBeNull();
    expect(screen.getByTestId('warp-screen').getAttribute('data-warp-stalled')).toBe('0');
  });

  // The "re-arm" round-trip (loading→ready→loading) is exercised by
  // the production E2E `spawn-handshake.spec.ts` + transit cases. A
  // unit-level version here fights React effect ordering + fake timer
  // microtask interleaving and the value-vs-cost is poor — the four
  // cases above already lock: (1) no false-positive Cancel pre-stall,
  // (2) the timer fires at the 20s boundary, (3) Cancel routes back
  // to galaxy-map with a toast, (4) loading clearing cancels the timer.
});

const LOADING_TIMEOUT_MS = 20_001;
