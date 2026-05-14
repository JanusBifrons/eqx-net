/**
 * Unit coverage for the WarpScreen overlay shell (status caption +
 * timer + visibility wiring). The Pixi-driven `<WarpStreaks>` child
 * is mocked because Pixi v8 needs a real WebGL context and jsdom
 * provides none — the streak visual itself is covered by the
 * tests/e2e/join-warp-screen.spec.ts on a real browser.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useUIStore } from '../state/store.js';

// Stub WarpStreaks — it boots a real Pixi Application which throws in
// jsdom. We render a small testid placeholder so the shell still has a
// child to compose with.
vi.mock('./WarpStreaks.js', () => ({
  WarpStreaks: ({ intensity }: { intensity: string }) => (
    <div data-testid="warp-streaks-stub" data-warp-intensity={intensity} />
  ),
}));

// Also stub Slot — it portals into a layout host that doesn't exist
// in the unit-test render tree. Plain wrapper div is enough for
// asserting testids.
vi.mock('../layout/Slot.js', () => ({
  Slot: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="slot-stub">{children}</div>
  ),
}));

import { WarpScreen } from './WarpScreen.js';

function setStoreReadiness(opts: {
  phase: 'meta' | 'auth' | 'galaxy-map' | 'connecting' | 'game' | 'local';
  connectionStatus?: 'disconnected' | 'connecting' | 'connected';
  localShipInstanceId?: string | null;
  firstSnapshotApplied?: boolean;
  rendererFirstFrameRendered?: boolean;
}): void {
  useUIStore.setState({
    phase: opts.phase,
    connectionStatus: opts.connectionStatus ?? 'connected',
    localShipInstanceId: opts.localShipInstanceId ?? null,
    firstSnapshotApplied: opts.firstSnapshotApplied ?? false,
    rendererFirstFrameRendered: opts.rendererFirstFrameRendered ?? false,
  });
}

describe('WarpScreen', () => {
  beforeEach(() => {
    // Reset to a known baseline so each test sets its own readiness.
    setStoreReadiness({ phase: 'meta' });
  });

  it('renders null outside game/connecting phases', () => {
    setStoreReadiness({ phase: 'meta' });
    const { container } = render(<WarpScreen />);
    // The Slot stub adds a wrapper; if WarpScreen returned null,
    // there's no slot-stub at all.
    expect(container.querySelector('[data-testid="warp-screen"]')).toBeNull();
  });

  it('renders visible during phase=connecting', () => {
    setStoreReadiness({ phase: 'connecting' });
    render(<WarpScreen />);
    expect(screen.getByTestId('warp-screen')).toHaveAttribute('data-warp-visible', '1');
  });

  it('renders visible during phase=game with !ready', () => {
    setStoreReadiness({ phase: 'game', connectionStatus: 'connecting' });
    render(<WarpScreen />);
    expect(screen.getByTestId('warp-screen')).toHaveAttribute('data-warp-visible', '1');
  });

  it('hides (data-warp-visible="0") when phase=game and gate (3 flags) is satisfied', () => {
    setStoreReadiness({
      phase: 'game',
      connectionStatus: 'connected',
      localShipInstanceId: 'ship-abc',
      // firstSnapshotApplied intentionally omitted — NOT part of the
      // visibility gate (see useGameReady doc).
      rendererFirstFrameRendered: true,
    });
    render(<WarpScreen />);
    expect(screen.getByTestId('warp-screen')).toHaveAttribute('data-warp-visible', '0');
  });

  describe('status caption tracks the readiness chain', () => {
    it('connectionStatus !== connected → ESTABLISHING SUBSPACE LINK', () => {
      setStoreReadiness({ phase: 'game', connectionStatus: 'connecting' });
      render(<WarpScreen />);
      expect(screen.getByTestId('warp-screen-status')).toHaveTextContent(
        'ESTABLISHING SUBSPACE LINK',
      );
    });

    it('connected but no localShipInstanceId → AWAITING NAVIGATION FIX', () => {
      setStoreReadiness({
        phase: 'game',
        connectionStatus: 'connected',
        localShipInstanceId: null,
      });
      render(<WarpScreen />);
      expect(screen.getByTestId('warp-screen-status')).toHaveTextContent(
        'AWAITING NAVIGATION FIX',
      );
    });

    it('localShip set but !rendererFirstFrameRendered → INITIALISING DISPLAY', () => {
      setStoreReadiness({
        phase: 'game',
        connectionStatus: 'connected',
        localShipInstanceId: 'ship-abc',
        rendererFirstFrameRendered: false,
      });
      render(<WarpScreen />);
      expect(screen.getByTestId('warp-screen-status')).toHaveTextContent(
        'INITIALISING DISPLAY',
      );
    });

    it('all three gate flags satisfied → WARP COMPLETE (during fade-out)', () => {
      setStoreReadiness({
        phase: 'game',
        connectionStatus: 'connected',
        localShipInstanceId: 'ship-abc',
        rendererFirstFrameRendered: true,
      });
      render(<WarpScreen />);
      expect(screen.getByTestId('warp-screen-status')).toHaveTextContent('WARP COMPLETE');
    });
  });

  it('mounts the WarpStreaks child with intensity="loading"', () => {
    setStoreReadiness({ phase: 'game', connectionStatus: 'connecting' });
    render(<WarpScreen />);
    expect(screen.getByTestId('warp-streaks-stub')).toHaveAttribute(
      'data-warp-intensity',
      'loading',
    );
  });

  it('renders a timer element with the T+ format', () => {
    setStoreReadiness({ phase: 'game', connectionStatus: 'connecting' });
    render(<WarpScreen />);
    const timer = screen.getByTestId('warp-screen-timer');
    // Initial textContent is "T+0.0s" before rAF runs once.
    expect(timer.textContent).toMatch(/^T\+\d+\.\ds$/);
  });

  it('transitions from visible to hidden when readiness flips true', () => {
    setStoreReadiness({ phase: 'game', connectionStatus: 'connecting' });
    render(<WarpScreen />);
    expect(screen.getByTestId('warp-screen')).toHaveAttribute('data-warp-visible', '1');

    act(() => {
      setStoreReadiness({
        phase: 'game',
        connectionStatus: 'connected',
        localShipInstanceId: 'ship-abc',
        rendererFirstFrameRendered: true,
      });
    });

    expect(screen.getByTestId('warp-screen')).toHaveAttribute('data-warp-visible', '0');
  });
});
