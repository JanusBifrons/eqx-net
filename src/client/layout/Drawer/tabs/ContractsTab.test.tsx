import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ContractsTab } from './ContractsTab';
import { useUIStore } from '../../../state/store';
import { formatReward, formatTimeLeft } from '../../../net/contractsApi';

const BOARD = {
  contracts: [
    { id: 'elite:elite-0', kind: 'elite', title: 'Dread Vexis', detail: 'Gunship elite', sectorKey: 'greenfall', rewardCredits: 300, endsAtMs: null },
    { id: 'event:incursion:greenfall', kind: 'event', title: 'Robot Incursion', detail: 'Destroy every raider', sectorKey: 'greenfall', rewardCredits: null, endsAtMs: Date.now() + 65_000 },
  ],
};

describe('ContractsTab (P4c)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => BOARD })));
    useUIStore.getState().setDrawerTab('contracts');
    useUIStore.getState().setDrawerOpen(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useUIStore.getState().setDrawerOpen(false);
  });

  it('renders the board from GET /galaxy/contracts (no raw ids)', async () => {
    render(<ContractsTab />);
    await waitFor(() => expect(screen.getAllByTestId('contract-row')).toHaveLength(2));
    expect(screen.getByText(/Dread Vexis/)).toBeTruthy();
    expect(screen.getByText('300¢ bounty')).toBeTruthy();
    expect(screen.getByText('Loot')).toBeTruthy();
    expect(document.body.textContent).not.toContain('elite-0');
    expect(fetch).toHaveBeenCalledWith('/galaxy/contracts');
  });

  it('does not poll while hidden', () => {
    useUIStore.getState().setDrawerOpen(false);
    render(<ContractsTab />);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('contracts formatting', () => {
  it('formats time left and rewards', () => {
    expect(formatTimeLeft(65_000, 0)).toBe('1:05');
    expect(formatTimeLeft(0, 10_000)).toBe('0:00');
    expect(formatReward({ rewardCredits: 1500 })).toBe('1,500¢ bounty');
    expect(formatReward({ rewardCredits: null })).toBe('Loot');
  });
});
