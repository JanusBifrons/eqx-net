/**
 * The world tag never draws over an open right panel (the fullscreen slot is
 * above the panel's z tier): it unmounts while one is open, like LockCluster.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { LayoutContext } from '../layout/useLayout.js';
import { useUIStore } from '../state/store.js';

vi.mock('../components/selectionPanelData.js', () => ({
  useSelectionPanelData: () => ({ name: 'Vex', hpPct: 50, shieldPct: null, stance: 'hostile' }),
}));

const { WorldTagHost } = await import('./WorldTagHost.js');

let host: HTMLDivElement;

describe('WorldTagHost', () => {
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    useUIStore.getState().setRightPanel(null);
  });
  afterEach(() => {
    useUIStore.getState().setRightPanel(null);
    host.remove();
  });

  it('shows the tag with no panel open and hides it while a right panel is open', () => {
    render(
      <LayoutContext.Provider value={{ fullscreen: host }}>
        <WorldTagHost />
      </LayoutContext.Provider>,
    );
    expect(screen.getByTestId('world-tag')).toHaveTextContent('Vex');
    act(() => useUIStore.getState().setRightPanel('contacts'));
    expect(screen.queryByTestId('world-tag')).toBeNull();
    act(() => useUIStore.getState().setRightPanel(null));
    expect(screen.getByTestId('world-tag')).toBeInTheDocument();
  });
});
