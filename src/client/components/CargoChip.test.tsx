import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CargoChip } from './CargoChip';
import { useUIStore } from '../state/store';

function reset(): void {
  act(() => {
    useUIStore.setState({ cargo: null, cargoCapacity: 0, lootFeed: [] });
  });
}

describe('CargoChip (P1a-1)', () => {
  beforeEach(reset);

  it('renders nothing while carrying nothing', () => {
    render(<CargoChip />);
    expect(screen.queryByTestId('cargo-chip')).toBeNull();
  });

  it('shows weight / capacity (credits live in the wallet) and turns red when full', () => {
    act(() => {
      useUIStore.getState().setCargo({ goods: { salvage: 300 }, blueprints: 1 }, 300);
    });
    render(<CargoChip />);
    const chip = screen.getByTestId('cargo-chip');
    expect(chip.getAttribute('data-cargo-weight')).toBe('300');
    expect(chip.getAttribute('data-cargo-fill')).toBe('full');
    expect(chip.textContent).toContain('★1');
  });

  it('tap expands the per-good breakdown', () => {
    act(() => {
      useUIStore.getState().setCargo({ goods: { alloy: 2 }, blueprints: 0 }, 300);
    });
    render(<CargoChip />);
    fireEvent.click(screen.getByTestId('cargo-chip'));
    expect(screen.getByTestId('cargo-breakdown').textContent).toContain('Alloy ×2');
  });

  it('shows pickup popups', () => {
    act(() => {
      useUIStore.getState().pushLootFeed('+7 Salvage');
    });
    render(<CargoChip />);
    expect(screen.getByTestId('loot-feed-line').textContent).toBe('+7 Salvage');
  });
});
