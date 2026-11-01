import { describe, expect, it, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TradeToasts } from './TradeToasts';
import { useUIStore } from '../state/store';

describe('TradeToasts', () => {
  beforeEach(() => {
    useUIStore.setState({ tradeToasts: [], tradeUnread: 0, isDrawerOpen: false, drawerTab: 'galaxy' });
  });

  it('renders each toast with its tone and bumps the unread badge', () => {
    render(<TradeToasts />);
    act(() => {
      useUIStore.getState().pushTradeToast('Your trade hauler is under fire!', 'danger', true);
      useUIStore.getState().pushTradeToast('Deal agreed', 'good', false);
    });
    const toasts = screen.getAllByTestId('trade-toast');
    expect(toasts).toHaveLength(2);
    expect(toasts[0]).toHaveAttribute('data-tone', 'danger');
    expect(useUIStore.getState().tradeUnread).toBe(1);
  });

  it('tapping a toast opens the Trade tab (the escort prompt)', () => {
    render(<TradeToasts />);
    act(() => { useUIStore.getState().pushTradeToast('Your trade hauler is under fire!', 'danger', true); });
    fireEvent.click(screen.getByTestId('trade-toast'));
    expect(useUIStore.getState().isDrawerOpen).toBe(true);
    expect(useUIStore.getState().drawerTab).toBe('trade');
  });

  it('caps the stack at three', () => {
    render(<TradeToasts />);
    act(() => {
      for (let i = 0; i < 5; i++) useUIStore.getState().pushTradeToast(`n${i}`, 'info', false);
    });
    expect(screen.getAllByTestId('trade-toast')).toHaveLength(3);
  });
});
