/**
 * UI plan U2-5: Jobs is its own panel, Contracts / Bounties on a segmented
 * switch (`drawerTab` = the view); ✕ closes it; the advanced drawer no longer
 * draws it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useUIStore } from '../state/store';

vi.mock('../layout/Drawer/tabs/ContractsTab', () => ({
  ContractsTab: ({ page }: { page: string }) => <div data-testid="jobs-board">{page}</div>,
}));

const { JobsPanel, JOBS_VIEWS, jobsViewFor } = await import('./JobsPanel');

beforeEach(() => { useUIStore.setState({ rightPanel: null, drawerTab: 'galaxy' }); });
afterEach(() => {
  cleanup();
  useUIStore.setState({ rightPanel: null, drawerTab: 'galaxy' });
});

describe('JobsPanel (U2-5)', () => {
  it('opens on the Jobs rail page with Contracts / Bounties on a switch', () => {
    render(<JobsPanel />);
    act(() => useUIStore.getState().setDrawerTab('contracts'));
    expect(useUIStore.getState().rightPanel).toBe('jobs');
    expect(screen.getByTestId('jobs-panel')).toBeVisible();
    expect(JOBS_VIEWS.map((v) => v.label)).toEqual(['Contracts', 'Bounties']);
    expect(screen.getByTestId('jobs-board').textContent).toBe('contracts');
  });

  it('a switch pick shows Bounties and stays in the Jobs panel', () => {
    render(<JobsPanel />);
    act(() => useUIStore.getState().setDrawerTab('contracts'));
    fireEvent.click(screen.getByTestId('jobs-view-bounties'));
    expect(useUIStore.getState().drawerTab).toBe('bounties');
    expect(useUIStore.getState().rightPanel).toBe('jobs');
    expect(screen.getByTestId('jobs-board').textContent).toBe('bounties');
  });

  it('✕ closes the panel', () => {
    render(<JobsPanel />);
    act(() => useUIStore.getState().setDrawerTab('bounties'));
    fireEvent.click(screen.getByTestId('jobs-panel-close'));
    expect(useUIStore.getState().rightPanel).toBeNull();
  });

  it('closed while another panel is open', () => {
    render(<JobsPanel />);
    act(() => useUIStore.getState().setDrawerTab('galaxy'));
    expect(screen.getByTestId('jobs-panel')).not.toBeVisible();
  });

  it('any other page id shows Contracts', () => {
    expect(jobsViewFor('bounties')).toBe('bounties');
    expect(jobsViewFor('galaxy')).toBe('contracts');
  });
});
