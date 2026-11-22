/**
 * The Galaxy page's "Warp in this system" button: the retired speed dial's
 * Warp action moved here (UI language plan A7). It opens the existing
 * WarpPicker card (`warpPickerOpen`) and closes the right panel, only in a
 * solar-system build with a current sector.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const solar = vi.hoisted(() => ({ on: true }));
vi.mock('../../../../shared-types/sectorBounds', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../shared-types/sectorBounds')>();
  return { ...real, get SOLAR_SECTORS() { return solar.on; } };
});

import { GalaxyTab } from './GalaxyTab.js';
import { useUIStore } from '../../../state/store.js';

beforeEach(() => {
  solar.on = true;
  useUIStore.setState({
    currentSectorKey: 'sol-prime',
    transitState: 'DOCKED',
    warpPickerOpen: false,
    rightPanel: 'galaxy',
  });
});

describe('GalaxyTab — Warp in this system', () => {
  it('opens the warp picker and closes the panel', () => {
    render(<GalaxyTab />);
    fireEvent.click(screen.getByTestId('galaxy-tab-warp'));
    expect(useUIStore.getState().warpPickerOpen).toBe(true);
    expect(useUIStore.getState().rightPanel).toBeNull();
  });

  it('is disabled mid-transit', () => {
    useUIStore.setState({ transitState: 'SPOOLING' });
    render(<GalaxyTab />);
    expect(screen.getByTestId('galaxy-tab-warp')).toBeDisabled();
  });

  it('is absent outside a solar-system build', () => {
    solar.on = false;
    render(<GalaxyTab />);
    expect(screen.queryByTestId('galaxy-tab-warp')).not.toBeInTheDocument();
  });

  it('is absent with no current sector', () => {
    useUIStore.setState({ currentSectorKey: null });
    render(<GalaxyTab />);
    expect(screen.queryByTestId('galaxy-tab-warp')).not.toBeInTheDocument();
  });
});
