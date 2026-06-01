/**
 * Phase G — Bug B component lock: the WarpScreen status text must
 * re-show on EVERY inter-sector transit, not just the first.
 *
 * User smoke-test report: the first warp shows the WarpScreen status
 * messaging; the 2nd+ consecutive in-game sector warp does NOT — the
 * overlay stays hidden even though the warp still happens.
 *
 * Root cause (verified): `setPhase` re-arms the readiness sub-flags
 * only on enter/leave-`game`; a pure inter-sector transit keeps
 * `phase==='game'` so the re-arm never fires, `useGameReady()` stays
 * stuck-true, and `visible` stays `0`. Compounded by a 4-vs-5 gate
 * drift: WarpScreen's local `ready` omits `firstSnapshotApplied` while
 * `useGameReady()` includes it.
 *
 * This is the faithful level (Invariant #13): WarpScreen's entire input
 * is `useUIStore` + `useGameReady()`, so driving the real store through
 * consecutive simulated transits exercises the real component render +
 * real selectors + real visibility/text logic — the seam the bug lives
 * at. E2E is the wrong level (an inter-sector transit is not cleanly
 * Playwright-drivable) and a "compute statusText" unit test would miss
 * the `data-warp-visible` coupling + the gate drift.
 *
 * Pattern: `MetaLandingScreen.test.tsx` (store-driven RTL). WarpScreen
 * renders through `<Slot anchor="fullscreen">` which portals into a
 * `LayoutProvider`-registered host, so the test supplies a minimal
 * `LayoutContext` with a real `fullscreen` host element.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LayoutContext } from '../layout/useLayout.js';
import { WarpScreen } from './WarpScreen.js';
import { useUIStore } from '../state/store.js';

type RearmApi = { rearmJoinReadiness?: () => void };
const api = (): ReturnType<typeof useUIStore.getState> & RearmApi =>
  useUIStore.getState() as ReturnType<typeof useUIStore.getState> & RearmApi;

let host: HTMLDivElement;

function renderWarp(): { rerender: () => void } {
  const tree = (
    <LayoutContext.Provider value={{ fullscreen: host }}>
      <WarpScreen />
    </LayoutContext.Provider>
  );
  const { rerender } = render(tree);
  return { rerender: () => rerender(tree) };
}

const visible = (): string | null =>
  screen.getByTestId('warp-screen').getAttribute('data-warp-visible');
const statusText = (): string =>
  screen.getByTestId('warp-screen-status').textContent ?? '';

/** Drive the store to the steady "post-arrival, fully ready" baseline.
 *  Plan: crispy-kazoo, Commit 2 — `useGameReady()` is now the 9-gate
 *  predicate including the synchronised warp-in handshake. The legacy
 *  5-gate test fixtures here set ALL 9 to true to recover the
 *  "fully-arrived steady state" semantics. */
function settle(): void {
  useUIStore.setState({
    phase: 'game',
    connectionStatus: 'connected',
    localShipInstanceId: 'ship-1',
    firstSnapshotApplied: true,
    rendererFirstFrameRendered: true,
    joinMinimumElapsed: true,
    localPoseResolved: true,
    clientReadySent: true,
    arrivalTickFromServer: 123,
    arrivalAcked: true,
  });
}

