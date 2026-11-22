/**
 * UI plan U3-2: the Details right panel. Opens on `rightPanel='details'` with
 * the selection readout inside; ✕ closes it; it closes itself when the
 * selection goes away.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useUIStore } from '../state/store';

vi.mock('../components/EntityStatsPanel', () => ({
  EntityStatsPanel: () => <div data-testid="entity-stats-panel">body</div>,
}));

import { DetailsPanel } from './DetailsPanel';

beforeEach(() => {
  useUIStore.setState({ rightPanel: null, selection: { ids: [], focusId: 'swarm-3', focusKind: 'structure' } });
});
afterEach(() => cleanup());

describe('DetailsPanel (U3-2)', () => {
  it('closed by default; opens with the selection readout; ✕ closes', () => {
    render(<DetailsPanel />);
    expect(screen.queryByTestId('entity-stats-panel')).toBeNull();
    act(() => useUIStore.getState().setRightPanel('details'));
    expect(screen.getByTestId('rail-panel-details')).toBeTruthy();
    expect(screen.getByTestId('entity-stats-panel')).toBeTruthy();
    fireEvent.click(screen.getByTestId('rail-panel-details-close'));
    expect(useUIStore.getState().rightPanel).toBeNull();
  });

  it('closes itself when the selection goes away', () => {
    render(<DetailsPanel />);
    act(() => useUIStore.getState().setRightPanel('details'));
    act(() => useUIStore.setState({ selection: { ids: [], focusId: null, focusKind: null } }));
    expect(useUIStore.getState().rightPanel).toBeNull();
  });
});
