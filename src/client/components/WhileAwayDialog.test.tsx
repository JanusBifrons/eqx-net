/**
 * "While you were away" in the one Window (EqxWindow): it opens with the
 * unseen trade history once the player is in the game, keeps its test ids,
 * and OK / ✕ close it and mark the history seen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { TradeHistoryEntry } from '../../shared-types/economy';
import { useUIStore } from '../state/store';
import { WhileAwayDialog } from './WhileAwayDialog';

const history = [
  { dealId: 'd1', atMs: 2, outcome: 'settled', note: 'Ore sold' },
  { dealId: 'd2', atMs: 3, outcome: 'raided', note: 'Convoy raided' },
] as unknown as TradeHistoryEntry[];
const saveSeen = vi.fn();

vi.mock('../identity/token', () => ({ loadStoredPlayerId: () => 'p1' }));
vi.mock('../auth/tokenStorage', () => ({ loadToken: () => 'tok' }));
vi.mock('../net/tradeApi', () => ({
  fetchEconomy: vi.fn(async () => ({ history })),
  loadTradeLastSeen: () => 0,
  saveTradeLastSeen: (ms: number) => saveSeen(ms),
}));
vi.mock('../net/tradeView', () => ({
  unseenHistory: (h: TradeHistoryEntry[]) => h,
  summarizeHistory: () => '2 deals while you were away',
}));

afterEach(() => { cleanup(); saveSeen.mockClear(); });

describe('WhileAwayDialog', () => {
  it('opens in the Window with the summary and rows, and OK closes it', async () => {
    useUIStore.setState({ phase: 'game' });
    render(<WhileAwayDialog />);
    const root = await screen.findByTestId('while-away-dialog');
    expect(root.getAttribute('data-game-window')).toBe('1');
    expect(screen.getByRole('dialog').textContent).toContain('While you were away');
    expect(screen.getByTestId('while-away-summary').textContent).toBe('2 deals while you were away');
    expect(screen.getByText('Convoy raided')).toBeTruthy();
    expect(screen.getByTestId('while-away-open-trade')).toBeTruthy();
    fireEvent.click(screen.getByTestId('while-away-close'));
    expect(saveSeen).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('while-away-summary')).toBeNull();
  });

  it('the ✕ closes it too', async () => {
    useUIStore.setState({ phase: 'game' });
    render(<WhileAwayDialog />);
    fireEvent.click(await screen.findByTestId('while-away-x'));
    expect(saveSeen).toHaveBeenCalledTimes(1);
  });
});
