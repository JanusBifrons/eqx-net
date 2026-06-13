/**
 * Lock for `GridPowerReadout` (Phase-4 C5 — grid total reads clearly).
 *
 * The top-left HUD chip shows the player's whole-GRID net power. C5 labels it
 * "GRID ⚡ …" so the grid total is unambiguous next to the per-building PWR line
 * in the EntityStatsPanel (which now shows the SELECTED building's own draw).
 * The green/red surplus/deficit split is unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { GridPowerReadout } from './GridPowerReadout.js';

describe('GridPowerReadout (Phase-4 C5)', () => {
  beforeEach(() => {
    // Force HUD-visible + seed a powered grid.
    useUIStore.setState({ loadingCosmeticOnly: true, gridNetPower: 35, minerals: 0 });
  });
  afterEach(() => cleanup());

  it('labels the grid total "GRID" and shows the signed surplus', () => {
    render(<GridPowerReadout />);
    const chip = screen.getByTestId('grid-power');
    expect(chip).toHaveAttribute('data-net-power', '35');
    // The grid total is explicitly labelled GRID (distinguishes it from the
    // per-building PWR line in the inspector).
    expect(chip.textContent).toMatch(/GRID/);
    expect(chip.textContent).toContain('+35');
  });

  it('shows a deficit with its sign (no GRID-label regression)', () => {
    useUIStore.setState({ gridNetPower: -20 });
    render(<GridPowerReadout />);
    const chip = screen.getByTestId('grid-power');
    expect(chip.textContent).toMatch(/GRID/);
    expect(chip.textContent).toContain('-20');
  });

  it('is hidden when there is no grid (zero power, zero minerals)', () => {
    useUIStore.setState({ gridNetPower: 0, minerals: 0 });
    render(<GridPowerReadout />);
    expect(screen.queryByTestId('grid-power')).toBeNull();
  });
});
