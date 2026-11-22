/**
 * While the join loading screen (sector briefing) is up, the page chrome
 * that would sit over it stays hidden: the top bar (EQUINOX / settings /
 * LOGIN). It gates on the same selector the WarpScreen uses
 * (`useShowLoadingScreen`). (The "Command view" chip is gone: the mode
 * switch shows the mode, owner 2026-11-22.)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { AppHeader } from './AppHeader.js';

const LOADING = {
  phase: 'game' as const,
  loadingCosmeticOnly: false,
  connectionStatus: 'connected' as const,
  localShipInstanceId: 'ship-1',
  firstSnapshotApplied: false,
  rendererFirstFrameRendered: false,
  joinMinimumElapsed: false,
  localPoseResolved: false,
  clientReadySent: false,
  arrivalTickFromServer: null,
  arrivalAcked: false,
  travelling: false,
  buildMode: false,
};

const READY = {
  ...LOADING,
  firstSnapshotApplied: true,
  rendererFirstFrameRendered: true,
  joinMinimumElapsed: true,
  localPoseResolved: true,
  clientReadySent: true,
  arrivalTickFromServer: 100,
  arrivalAcked: true,
};

const noop = (): void => {};
const header = (): JSX.Element => (
  <AppHeader onLoginClick={noop} onProfileClick={noop} onSettingsClick={noop} />
);

describe('loading screen hides the page chrome over the briefing', () => {
  beforeEach(() => useUIStore.setState({ ...READY, pilotMode: 'pilot' }));

  it('top bar is hidden while the join loading screen shows', () => {
    useUIStore.setState(LOADING);
    render(header());
    expect(screen.queryByTestId('app-header')).toBeNull();
  });

  it('top bar shows once the sector is ready, and on the galaxy map', () => {
    const { rerender } = render(header());
    expect(screen.getByTestId('app-header')).toBeTruthy();
    useUIStore.setState({ phase: 'galaxy-map' });
    rerender(header());
    expect(screen.getByTestId('app-header')).toBeTruthy();
  });

  it('a sector-to-sector trip keeps the chrome (no loading screen then)', () => {
    useUIStore.setState({ ...LOADING, travelling: true, pilotMode: 'spectator' });
    render(header());
    expect(screen.getByTestId('app-header')).toBeTruthy();
  });
});
