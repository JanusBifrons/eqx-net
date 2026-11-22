/**
 * UI plan U3-4: the left strip's fleet section. Order / Stance fly-outs
 * and Stop show only for own ships in Command; one pick sends one order through
 * the fleet command seam (the panel's path); Patrol starts the map pick; a
 * mixed selection shows the neutral icon; Esc closes an open fly-out first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useUIStore } from '../state/store';
import { applyFleetStatus, resetFleetStatus, type FleetStatusUpdate } from '../fleet/fleetStatus';
import { resetFleetCommands, setFleetCommands } from '../fleet/fleetCommands';
import { LayoutProvider } from './LayoutProvider';
import { LeftStripHost } from './LeftStripHost';

function stubMedia(): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('reduce'), media: q, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

const row = (id: string, over: Partial<FleetStatusUpdate> = {}): FleetStatusUpdate => ({
  id, mode: 'defend', stance: 'defensive', activity: 'guarding', targetId: null, ...over,
});

const cmd = { setMode: vi.fn(), setStance: vi.fn(), stop: vi.fn(), setSpeed: vi.fn() };
const rendererRef = { current: { selectFleetShips: vi.fn() } };

function mount(): void {
  render(<LayoutProvider><LeftStripHost rendererRef={rendererRef} /></LayoutProvider>);
}

function select(ids: string[], focusId: string | null = null, focusKind: 'ship' | 'structure' | null = null): void {
  act(() => { useUIStore.setState({ selection: { ids, focusId, focusKind } }); });
}

function pick(flyout: string, option: string): void {
  fireEvent.click(screen.getByTestId(`left-strip-${flyout}`));
  fireEvent.click(screen.getByTestId(`left-strip-${flyout}-option-${option}`));
}

beforeEach(() => {
  stubMedia();
  resetFleetStatus();
  setFleetCommands(cmd);
  useUIStore.setState({
    phase: 'game', rightPanel: null, contactsOpen: false, travelling: true, pilotMode: 'spectator',
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

describe('left strip fleet section (U3-4)', () => {
  it('own ships in Command: Order, Stance and Stop, each with a tooltip, no text', () => {
    mount();
    select(['a', 'b']);
    for (const t of ['order', 'stance', 'stop']) {
      const el = screen.getByTestId(`left-strip-${t}`);
      expect(el.getAttribute('aria-label'), t).toBeTruthy();
      expect(el.textContent, t).toBe('');
    }
  });

  it('none in Fly, none in Build, none for a focus-only pick', () => {
    mount();
    select(['a']);
    act(() => { useUIStore.setState({ pilotMode: 'pilot' }); });
    expect(screen.queryByTestId('left-strip-order')).toBeNull();
    act(() => { useUIStore.setState({ pilotMode: 'spectator', buildMode: true }); });
    expect(screen.queryByTestId('left-strip-order')).toBeNull();
    act(() => { useUIStore.setState({ buildMode: false }); });
    select([], 's1', 'structure');
    expect(screen.getByTestId('left-strip')).toBeTruthy();
    expect(screen.queryByTestId('left-strip-order')).toBeNull();
    expect(screen.queryByTestId('left-strip-stop')).toBeNull();
  });

  it('one pick sends one order with the selected ids', () => {
    mount();
    select(['a', 'b']);
    pick('order', 'hunt');
    expect(cmd.setMode).toHaveBeenCalledTimes(1);
    expect(cmd.setMode).toHaveBeenCalledWith(['a', 'b'], 'hunt');
    pick('stance', 'holdFire');
    expect(cmd.setStance).toHaveBeenCalledTimes(1);
    expect(cmd.setStance).toHaveBeenCalledWith(['a', 'b'], 'holdFire');
    fireEvent.click(screen.getByTestId('left-strip-stop'));
    expect(cmd.stop).toHaveBeenCalledTimes(1);
    expect(cmd.stop).toHaveBeenCalledWith(['a', 'b']);
    expect(screen.queryByTestId('left-strip-order-options')).toBeNull();
  });

  it('Patrol starts the map pick instead of sending', () => {
    mount();
    select(['a']);
    pick('order', 'patrol');
    expect(cmd.setMode).not.toHaveBeenCalled();
    expect(useUIStore.getState().fleetPick?.kind).toBe('patrol');
  });

  it('shows the shared value; a mixed selection is neutral (no option active)', () => {
    applyFleetStatus([row('a', { stance: 'holdFire' }), row('b', { mode: 'hunt', stance: 'holdFire' })]);
    mount();
    select(['a', 'b']);
    expect(screen.getByTestId('left-strip-stance').getAttribute('aria-label')).toBe('Stance: Hold fire');
    expect(screen.getByTestId('left-strip-order').getAttribute('aria-label')).toBe('Order: mixed');
    fireEvent.click(screen.getByTestId('left-strip-order'));
    const opts = screen.getByTestId('left-strip-order-options');
    expect(opts.querySelector('[data-active="true"]')).toBeNull();
  });

  it('Esc closes an open fly-out without clearing anything else', () => {
    mount();
    select(['a']);
    fireEvent.click(screen.getByTestId('left-strip-stance'));
    expect(screen.getByTestId('left-strip-stance-options')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('left-strip-stance-options')).toBeNull();
    expect(useUIStore.getState().selection.ids).toEqual(['a']);
    expect(cmd.setStance).not.toHaveBeenCalled();
  });
});
