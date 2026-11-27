/**
 * UI plan U3-7, selection HUD S4: the placing tools (placingStripItems.tsx)
 * are do-hexes (icon + word): Place under the thumb, Cancel in the far corner;
 * the left strip draws nothing while placing.
 * - Place goes through the one commit path (`commitPlacement`) and keeps
 *   placing until ✕, except a place-once kind; disabled while the ghost is
 *   rejected or held on the spot just sent.
 * - Rotate / Mirror use the R / F keys' functions (real module state here).
 * - The building hex reopens the Build panel, which hides the hexes; a new
 *   pick folds back to the hexes with the new kind; ✕ stops placing and the
 *   Build panel comes back. Placing wins over a selection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useUIStore } from '../state/store';
import { getPlacementMirror, getPlacementRotationDeg, setPlacementMirror, setPlacementRotationDeg } from '../structures/structurePlacementClient';
import { resetPlacementChosen, setPlacementHeld, setPlacementRejection } from '../structures/placementChosen';
import { addPlannedPlacement, clearPlacementPlan, getPlacementPlanCount } from '../structures/placementPlan';

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
import { DoHexesHost } from './DoHexesHost';
import { BuildSidebarHost } from '../components/BuildSidebarHost';

const rendererRef = { current: { selectFleetShips: vi.fn(), attackFocus: vi.fn() } };

function mount(): void {
  render(<LayoutProvider><LeftStripHost rendererRef={rendererRef} /><DoHexesHost /><BuildSidebarHost /></LayoutProvider>);
}

const tool = (id: string): HTMLButtonElement => screen.getByTestId(id) as HTMLButtonElement;
const hexesShown = (): boolean => screen.queryByTestId('placement-kind') !== null
  && screen.getByTestId('do-hexes').dataset.set === 'placing';
/** The hexes in thumb-nearness order (their cell), not DOM order (a badged hex paints last). */
const hexIds = (): (string | undefined)[] =>
  Array.from(screen.getByTestId('do-hexes').querySelectorAll('[data-cell]'))
    .sort((x, y) => Number(x.getAttribute('data-cell')) - Number(y.getAttribute('data-cell')))
    .map((c) => c.querySelector('button')?.dataset.testid);
