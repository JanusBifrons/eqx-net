/**
 * UI plan U1-8: the left strip host. Shows the selection strip only while
 * something is selected; slides away while a right panel is open and comes
 * back when it closes; ⚙ opens the selection's panel; ✕ deselects through
 * the renderer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useUIStore } from '../state/store';
import { LayoutProvider } from './LayoutProvider';
import { LeftStripHost, stripIdentity } from './LeftStripHost';

function stubMedia(): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('reduce'), media: q, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

const selectFleetShips = vi.fn();
const rendererRef = { current: { selectFleetShips } };

function mount(): void {
  render(<LayoutProvider><LeftStripHost rendererRef={rendererRef} /></LayoutProvider>);
}

function select(ids: string[], focusId: string | null = null, focusKind: 'ship' | 'structure' | null = null): void {
  act(() => { useUIStore.setState({ selection: { ids, focusId, focusKind } }); });
}

beforeEach(() => {
  stubMedia();
  useUIStore.setState({
    rightPanel: null, contactsOpen: false, travelling: true, pilotMode: 'spectator',
    buildMode: false, placementKind: null, fleetPick: null,
    selection: { ids: [], focusId: null, focusKind: null },
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); selectFleetShips.mockReset(); });

describe('LeftStripHost (U1-8)', () => {
  it('nothing selected: no strip', () => {
    mount();
    expect(screen.queryByTestId('left-strip')).toBeNull();
  });

  it('a ship group shows the identity with its count', () => {
    mount();
    select(['a', 'b', 'c']);
    expect(screen.getByTestId('left-strip').getAttribute('data-open')).toBe('true');
    expect(screen.getByTestId('left-strip-identity').getAttribute('aria-label')).toBe('3 ships selected');
  });

  it('panel open: strip hidden; panel closed: strip back', () => {
    mount();
    select(['a']);
    act(() => { useUIStore.getState().setRightPanel('galaxy'); });
    expect(screen.getByTestId('left-strip').getAttribute('data-open')).toBe('false');
    act(() => { useUIStore.getState().setRightPanel(null); });
    expect(screen.getByTestId('left-strip').getAttribute('data-open')).toBe('true');
  });

  it('⚙ opens the selection\'s panel (Fleet for own ships)', () => {
    mount();
    select(['a', 'b']);
    fireEvent.click(screen.getByTestId('left-strip-cog'));
    expect(useUIStore.getState().rightPanel).toBe('fleet');
    expect(screen.getByTestId('left-strip').getAttribute('data-open')).toBe('false');
  });

  it('✕ deselects through the renderer (it owns the selection)', () => {
    mount();
    select([], 's1', 'structure');
    fireEvent.click(screen.getByTestId('left-strip-close'));
    expect(selectFleetShips).toHaveBeenCalledWith([]);
  });

  it('a focus-only pick has no ⚙ until its Details panel exists', () => {
    mount();
    select([], 's1', 'structure');
    expect(screen.getByTestId('left-strip-identity').getAttribute('aria-label')).toBe('Structure');
    expect(screen.queryByTestId('left-strip-cog')).toBeNull();
  });
});

describe('stripIdentity', () => {
  it('maps the selection to icon, count and panel', () => {
    expect(stripIdentity({ ids: [], focusId: null, focusKind: null })).toBeNull();
    expect(stripIdentity({ ids: ['a'], focusId: 'a', focusKind: 'ship' })).toMatchObject({ icon: 'fleet', count: 1, panel: 'fleet' });
    expect(stripIdentity({ ids: [], focusId: 'd', focusKind: 'drone' })).toMatchObject({ icon: 'target', count: 1, panel: null });
  });
});
