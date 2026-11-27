/**
 * UI plan U3-3, selection HUD S4: route and target picks show their
 * doing-tools as do-hexes (the pick, Done, Undo, Cancel; icon + word), built
 * from the route builder's data; the left strip draws nothing meanwhile. Each
 * tool calls the existing pick action once; the tools vanish when the pick ends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useUIStore } from '../state/store';
import { resetFleetStatus } from '../fleet/fleetStatus';
import { resetFleetCommands, setFleetCommands } from '../fleet/fleetCommands';
import { LayoutProvider } from './LayoutProvider';
import { LeftStripHost } from './LeftStripHost';
import { DoHexesHost } from './DoHexesHost';
import { useRouteStripItems } from './routeStripItems';

function stubMedia(): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('reduce'), media: q, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

const cmd = { setMode: vi.fn(), setStance: vi.fn(), stop: vi.fn(), setSpeed: vi.fn() };
const rendererRef = { current: { selectFleetShips: vi.fn() } };

function mount(): void {
  render(<LayoutProvider><LeftStripHost rendererRef={rendererRef} /><DoHexesHost /></LayoutProvider>);
}

function startPick(kind: 'patrol' | 'escort' | 'retreat' | 'move'): void {
  act(() => {
    useUIStore.setState({ selection: { ids: ['a', 'b'], focusId: null, focusKind: null } });
    useUIStore.getState().setFleetPick(kind);
  });
}

const TOOLS = ['do-hex-route', 'do-hex-route-done', 'do-hex-route-undo', 'do-hex-route-cancel'];

beforeEach(() => {
  stubMedia();
  resetFleetStatus();
  setFleetCommands(cmd);
  useUIStore.setState({
    phase: 'game', rightPanel: null, travelling: true, pilotMode: 'spectator',
    buildMode: false, placementKind: null, fleetPick: null, commandSpeed: 3,
    selection: { ids: [], focusId: null, focusKind: null },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const f of Object.values(cmd)) f.mockReset();
  resetFleetCommands();
});

const cellOf = (testId: string): string | null =>
  screen.getByTestId(testId).closest('[data-cell]')?.getAttribute('data-cell') ?? null;

describe('route tools as do-hexes (U3-3, selection HUD S4)', () => {
  it('a patrol pick shows the four tools as hexes (icon + word); the strip draws nothing', () => {
    mount();
    startPick('patrol');
    for (const t of TOOLS) {
      const el = screen.getByTestId(t);
      expect(el.getAttribute('aria-label'), t).toBeTruthy();
      expect(el.dataset.variant, t).toBe('hex');
      expect(el.textContent, t).not.toBe('');
    }
    expect(screen.getByTestId('do-hexes').dataset.set).toBe('route');
    expect(screen.getByTestId('do-hex-route').getAttribute('aria-label')).toMatch(/points for the patrol route/);
    expect(screen.getByTestId('do-hex-route').querySelector('svg')?.getAttribute('data-icon')).toBe('route');
    expect(screen.getByTestId('do-hex-route-word').textContent).toBe('Route 0');
    expect(screen.queryByTestId('left-strip'), 'every tool is a hex').toBeNull();
    expect(screen.queryByTestId('left-strip-order'), 'the fleet section gives way').toBeNull();
    expect(screen.queryByTestId('do-hex-move'), 'the fleet hexes give way').toBeNull();
  });

  it('Done under the thumb, Cancel in the far corner', () => {
    mount();
    startPick('patrol');
    expect(cellOf('do-hex-route-done')).toBe('0');
    expect(cellOf('do-hex-route-undo')).toBe('1');
    expect(cellOf('do-hex-route')).toBe('2');
    expect(cellOf('do-hex-route-cancel')).toBe('3');
  });

  it('returns data: identity, ✓, undo, separator, ✕; null with no pick', () => {
    const { result, rerender } = renderHook(() => useRouteStripItems());
    expect(result.current).toBeNull();
    startPick('patrol');
    rerender();
    expect(result.current?.map((a) => a.kind)).toEqual(['identity', 'button', 'button', 'separator', 'button']);
    expect(result.current?.[0]).toMatchObject({ icon: 'route', health: 'ok', state: 'patrol', count: 0, testId: 'left-strip-route' });
    expect(result.current?.[1]).toMatchObject({ icon: 'confirm', tone: 'primary', disabled: true, testId: 'left-strip-route-done' });
  });

  it('✓ needs 2 points and asks the renderer for the route once', () => {
    mount();
    startPick('patrol');
    expect(screen.getByTestId('do-hex-route-done')).toBeDisabled();
    act(() => useUIStore.getState().setFleetPickPoints(1));
    expect(screen.getByTestId('do-hex-route-done')).toBeDisabled();
    act(() => useUIStore.getState().setFleetPickPoints(2));
    expect(screen.getByTestId('do-hex-route-done')).toBeEnabled();
    fireEvent.click(screen.getByTestId('do-hex-route-done'));
    expect(useUIStore.getState().fleetPick?.doneSeq).toBe(1);
    expect(useUIStore.getState().fleetPick?.undoSeq).toBe(0);
    expect(cmd.setMode, 'the renderer sends the route, not the strip').not.toHaveBeenCalled();
  });

  it('undo needs a point and asks the renderer to drop one once', () => {
    mount();
    startPick('patrol');
    expect(screen.getByTestId('do-hex-route-undo')).toBeDisabled();
    act(() => useUIStore.getState().setFleetPickPoints(3));
    fireEvent.click(screen.getByTestId('do-hex-route-undo'));
    expect(useUIStore.getState().fleetPick?.undoSeq).toBe(1);
    expect(useUIStore.getState().fleetPick?.doneSeq).toBe(0);
    expect(useUIStore.getState().fleetPick?.kind).toBe('patrol');
  });

  it('✕ cancels the pick once; the tools vanish and the selection strip comes back', () => {
    mount();
    startPick('patrol');
    fireEvent.click(screen.getByTestId('do-hex-route-cancel'));
    expect(useUIStore.getState().fleetPick).toBeNull();
    for (const t of TOOLS) expect(screen.queryByTestId(t), t).toBeNull();
    expect(screen.getByTestId('who-hexes')).toBeTruthy();
    expect(cmd.setMode).not.toHaveBeenCalled();
  });

  it('the tools vanish when the pick ends elsewhere (route sent, Esc)', () => {
    mount();
    startPick('patrol');
    expect(screen.getByTestId('do-hex-route')).toBeTruthy();
    act(() => useUIStore.getState().setFleetPick(null));
    for (const t of TOOLS) expect(screen.queryByTestId(t), t).toBeNull();
  });

  it('escort: the escort icon and ✕ only', () => {
    mount();
    startPick('escort');
    const id = screen.getByTestId('do-hex-route');
    expect(id.getAttribute('aria-label')).toMatch(/other ships to escort/);
    expect(id.querySelector('svg')?.getAttribute('data-icon')).toBe('escort');
    expect(screen.queryByTestId('do-hex-route-done')).toBeNull();
    expect(screen.queryByTestId('do-hex-route-undo')).toBeNull();
    expect(screen.queryByTestId('do-hex-route-post')).toBeNull();
    expect(screen.getByTestId('do-hex-route-cancel')).toBeTruthy();
  });

  it('retreat: ✓ is back to post, one retreat order with no point, and the pick ends', () => {
    mount();
    startPick('retreat');
    expect(screen.getByTestId('do-hex-route').getAttribute('aria-label')).toMatch(/where to retreat to/);
    fireEvent.click(screen.getByTestId('do-hex-route-post'));
    expect(cmd.setMode).toHaveBeenCalledTimes(1);
    expect(cmd.setMode).toHaveBeenCalledWith(['a', 'b'], 'retreat');
    expect(useUIStore.getState().fleetPick).toBeNull();
    expect(screen.queryByTestId('do-hex-route')).toBeNull();
  });

  it('a Move pick is not a doing mode: no route tools, the who-hexes stay (the Move do-hex shows it armed)', () => {
    mount();
    startPick('move');
    expect(screen.queryByTestId('do-hex-route')).toBeNull();
    expect(screen.getByTestId('who-hexes')).toBeTruthy();
  });

  it('starting a pick closes the right panel so the strip (and the map) show', () => {
    mount();
    act(() => { useUIStore.setState({ rightPanel: 'orders' }); });
    startPick('patrol');
    expect(useUIStore.getState().rightPanel).toBeNull();
    expect(screen.getByTestId('do-hex-route')).toBeTruthy();
  });
});
