import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

vi.mock('../state/store', async (orig) => {
  const mod = await orig<typeof import('../state/store')>();
  return { ...mod, useShouldRenderHud: () => true };
});

import { WalletChip, formatWallet } from './WalletChip';
import { useUIStore } from '../state/store';

describe('WalletChip (economy v2 W1)', () => {
  afterEach(() => useUIStore.setState({ wallet: null }));

  it('renders nothing before the first snapshot carries a balance', () => {
    render(<WalletChip />);
    expect(screen.queryByTestId('wallet-chip')).toBeNull();
  });

  it('shows the wallet balance from the store (written from the snapshot)', () => {
    act(() => useUIStore.getState().setWallet(12345));
    render(<WalletChip />);
    const chip = screen.getByTestId('wallet-chip');
    expect(chip.getAttribute('data-wallet')).toBe('12345');
    expect(chip.textContent).toBe('¢ 12,345');
  });

  it('formats whole, non-negative credits', () => {
    expect(formatWallet(0)).toBe('¢ 0');
    expect(formatWallet(1999.7)).toBe('¢ 1,999');
    expect(formatWallet(-5)).toBe('¢ 0');
  });
});
