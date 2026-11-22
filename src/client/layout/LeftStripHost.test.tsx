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
import { LeftStripHost, stripHealth, stripIdentity } from './LeftStripHost';

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

  it('a focus-only pick: ⚙ opens its Details panel (U3-2)', () => {
    mount();
    select([], 's1', 'structure');
    expect(screen.getByTestId('left-strip-identity').getAttribute('aria-label')).toBe('Structure');
    fireEvent.click(screen.getByTestId('left-strip-cog'));
    expect(useUIStore.getState().rightPanel).toBe('details');
    expect(screen.getByTestId('left-strip').getAttribute('data-open')).toBe('false');
  });

  it("another player's ship: ⚙ opens Details, not Fleet", () => {
    mount();
    select([], 'p2', 'ship');
    fireEvent.click(screen.getByTestId('left-strip-cog'));
    expect(useUIStore.getState().rightPanel).toBe('details');
  });
});

describe('stripHealth', () => {
  it('rings the hull by the hull thresholds; ok when unknown or hull-less', () => {
    expect(stripHealth(null)).toBe('ok');
    expect(stripHealth({ name: 'x', hpPct: 10, shieldPct: null, pending: true })).toBe('ok');
    expect(stripHealth({ name: 'x', hpPct: 0, shieldPct: null, noHull: true })).toBe('ok');
    expect(stripHealth({ name: 'x', hpPct: 80, shieldPct: null })).toBe('ok');
    expect(stripHealth({ name: 'x', hpPct: 40, shieldPct: null })).toBe('warn');
    expect(stripHealth({ name: 'x', hpPct: 20, shieldPct: null })).toBe('crit');
  });
});

describe('stripIdentity', () => {
  it('maps the selection to icon, count and panel', () => {
    expect(stripIdentity({ ids: [], focusId: null, focusKind: null })).toBeNull();
    expect(stripIdentity({ ids: ['a'], focusId: 'a', focusKind: 'ship' })).toMatchObject({ icon: 'fleet', count: 1, panel: 'fleet' });
    expect(stripIdentity({ ids: [], focusId: 'd', focusKind: 'drone' })).toMatchObject({ icon: 'ship', count: 1, panel: 'details' });
  });

  it('never names the selection with an icon a strip button uses (one icon, one meaning)', () => {
    // Target, Cargo/Open pod, Pilot, Stop, cog, close: the buttons a strip can carry.
    const actions = new Set(['target', 'hold', 'pilot', 'stop', 'cog', 'close']);
    for (const kind of ['ship', 'lingering', 'drone', 'structure', 'asteroid', 'pod'] as const) {
      expect(actions.has(stripIdentity({ ids: [], focusId: 'x', focusKind: kind })!.icon)).toBe(false);
    }
  });
});