const cellOf = (testId: string): string | null =>
  screen.getByTestId(testId).closest('[data-cell]')?.getAttribute('data-cell') ?? null;
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
  clearPlacementPlan();
  commitChosenPlacement.mockClear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('placing tools as do-hexes', () => {
  it('shows nothing while not placing', () => {
    mount();
    expect(screen.queryByTestId('placement-kind')).toBeNull();
    expect(screen.queryByTestId('placement-confirm')).toBeNull();
  });

  it('shows Place, Rotate, the building, Mirror and Cancel as hexes; the strip draws nothing', () => {
    act(() => { useUIStore.setState({ placementKind: 'solar' }); });
    mount();
    expect(hexIds()).toEqual(['placement-confirm', 'placement-rotate', 'placement-kind', 'placement-mirror', 'placement-cancel']);
    expect(tool('placement-kind').dataset.state).toBe('solar');
    for (const [id, label, word] of [
      ['placement-confirm', 'Place', 'Place'], ['placement-rotate', 'Rotate', 'Rotate'], ['placement-kind', 'Solar Array: open the Build menu', 'Solar'],
      ['placement-mirror', 'Mirror', 'Mirror'], ['placement-cancel', 'Stop placing', 'Cancel'],
    ] as const) {
      expect(tool(id).dataset.variant, id).toBe('hex');
      if (id !== 'placement-kind') expect(tool(id).getAttribute('aria-label')).toBe(label);
      expect(screen.getByTestId(`${id}-word`).textContent).toBe(word);
    }
    expect(tool('placement-kind').getAttribute('aria-label')).toMatch(/: open the Build menu$/);
    expect(screen.queryByTestId('left-strip')).toBeNull();
  });

  it('the building hex is a normal neutral hex: frame, the kind\'s short name as its word', () => {
    act(() => { useUIStore.setState({ placementKind: 'capital' }); });
    mount();
    const k = tool('placement-kind');
    expect(k.dataset.variant).toBe('hex');
    expect(k.dataset.tone).toBe('neutral');
    expect(screen.getByTestId('placement-kind-word').textContent).toBe('Capital');
  });

  it('Place is under the thumb (cell 0), Cancel in the far corner', () => {
    act(() => { useUIStore.setState({ placementKind: 'solar' }); });
    mount();
    expect(cellOf('placement-confirm')).toBe('0');
    expect(cellOf('placement-rotate')).toBe('1');
    expect(cellOf('placement-kind')).toBe('2');
    expect(cellOf('placement-mirror')).toBe('3');
    expect(cellOf('placement-cancel')).toBe('4');
  });

  it('plan then Build: Build (n) shows only while buildings are planned; ✕ drops the plan', () => {
    act(() => { useUIStore.setState({ placementKind: 'solar' }); });
    mount();
    expect(screen.queryByTestId('placement-build')).toBeNull();
    act(() => { addPlannedPlacement('solar', 0, 0, 0, false, false); addPlannedPlacement('solar', 5000, 0, 0, false, false); });
    // Owner 2026-11-27: Build is a hex too (the left strip draws nothing), with a count badge.
    expect(hexIds()).toEqual(['placement-confirm', 'placement-rotate', 'placement-kind', 'placement-mirror', 'placement-build', 'placement-cancel']);
    expect(screen.queryByTestId('left-strip')).toBeNull();
    expect(tool('placement-build').dataset.variant).toBe('hex');
    expect(tool('placement-build').getAttribute('aria-label')).toBe('Build (2)');
    expect(tool('placement-build').dataset.state).toBe('2');
    expect(screen.getByTestId('placement-build-word').textContent).toBe('Build');
    expect(screen.getByTestId('placement-build-badge').textContent).toBe('2');
    expect(cellOf('placement-cancel')).toBe('5');
    fireEvent.click(tool('placement-cancel'));
    expect(getPlacementPlanCount()).toBe(0);
    expect(screen.queryByTestId('placement-build')).toBeNull();
  });

  it('a place-once kind ends placing with its building planned: Build and ✕ stay', () => {
    act(() => { useUIStore.setState({ placementKind: null }); addPlannedPlacement('capital', 0, 0, 0, false, false); });
    mount();
    expect(hexIds()).toEqual(['placement-build', 'placement-cancel']);
    expect(screen.queryByTestId('left-strip')).toBeNull();
    fireEvent.click(tool('placement-cancel'));
    expect(getPlacementPlanCount()).toBe(0);
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
    expect(tool('placement-mirror').dataset.lit).toBe('false');
    fireEvent.click(tool('placement-mirror'));
    expect(getPlacementMirror()).toBe(true);
    expect(tool('placement-mirror').dataset.lit).toBe('true');
    fireEvent.click(tool('placement-mirror'));
    expect(getPlacementMirror()).toBe(false);
    expect(commitChosenPlacement).not.toHaveBeenCalled();
    expect(useUIStore.getState().placementKind).toBe('solar');
  });

  it('a pick folds the Build panel to the hexes; the building hex reopens it (hexes hidden); a new pick folds back', () => {
    mount();
    act(() => useUIStore.getState().setRightPanel('build'));
    pick('economy', 'solar');
    expect(buildOpen()).toBe(false);
    expect(hexesShown()).toBe(true);
    expect(tool('placement-kind').dataset.state).toBe('solar');

    fireEvent.click(tool('placement-kind'));
    expect(buildOpen()).toBe(true);
    expect(useUIStore.getState().rightPanel).toBe('build');
    expect(useUIStore.getState().placementKind).toBe('solar');
    expect(hexesShown()).toBe(false);

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

  it('a fence post on a deck adds Gate, which switches post <-> gate (edge feel P3); no Rotate / Mirror (the run lines itself up)', () => {
    act(() => { useUIStore.setState({ placementKind: 'shield_pylon', deck: true }); });
    mount();
    expect(hexIds()).toEqual(['placement-confirm', 'placement-kind', 'placement-gate', 'placement-cancel']);
    expect(tool('placement-gate').getAttribute('aria-label')).toBe('Gate');
    act(() => { addPlannedPlacement('shield_pylon', 0, 0, 0, false, true); });
    expect(hexIds()).toEqual(['placement-confirm', 'placement-kind', 'placement-gate', 'placement-build', 'placement-cancel']);
    expect(cellOf('placement-cancel')).toBe('4');
    // Build sits in the bottom row here: its badge must draw over the hex above it, so its cell paints last.
    expect(cellOf('placement-build')).toBe('3');
    const cells = screen.getByTestId('do-hexes').querySelectorAll('[data-cell]');
    expect(cells[cells.length - 1]!.contains(tool('placement-build'))).toBe(true);
    expect(screen.getByTestId('placement-build-badge').textContent).toBe('1');
    fireEvent.click(tool('placement-gate'));
    expect(useUIStore.getState().placementKind).toBe('shield_gate');
    fireEvent.click(tool('placement-gate'));
    expect(useUIStore.getState().placementKind).toBe('shield_pylon');
  });

  it('a road has no Rotate or Mirror: it lines itself up', () => {
    act(() => { useUIStore.setState({ placementKind: 'road', deck: true }); });
    mount();
    expect(hexIds()).toEqual(['placement-confirm', 'placement-kind', 'placement-cancel']);
  });

  it('no Gate off a deck room or for other kinds', () => {
    act(() => { useUIStore.setState({ placementKind: 'shield_pylon', deck: false }); });
    mount();
    expect(screen.queryByTestId('placement-gate')).toBeNull();
    act(() => { useUIStore.setState({ placementKind: 'solar', deck: true }); });
    expect(screen.queryByTestId('placement-gate')).toBeNull();
  });
});
