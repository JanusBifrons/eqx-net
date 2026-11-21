/**
 * While the join loading screen (sector briefing) is up, the page chrome
 * that would sit over it stays hidden: the top bar (EQUINOX / settings /
 * LOGIN) and the "Command view" chip. Both gate on the same existing
 * selector the WarpScreen uses (`useShowLoadingScreen`). Sideways phone
 * (915x412): the chip sat over the briefing card's top-right.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { AppHeader } from './AppHeader.js';
import { SpectatorIndicator } from './SpectatorIndicator.js';

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

  it('Command view chip is hidden while the join loading screen shows', () => {
    useUIStore.setState({ ...LOADING, pilotMode: 'spectator' });
    render(<SpectatorIndicator />);
    expect(screen.queryByTestId('spectator-indicator')).toBeNull();
  });

  it('Command view chip shows once the sector is ready', () => {
    useUIStore.setState({ pilotMode: 'spectator' });
    render(<SpectatorIndicator />);
    expect(screen.getByTestId('spectator-indicator')).toHaveTextContent('Command view');
  });

  it('a sector-to-sector trip keeps the chrome (no loading screen then)', () => {
    useUIStore.setState({ ...LOADING, travelling: true, pilotMode: 'spectator' });
    render(<>{header()}<SpectatorIndicator /></>);
    expect(screen.getByTestId('app-header')).toBeTruthy();
    expect(screen.getByTestId('spectator-indicator')).toBeTruthy();
  });
});
