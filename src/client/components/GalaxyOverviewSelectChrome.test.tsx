/**
 * Locks the in-game ship-swap overview chrome (single-canvas refactor,
 * Step 6). It replaced GalaxyOverviewScreen(mode='select') + its Pixi
 * Application. Regression risks guarded:
 *   - the load-bearing testids vanish (drawer-galaxy.spec +
 *     galaxy-map-overlay.spec assert galaxy-overview-select /
 *     galaxy-overview-close),
 *   - the close button stops firing onClose.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GalaxyOverviewSelectChrome } from './GalaxyOverviewSelectChrome';

describe('GalaxyOverviewSelectChrome', () => {
  it('renders the select overview testids + the embedded roster panel', () => {
    render(<GalaxyOverviewSelectChrome onClose={() => {}} />);
    expect(screen.getByTestId('galaxy-overview-select')).toBeInTheDocument();
    expect(screen.getByTestId('galaxy-overview-close')).toBeInTheDocument();
    expect(screen.getByTestId('ship-roster-panel')).toBeInTheDocument();
  });

  it('close button fires onClose', () => {
    const onClose = vi.fn();
    render(<GalaxyOverviewSelectChrome onClose={onClose} />);
    fireEvent.click(screen.getByTestId('galaxy-overview-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
