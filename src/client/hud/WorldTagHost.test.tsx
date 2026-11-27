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

const fleet = {
  active: false,
  ids: [] as string[],
  ships: [] as { id: string; name: string; hullPct: number | null; shieldPct: number | null; activity: string }[],
  mode: null,
  stance: 'defensive' as const,
  squadId: null,
};
vi.mock('../fleet/useFleetSelectionView.js', () => ({ useFleetSelectionView: () => fleet }));

// The group tag's kinds come from the mirror, like the who-hexes.
const mirrorShips = new Map<string, { kind: string }>();
vi.mock('../net/clientSingleton', () => ({ getGameClient: () => ({ mirror: { ships: mirrorShips } }) }));

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

  it('2+ own ships selected (focus one of them or none): ONE group tag over the centroid', () => {
    fleet.active = true;
    fleet.ids = ['a', 'b'];
    fleet.ships = [
      { id: 'a', name: 'Fighter', hullPct: 100, shieldPct: null, activity: '' },
      { id: 'b', name: 'Fighter', hullPct: 60, shieldPct: null, activity: '' },
    ];
    mirrorShips.set('a', { kind: 'fighter' });
    mirrorShips.set('b', { kind: 'fighter' });
    try {
      render(
        <LayoutContext.Provider value={{ fullscreen: host }}>
          <WorldTagHost />
        </LayoutContext.Provider>,
      );
      const tag = screen.getByTestId('world-tag');
      expect(tag).toHaveAttribute('data-tag-mode', 'group');
      expect(tag).toHaveTextContent('2 ships · 2 Fighters');
      expect(tag).toHaveTextContent('Yours · Defensive');
    } finally {
      fleet.active = false;
      fleet.ids = [];
      fleet.ships = [];
      mirrorShips.clear();
    }
  });
});
