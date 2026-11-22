import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ContractsTab } from './ContractsTab';
import { useUIStore } from '../../../state/store';
import { formatReward, formatTimeLeft } from '../../../net/contractsApi';

const BOARD = {
  contracts: [
    { id: 'elite:elite-0', kind: 'elite', title: 'Dread Vexis', detail: 'Gunship elite', sectorKey: 'greenfall', rewardCredits: 300, endsAtMs: null },
    { id: 'event:incursion:greenfall', kind: 'event', title: 'Robot Incursion', detail: 'Destroy every raider', sectorKey: 'greenfall', rewardCredits: null, endsAtMs: Date.now() + 65_000 },
    { id: 'player:p-9', kind: 'player', title: 'Ace Nova', detail: 'Wanted pilot', sectorKey: '', rewardCredits: 1500, endsAtMs: null },
  ],
};

describe('ContractsTab (P4c, U2-5 rows)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => BOARD })));
    useUIStore.getState().setDrawerTab('contracts');
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useUIStore.getState().setRightPanel(null);
  });

  it('Contracts: elites and events in their sections, from GET /galaxy/contracts (no raw ids)', async () => {
    render(<ContractsTab page="contracts" />);
    await waitFor(() => expect(screen.getAllByTestId('contract-row')).toHaveLength(2));
    expect(screen.getByTestId('contracts-section-elite')).toHaveTextContent('Dread Vexis');
    expect(screen.getByTestId('contracts-section-event')).toHaveTextContent('Robot Incursion');
    expect(screen.queryByText('Ace Nova')).toBeNull();
    expect(screen.getByText('300¢ bounty')).toBeTruthy();
    expect(screen.getByText('Loot')).toBeTruthy();
    expect(document.body.textContent).not.toContain('elite-0');
    expect(fetch).toHaveBeenCalledWith('/galaxy/contracts');
  });

  it('Bounties: only player bounties; polls while that page is shown', async () => {
    useUIStore.getState().setDrawerTab('bounties');
    render(<ContractsTab page="bounties" />);
    await waitFor(() => expect(screen.getAllByTestId('contract-row')).toHaveLength(1));
    expect(screen.getByTestId('contracts-section-player')).toHaveTextContent('Ace Nova');
    expect(screen.getByText('1,500¢ bounty')).toBeTruthy();
    expect(screen.getByText(/Location unknown/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('p-9');
  });

  it('an empty page says so', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ contracts: [] }) })));
    render(<ContractsTab page="bounties" />);
    await waitFor(() => expect(screen.getByTestId('contracts-empty')).toBeTruthy());
  });

  it('a row opens the galaxy map and closes the panel', async () => {
    render(<ContractsTab page="contracts" />);
    await waitFor(() => expect(screen.getAllByTestId('contract-row')).toHaveLength(2));
    screen.getAllByTestId('contract-row')[0]!.click();
    expect(useUIStore.getState().rightPanel).toBeNull();
    expect(useUIStore.getState().isGalaxyMapOpen).toBe(true);
    useUIStore.getState().setGalaxyMapOpen(false);
  });

  it('does not poll while hidden', () => {
    useUIStore.getState().setRightPanel(null);
    render(<ContractsTab page="contracts" />);
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
