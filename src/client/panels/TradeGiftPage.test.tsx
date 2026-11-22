/** UI plan U2-6b: the Trade panel's Gift page on catalogue rows; same `send_gift` message. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

const send = vi.fn();
vi.mock('../net/clientSingleton', () => ({
  getGameClient: () => ({ getRoom: () => ({ send }) }),
}));

import { giftAmount, TradeGiftPage } from './TradeGiftPage';

afterEach(() => {
  cleanup();
  send.mockReset();
});

describe('TradeGiftPage (U2-6b)', () => {
  it('sends credits to traders by default', () => {
    render(<TradeGiftPage baseId={7} />);
    expect(screen.getByRole('region', { name: 'Send a gift' })).toBeTruthy();
    fireEvent.click(screen.getByTestId('trade-gift-send'));
    expect(send).toHaveBeenLastCalledWith('send_gift', {
      type: 'send_gift', allegiance: 'traders', networkEntityId: 7, good: null, qty: 0, credits: 100,
    });
  });

  it('the side segmented picks who gets it; the amount field sets the credits', () => {
    render(<TradeGiftPage baseId={7} />);
    fireEvent.click(within(screen.getByTestId('trade-gift-to')).getByRole('button', { name: 'Robots' }));
    fireEvent.change(within(screen.getByTestId('trade-gift-amount')).getByRole('textbox'), { target: { value: '25' } });
    fireEvent.click(screen.getByTestId('trade-gift-send'));
    expect(send).toHaveBeenLastCalledWith('send_gift', {
      type: 'send_gift', allegiance: 'robots', networkEntityId: 7, good: null, qty: 0, credits: 25,
    });
  });

  it('a bad amount shows an error and disables Send', () => {
    render(<TradeGiftPage baseId={7} />);
    fireEvent.change(within(screen.getByTestId('trade-gift-amount')).getByRole('textbox'), { target: { value: 'x' } });
    expect(screen.getByTestId('trade-gift-amount')).toHaveAttribute('data-error', 'true');
    expect(screen.getByTestId('trade-gift-send')).toBeDisabled();
  });

  it('no base: Send is hidden and a row says why', () => {
    render(<TradeGiftPage baseId={null} />);
    expect(screen.queryByTestId('trade-gift-send')).toBeNull();
    expect(screen.getByTestId('trade-gift-no-base')).toHaveTextContent('Build a Capital or Cargo Bay');
  });

  it('giftAmount: whole numbers ≥ 1 only', () => {
    expect(giftAmount('12.7')).toBe(12);
    expect(giftAmount('0')).toBeNull();
    expect(giftAmount('')).toBeNull();
    expect(giftAmount('abc')).toBeNull();
  });
});
