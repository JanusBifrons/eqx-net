/**
 * Phase 5 WS-4 — the desktop RTS bottom control panel. Locks:
 *   - desktop + in-game gating (renders nothing off-game);
 *   - PILOTING keeps the palette mounted but hidden and leaves the number keys alone (the fire-control
 *     weapon strip replaced the weapon-slot row; 1–9 select weapon groups);
 *   - SPECTATING flips to the flattened building palette; number key / click
 *     selects a building for placement.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { BottomControlPanel } from './BottomControlPanel.js';

const pressKey = (key: string): void => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key }));
};

describe('BottomControlPanel (Phase 5 WS-4)', () => {
  beforeEach(() => {
    useUIStore.setState({
      phase: 'game',
      pilotMode: 'pilot',
      selectedShipKind: 'fighter',
      activeSlotId: 'primary',
      placementKind: null,
    });
  });

  it('renders nothing off-game', () => {
    useUIStore.setState({ phase: 'galaxy-map' });
    render(<BottomControlPanel />);
    expect(screen.queryByTestId('bottom-control-panel')).toBeNull();
  });

  it('PILOTING — the palette is mounted but hidden; number keys leave the slot + placement alone', () => {
    useUIStore.setState({ activeSlotId: 'bogus' });
    render(<BottomControlPanel />);
    const panel = screen.getByTestId('bottom-control-panel');
    expect(panel).toHaveAttribute('data-panel-mode', 'hidden');
    expect(panel).toHaveAttribute('aria-hidden', 'true');
    expect(getComputedStyle(panel).display).toBe('none');
    pressKey('1');
    expect(useUIStore.getState().activeSlotId).toBe('bogus');
    expect(useUIStore.getState().placementKind).toBeNull();
  });

  it('SPECTATING — economy v2: packed counts label non-starter kinds; one you have none of is greyed + unpickable', () => {
    useUIStore.setState({ pilotMode: 'spectator', packedStock: { 'structure:smelter': 2 } });
    render(<BottomControlPanel />);
    const smelter = screen.getByTestId('bcp-cell-build:smelter');
    expect(smelter.textContent).toContain('Smelter ×2');
    fireEvent.click(smelter);
    expect(useUIStore.getState().placementKind).toBe('smelter');
    useUIStore.setState({ placementKind: null });
    const turret = screen.getByTestId('bcp-cell-build:missile_turret');
    expect(turret.textContent).toContain('buy packed');
    fireEvent.click(turret);
    expect(useUIStore.getState().placementKind).toBeNull();
    // Starter kinds are never locked.
    expect(screen.getByTestId('bcp-cell-build:solar').textContent).not.toContain('buy packed');
    useUIStore.setState({ packedStock: null });
  });

  it('SPECTATING — flips to the flattened building palette; click selects a building', () => {
    useUIStore.setState({ pilotMode: 'spectator' });
    render(<BottomControlPanel />);
    expect(screen.getByTestId('bottom-control-panel')).toHaveAttribute('data-panel-mode', 'build');
    fireEvent.click(screen.getByTestId('bcp-cell-build:solar'));
    expect(useUIStore.getState().placementKind).toBe('solar');
  });

  // Frame review 2026-11-10: the hotbar ran off both screen edges while
  // spectating. jsdom has no layout (the real-browser lock is
  // tests/e2e/build-hotbar-fits-viewport.spec.ts); this locks the CSS contract:
  // the row is capped at the viewport and wraps instead of overflowing.
  it('SPECTATING — the build row is capped at the viewport and wraps', () => {
    useUIStore.setState({ pilotMode: 'spectator' });
    render(<BottomControlPanel />);
    const cs = getComputedStyle(screen.getByTestId('bottom-control-panel'));
    expect(cs.flexWrap).toBe('wrap');
    expect(cs.maxWidth).toBe('calc(100vw - 32px)');
    expect(cs.overflowY).toBe('auto');
  });

  // Perf lock (2026-11-10 death→spectator hitch, tests/perf/death-spectator-hitch.spec.ts):
  // the palette used to cold-mount ~40 MUI Tooltip cells (~860 components) in
  // the destroy-message task — a 50–70 ms frame at the explosion. It is now
  // pre-mounted while piloting, so the flip into spectator must insert ZERO DOM
  // nodes and keep every cell element (count-based, not wall-clock).
  it('the spectator flip inserts no DOM (palette pre-mounted, cells memoised)', () => {
    render(<BottomControlPanel />);
    const panel = screen.getByTestId('bottom-control-panel');
    const cellsBefore = Array.from(panel.querySelectorAll('[data-testid^="bcp-cell-"]'));
    expect(cellsBefore.length).toBeGreaterThan(0);

    let added = 0;
    const obs = new MutationObserver((records) => {
      for (const r of records) added += r.addedNodes.length;
    });
    obs.observe(document.body, { childList: true, subtree: true });
    act(() => {
      useUIStore.setState({ pilotMode: 'spectator' });
    });
    const records = obs.takeRecords();
    for (const r of records) added += r.addedNodes.length;
    obs.disconnect();

    expect(added).toBe(0);
    expect(screen.getByTestId('bottom-control-panel')).toBe(panel);
    expect(panel).toHaveAttribute('data-panel-mode', 'build');
    const cellsAfter = Array.from(panel.querySelectorAll('[data-testid^="bcp-cell-"]'));
    expect(cellsAfter.length).toBe(cellsBefore.length);
    cellsAfter.forEach((el, i) => expect(el).toBe(cellsBefore[i]));
  });

  it('SPECTATING — number key 2 selects the 2nd building (connector)', () => {
    useUIStore.setState({ pilotMode: 'spectator' });
    render(<BottomControlPanel />);
    pressKey('2'); // BUILD order: capital(1), connector(2), …
    expect(useUIStore.getState().placementKind).toBe('connector');
  });
});
