/**
 * UI plan U3-7: the left strip's placing tools (placingStripItems.tsx), which
 * replace the bottom-middle placing bar and the Build panel's folded strip.
 * - Place goes through the one commit path (`commitPlacement`) and keeps
 *   placing until ✕, except a place-once kind; disabled while the ghost is
 *   rejected or held on the spot just sent.
 * - Rotate / Mirror use the R / F keys' functions (real module state here).
 * - The building icon reopens the Build panel, which hides the strip; a new
 *   pick folds back to the strip with the new kind; ✕ stops placing and the
 *   Build panel comes back. Placing wins over a selection. Icons only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useUIStore } from '../state/store';
import { getPlacementMirror, getPlacementRotationDeg, setPlacementMirror, setPlacementRotationDeg } from '../structures/structurePlacementClient';
import { resetPlacementChosen, setPlacementHeld, setPlacementRejection } from '../structures/placementChosen';

const commitChosenPlacement = vi.fn((..._a: unknown[]) => true);
vi.mock('../structures/structurePlacementClient', async (orig) => ({
  ...(await orig<typeof import('../structures/structurePlacementClient')>()),
  commitChosenPlacement: (...a: unknown[]) => commitChosenPlacement(...a),
}));
vi.mock('../components/selectionPanelData', async (orig) => ({
  ...(await orig<typeof import('../components/selectionPanelData')>()),
  useSelectionPanelData: () => null,
}));
vi.mock('../net/clientSingleton', () => ({
  getGameClient: () => ({ mirror: { localPlayerId: 'me', ships: new Map() }, lockSelected: vi.fn(), cancelLock: vi.fn(), getRoom: () => null }),
}));

import { LayoutProvider } from './LayoutProvider';
import { LeftStripHost } from './LeftStripHost';
import { BuildSidebarHost } from '../components/BuildSidebarHost';

const rendererRef = { current: { selectFleetShips: vi.fn(), attackFocus: vi.fn() } };

function mount(): void {
  render(<LayoutProvider><LeftStripHost rendererRef={rendererRef} /><BuildSidebarHost /></LayoutProvider>);
}

const tool = (id: string): HTMLButtonElement => screen.getByTestId(id) as HTMLButtonElement;
const stripOpen = (): boolean => screen.queryByTestId('placement-kind') !== null
  && screen.getByTestId('left-strip').getAttribute('data-open') === 'true';
const buildOpen = (): boolean => screen.queryByTestId('build-rail') !== null;
const pick = (cat: string, kind: string): void => {
  fireEvent.click(screen.getByTestId(`build-cat-${cat}`));
  fireEvent.click(screen.getByTestId(`build-${kind}`).querySelector('button')!);
};

beforeEach(() => {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('reduce'), media: q, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
  useUIStore.setState({
    phase: 'galaxy-map', isDead: false, rightPanel: null, travelling: true, pilotMode: 'spectator',
    buildMode: true, placementKind: null, fleetPick: null, packedStock: null,
    selection: { ids: [], focusId: null, focusKind: null },
  });
  resetPlacementChosen();
  commitChosenPlacement.mockClear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('placing tools on the left strip', () => {
  it('shows nothing while not placing', () => {
    mount();
    expect(screen.queryByTestId('placement-kind')).toBeNull();
    expect(screen.queryByTestId('placement-confirm')).toBeNull();
  });

  it('shows the building, Place, Rotate, Mirror and Cancel as icons only', () => {
    act(() => { useUIStore.setState({ placementKind: 'solar' }); });
    mount();
    const ids = Array.from(screen.getByTestId('left-strip').querySelectorAll('button')).map((b) => b.dataset.testid);
    expect(ids).toEqual(['placement-kind', 'placement-confirm', 'placement-rotate', 'placement-mirror', 'placement-cancel']);
    expect(tool('placement-kind').dataset.state).toBe('solar');
    for (const [id, label] of [['placement-confirm', 'Place'], ['placement-rotate', 'Rotate'], ['placement-mirror', 'Mirror'], ['placement-cancel', 'Stop placing']] as const) {
      expect(tool(id).getAttribute('aria-label')).toBe(label);
      expect(tool(id).textContent).toBe('');
    }
    expect(screen.getByTestId('left-strip').textContent).toBe('');
  });

  it('placing wins over a selection', () => {
    act(() => { useUIStore.setState({ placementKind: 'solar', selection: { ids: [], focusId: 's1', focusKind: 'structure' } }); });
    mount();
    expect(screen.queryByTestId('left-strip-identity')).toBeNull();
    expect(screen.getByTestId('placement-kind')).toBeTruthy();
  });

  it('Place commits through the one path and keeps placing', () => {
    act(() => { useUIStore.setState({ placementKind: 'solar' }); });
    mount();
    fireEvent.click(tool('placement-confirm'));
    fireEvent.click(tool('placement-confirm'));
    expect(commitChosenPlacement).toHaveBeenCalledTimes(2);
    expect(commitChosenPlacement).toHaveBeenCalledWith('solar');
    expect(useUIStore.getState().placementKind).toBe('solar');
  });

  it.each(['capital', 'territory_lock'] as const)('Place puts a %s down once: placement ends', (kind) => {
    act(() => { useUIStore.setState({ placementKind: kind }); });
    mount();
    fireEvent.click(tool('placement-confirm'));
    expect(commitChosenPlacement).toHaveBeenCalledWith(kind);
    expect(useUIStore.getState().placementKind).toBeNull();
  });

  it('a refused commit keeps placing', () => {
    commitChosenPlacement.mockReturnValueOnce(false);
    act(() => { useUIStore.setState({ placementKind: 'solar' }); });
    mount();
    fireEvent.click(tool('placement-confirm'));
    expect(useUIStore.getState().placementKind).toBe('solar');
  });

  it('Place is disabled while the ghost is rejected or held, enabled again once clear', () => {
    act(() => { useUIStore.setState({ placementKind: 'solar' }); });
    mount();
    expect(tool('placement-confirm').disabled).toBe(false);
    act(() => setPlacementRejection('overlap-structure'));
    expect(tool('placement-confirm').disabled).toBe(true);
    act(() => setPlacementRejection(null));
    expect(tool('placement-confirm').disabled).toBe(false);
    act(() => setPlacementHeld(true));
    expect(tool('placement-confirm').disabled).toBe(true);
    act(() => setPlacementHeld(false));
    expect(tool('placement-confirm').disabled).toBe(false);
  });

  it('Rotate turns a quarter turn; Mirror flips and shows pressed; neither places', () => {
    setPlacementRotationDeg(0);
    setPlacementMirror(false);
    act(() => { useUIStore.setState({ placementKind: 'solar' }); });
    mount();
    fireEvent.click(tool('placement-rotate'));
    expect(getPlacementRotationDeg()).toBe(90);
    expect(tool('placement-mirror').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(tool('placement-mirror'));
    expect(getPlacementMirror()).toBe(true);
    expect(tool('placement-mirror').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(tool('placement-mirror'));
    expect(getPlacementMirror()).toBe(false);
    expect(commitChosenPlacement).not.toHaveBeenCalled();
    expect(useUIStore.getState().placementKind).toBe('solar');
  });

  it('a pick folds the Build panel to the strip; the building icon reopens it (strip hidden); a new pick folds back', () => {
    mount();
    act(() => useUIStore.getState().setRightPanel('build'));
    pick('economy', 'solar');
    expect(buildOpen()).toBe(false);
    expect(stripOpen()).toBe(true);
    expect(tool('placement-kind').dataset.state).toBe('solar');

    fireEvent.click(tool('placement-kind'));
    expect(buildOpen()).toBe(true);
    expect(useUIStore.getState().rightPanel).toBe('build');
    expect(useUIStore.getState().placementKind).toBe('solar');
    expect(stripOpen()).toBe(false);

    pick('defence', 'turret');
    expect(buildOpen()).toBe(false);
    expect(tool('placement-kind').dataset.state).toBe('turret');
  });

  it('✕ stops placing and the Build panel comes back; Build stays', () => {
    mount();
    act(() => useUIStore.getState().setRightPanel('build'));
    pick('economy', 'solar');
    fireEvent.click(tool('placement-cancel'));
    expect(useUIStore.getState().placementKind).toBeNull();
    expect(useUIStore.getState().buildMode).toBe(true);
    expect(screen.queryByTestId('placement-kind')).toBeNull();
    expect(buildOpen()).toBe(true);
    expect(screen.getByTestId('build-kinds')).toHaveAttribute('data-category', 'economy');
  });
});