describe('WarpScreen — status text re-shows on consecutive transits (Phase G, Bug B)', () => {
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    settle();
  });
  afterEach(() => {
    host.remove();
  });

  it('steady post-arrival state: hidden, WARP COMPLETE', () => {
    renderWarp();
    expect(visible()).toBe('0');
    expect(statusText()).toBe('WARP COMPLETE');
  });

  it('re-shows on the 1st AND 2nd consecutive inter-sector transit', () => {
    const { rerender } = renderWarp();
    expect(visible()).toBe('0'); // steady, hidden

    // ── Transit #1 — the production re-arm the transit_ready handler
    // fires. rearmJoinReadiness clears firstSnapshotApplied +
    // joinMinimumElapsed (rendererFirstFrameRendered stays true — the
    // renderer is still live across a transit).
    api().rearmJoinReadiness?.();
    rerender();
    expect(visible()).toBe('1'); // RED pre-fix: stays '0' (action absent)
    // Plan: crispy-kazoo, Commit 9 — collapsed status cascade to 3
    // user-visible states. Pre-rearm intermediate states all read as
    // 'LOADING SECTOR' (was the 5-state cascade SYNCING SECTOR
    // TELEMETRY / STABILISING TRAJECTORY etc.). Less jitter.
    expect(statusText()).toBe('LOADING SECTOR');

    // readiness gates flip true in arrival order → hides again
    useUIStore.getState().setFirstSnapshotApplied(true);
    rerender();
    expect(visible()).toBe('1'); // still gated by the minDisplay floor
    expect(statusText()).toBe('LOADING SECTOR');
    useUIStore.getState().setJoinMinimumElapsed(true);
    // Plan: crispy-kazoo, Commit 2 — synchronised warp-in handshake
    // gates must also flip for the curtain to drop. In production these
    // flip via: localPoseResolved (tryInitPredWorld success) →
    // clientReadySent (sendClientReady) → arrivalTickFromServer (warp_in
    // received) → arrivalAcked (local clock reached arrivalTick). The
    // status-text-during-handshake transitions are out of scope for this
    // spec — it locks the FINAL "curtain off, WARP COMPLETE" state.
    useUIStore.getState().setLocalPoseResolved(true);
    useUIStore.getState().setClientReadySent(true);
    useUIStore.getState().setArrivalTickFromServer(123);
    useUIStore.getState().setArrivalAcked(true);
    rerender();
    expect(visible()).toBe('0');
    expect(statusText()).toBe('WARP COMPLETE');

    // ── Transit #2 — the literal user complaint: must re-show AGAIN
    api().rearmJoinReadiness?.();
    rerender();
    expect(visible()).toBe('1'); // RED pre-fix: 2nd+ transit never re-shows
    expect(statusText()).toBe('LOADING SECTOR');
  });

  it('gate-drift lock: still shown when only firstSnapshotApplied is unmet (4-vs-5)', () => {
    // useGameReady() has 5+ gates incl. firstSnapshotApplied; WarpScreen's
    // pre-fix local `ready` had only 4 (omitted it) → it would HIDE here.
    useUIStore.setState({
      phase: 'game',
      connectionStatus: 'connected',
      localShipInstanceId: 'ship-1',
      firstSnapshotApplied: false,
      rendererFirstFrameRendered: true,
      joinMinimumElapsed: true,
      // Commit 2 handshake gates all true so this case isolates
      // firstSnapshotApplied as the single open gate.
      localPoseResolved: true,
      clientReadySent: true,
      arrivalTickFromServer: 123,
      arrivalAcked: true,
    });
    renderWarp();
    // The discriminating assertion: with only firstSnapshotApplied
    // unmet, the 5-gate `useGameReady()` is false → overlay SHOWN.
    // Pre-fix WarpScreen's local 4-gate `ready` omitted
    // firstSnapshotApplied → it would read true → overlay HIDDEN ('0').
    expect(visible()).toBe('1'); // RED pre-fix: 4-gate `ready` true → '0'
    // (statusText for this synthetic combo — firstSnapshotApplied false
    // but joinMinimumElapsed already true — is a pre-existing, out-of-
    // scope quirk: the text only branches on firstSnapshotApplied
    // inside the `!joinMinimumElapsed` arm. A real transit clears BOTH
    // via rearmJoinReadiness, so this combo never occurs in practice.
    // The visibility gate is the contract under test here.)
  });

  it('minimum-display floor stays load-bearing (R2)', () => {
    // All gates satisfied EXCEPT the joinMinimumElapsed floor → the warp
    // visual must remain shown. Guards against a future regression that
    // drops the floor from the readiness gate.
    // (Floor reduced 5 s → 2.5 s in crispy-kazoo Commit 9; this test
    // doesn't assert the duration, only that the gate keeps the curtain.)
    useUIStore.setState({
      phase: 'game',
      connectionStatus: 'connected',
      localShipInstanceId: 'ship-1',
      firstSnapshotApplied: true,
      rendererFirstFrameRendered: true,
      joinMinimumElapsed: false,
      localPoseResolved: true,
      clientReadySent: true,
      arrivalTickFromServer: 123,
      arrivalAcked: true,
    });
    renderWarp();
    expect(visible()).toBe('1');
    // Status cascade collapsed: any pending bootstrap gate (including
    // joinMinimumElapsed) reads as 'LOADING SECTOR' per Commit 9.
    expect(statusText()).toBe('LOADING SECTOR');
  });
});
