/**
 * UI plan U3-3: route and target picks show their doing-tools on the left
 * strip (route icon, ✓, undo, ✕), icons only. Each tool calls the existing
 * pick action once; the tools vanish when the pick ends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useUIStore } from '../state/store';
import { resetFleetStatus } from '../fleet/fleetStatus';
import { resetFleetCommands, setFleetCommands } from '../fleet/fleetCommands';
import { LayoutProvider } from './LayoutProvider';
import { LeftStripHost } from './LeftStripHost';
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
  render(<LayoutProvider><LeftStripHost rendererRef={rendererRef} /></LayoutProvider>);
}

function startPick(kind: 'patrol' | 'escort' | 'retreat' | 'move'): void {
  act(() => {
    useUIStore.setState({ selection: { ids: ['a', 'b'], focusId: null, focusKind: null } });
    useUIStore.getState().setFleetPick(kind);
  });
}

const TOOLS = ['left-strip-route', 'left-strip-route-done', 'left-strip-route-undo', 'left-strip-route-cancel'];

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

describe('left strip route tools (U3-3)', () => {
  it('a patrol pick shows the four tools, icons only, in place of the selection strip', () => {
    mount();
    startPick('patrol');
    for (const t of TOOLS) {
      const el = screen.getByTestId(t);
      expect(el.getAttribute('aria-label'), t).toBeTruthy();
      expect(el.textContent, t).toBe('');
    }
    expect(screen.getByTestId('left-strip-route').getAttribute('aria-label')).toMatch(/points for the patrol route/);
    expect(screen.getByTestId('left-strip-route').querySelector('svg')?.getAttribute('data-icon')).toBe('route');
    expect(screen.queryByTestId('left-strip-order'), 'the fleet section gives way').toBeNull();
    expect(screen.queryByTestId('left-strip-cog')).toBeNull();
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
    expect(screen.getByTestId('left-strip-route-done')).toBeDisabled();
    act(() => useUIStore.getState().setFleetPickPoints(1));
    expect(screen.getByTestId('left-strip-route-done')).toBeDisabled();
    act(() => useUIStore.getState().setFleetPickPoints(2));
    expect(screen.getByTestId('left-strip-route-done')).toBeEnabled();
    fireEvent.click(screen.getByTestId('left-strip-route-done'));
    expect(useUIStore.getState().fleetPick?.doneSeq).toBe(1);
    expect(useUIStore.getState().fleetPick?.undoSeq).toBe(0);
    expect(cmd.setMode, 'the renderer sends the route, not the strip').not.toHaveBeenCalled();
  });

  it('undo needs a point and asks the renderer to drop one once', () => {
    mount();
    startPick('patrol');
    expect(screen.getByTestId('left-strip-route-undo')).toBeDisabled();
    act(() => useUIStore.getState().setFleetPickPoints(3));
    fireEvent.click(screen.getByTestId('left-strip-route-undo'));
    expect(useUIStore.getState().fleetPick?.undoSeq).toBe(1);
    expect(useUIStore.getState().fleetPick?.doneSeq).toBe(0);
    expect(useUIStore.getState().fleetPick?.kind).toBe('patrol');
  });

  it('✕ cancels the pick once; the tools vanish and the selection strip comes back', () => {
    mount();
    startPick('patrol');
    fireEvent.click(screen.getByTestId('left-strip-route-cancel'));
    expect(useUIStore.getState().fleetPick).toBeNull();
    for (const t of TOOLS) expect(screen.queryByTestId(t), t).toBeNull();
    expect(screen.getByTestId('left-strip-order')).toBeTruthy();
    expect(cmd.setMode).not.toHaveBeenCalled();
  });

  it('the tools vanish when the pick ends elsewhere (route sent, Esc)', () => {
    mount();
    startPick('patrol');
    expect(screen.getByTestId('left-strip-route')).toBeTruthy();
    act(() => useUIStore.getState().setFleetPick(null));
    for (const t of TOOLS) expect(screen.queryByTestId(t), t).toBeNull();
  });

  it('escort: the escort icon and ✕ only', () => {
    mount();
    startPick('escort');
    const id = screen.getByTestId('left-strip-route');
    expect(id.getAttribute('aria-label')).toMatch(/other ships to escort/);
    expect(id.querySelector('svg')?.getAttribute('data-icon')).toBe('escort');
    expect(screen.queryByTestId('left-strip-route-done')).toBeNull();
    expect(screen.queryByTestId('left-strip-route-undo')).toBeNull();
    expect(screen.queryByTestId('left-strip-route-post')).toBeNull();
    expect(screen.getByTestId('left-strip-route-cancel')).toBeTruthy();
  });

  it('retreat: ✓ is back to post, one retreat order with no point, and the pick ends', () => {
    mount();
    startPick('retreat');
    expect(screen.getByTestId('left-strip-route').getAttribute('aria-label')).toMatch(/where to retreat to/);
    fireEvent.click(screen.getByTestId('left-strip-route-post'));
    expect(cmd.setMode).toHaveBeenCalledTimes(1);
    expect(cmd.setMode).toHaveBeenCalledWith(['a', 'b'], 'retreat');
    expect(useUIStore.getState().fleetPick).toBeNull();
    expect(screen.queryByTestId('left-strip-route')).toBeNull();
  });

  it('a Move pick is not a doing mode: the fleet section stays with Move pressed', () => {
    mount();
    startPick('move');
    expect(screen.queryByTestId('left-strip-route')).toBeNull();
    expect(screen.getByTestId('left-strip-move').getAttribute('aria-pressed')).toBe('true');
  });

  it('starting a pick closes the right panel so the strip (and the map) show', () => {
    mount();
    act(() => { useUIStore.setState({ rightPanel: 'orders' }); });
    startPick('patrol');
    expect(useUIStore.getState().rightPanel).toBeNull();
    expect(screen.getByTestId('left-strip-route')).toBeTruthy();
  });
});
