/**
 * WarpScreen "sector briefing" (Idea A) locks: the facts come from the galaxy
 * data the client already holds (galaxyStats), the progress bar is the real
 * join percentage, and the owner line never shows a raw id.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { LayoutContext } from '../layout/useLayout.js';
import { WarpScreen } from './WarpScreen.js';
import { useUIStore } from '../state/store.js';
import type { SectorLiveState } from '../../shared-types/galaxySnapshot.js';
import { joinGateSteps, joinOverallPct, sectorKeyFromRoomName, JOIN_STEP_TEXT, type JoinStepId } from './sectorBriefing.js';

/** The status label names the loading step in progress. */
const stepName = (id: JoinStepId): string => JOIN_STEP_TEXT.find((s) => s.id === id)!.name;

let host: HTMLDivElement;

const GATES_OPEN = {
  phase: 'game' as const,
  connectionStatus: 'connected' as const,
  localShipInstanceId: 'ship-1',
  firstSnapshotApplied: false,
  rendererFirstFrameRendered: false,
  joinMinimumElapsed: false,
  localPoseResolved: false,
  clientReadySent: false,
  arrivalTickFromServer: null,
  arrivalAcked: false,
  travelling: false,
  pilotMode: 'pilot' as const,
  artBakeReady: false,
  artBakePct: 0,
};

function live(over: Partial<SectorLiveState>): SectorLiveState {
  return { key: 'sol-prime', players: 0, enemies: 0, neutrals: 0, structures: 0, owner: null, ...over };
}

function renderWarp(targetSectorKey: string | null = null): void {
  render(
    <LayoutContext.Provider value={{ fullscreen: host }}>
      <WarpScreen targetSectorKey={targetSectorKey} />
    </LayoutContext.Provider>,
  );
}

const fact = (id: string): string =>
  screen.getByTestId(`warp-briefing-fact-${id}`).textContent ?? '';

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  useUIStore.setState({ ...GATES_OPEN, currentSectorKey: null, transitTargetSectorKey: null, galaxyStats: [], shipRoster: [] });
});

afterEach(() => {
  host.remove();
});

describe('WarpScreen sector briefing', () => {
  it('renders the sector name, holder and live facts from mocked galaxy data', () => {
    useUIStore.setState({
      currentSectorKey: 'sol-prime',
      galaxyStats: [live({ players: 3, structures: 7, enemies: 2, owner: { factionId: 'robots', contested: false } })],
    });
    renderWarp();
    expect(screen.getByTestId('warp-briefing-name').textContent).toBe('Sol Prime');
    expect(screen.getByTestId('warp-briefing-owner').textContent).toBe('Held by Robot Dominion');
    expect(fact('pilots')).toBe('Pilots3');
    expect(fact('structures')).toBe('Structures7');
    expect(fact('rocks')).toBe('Rock fieldDense field');
    expect(fact('threat')).toBe('Threat2 hostile');
  });

  it('names the join target before welcome, and reads Unclaimed with no holder', () => {
    useUIStore.setState({ localShipInstanceId: null, currentSectorKey: 'sol-prime', galaxyStats: [live({ key: 'vega-reach' })] });
    renderWarp('vega-reach');
    expect(screen.getByTestId('warp-screen-status').textContent).toBe(stepName('ship'));
    expect(screen.getByTestId('warp-briefing-name').textContent).toBe('Vega Reach');
    expect(screen.getByTestId('warp-briefing-owner').textContent).toBe('Unclaimed');
    expect(fact('threat')).toBe('ThreatQuiet');
  });

  it('a commander following their fleet from a Sol Prime launch names the destination, before and after welcome (capital S5)', () => {
    // Command view: no ship id, no local trip; the Hangar launch room was Sol Prime.
    useUIStore.setState({
      pilotMode: 'spectator', localShipInstanceId: null, travelling: false,
      currentSectorKey: 'sol-prime', transitTargetSectorKey: 'vega-reach',
    });
    renderWarp('sol-prime');
    expect(screen.getByTestId('warp-briefing-name').textContent).toBe('Vega Reach');
    // The new sector's welcome: live key set, transit key cleared.
    act(() => useUIStore.setState({ currentSectorKey: 'vega-reach', transitTargetSectorKey: null }));
    expect(screen.getByTestId('warp-briefing-name').textContent).toBe('Vega Reach');
  });

  it('a stalled trip after the fallback timers still names the destination (capital S5)', () => {
    // Fallback ran (DOCKED, ARRIVED timers done) but no welcome yet: the old
    // sector is still current and the launch room was Sol Prime.
    useUIStore.setState({
      transitState: 'DOCKED', travelling: false, localShipInstanceId: null,
      currentSectorKey: 'sol-prime', transitTargetSectorKey: 'vega-reach',
    });
    renderWarp('sol-prime');
    expect(screen.getByTestId('warp-briefing-name').textContent).toBe('Vega Reach');
  });

  it('never shows a player-held sector owner as a raw id', () => {
    useUIStore.setState({
      currentSectorKey: 'sol-prime',
      galaxyStats: [live({ owner: { factionId: 'player-abc123', contested: true } })],
    });
    renderWarp();
    const owner = screen.getByTestId('warp-briefing-owner').textContent ?? '';
    expect(owner).not.toMatch(/abc123/i);
    expect(owner).toMatch(/contested/);
  });

  it('shows no briefing text for a non-galaxy room, just the bar and status', () => {
    renderWarp(null);
    expect(screen.queryByTestId('warp-briefing-name')).toBeNull();
    expect(screen.getByTestId('warp-screen-progress')).toBeTruthy();
    expect(screen.getByTestId('warp-screen-status').textContent).toBe(stepName('sector'));
  });

  it('the progress bar shows the real join percentage, ticking up with the bake', () => {
    renderWarp();
    const pct = (): number => Number(screen.getByTestId('warp-screen-progress').getAttribute('data-pct'));
    const overall = (): number => joinOverallPct(joinGateSteps(useUIStore.getState()));
    expect(pct()).toBe(overall());
    act(() => useUIStore.setState({ rendererFirstFrameRendered: true, firstSnapshotApplied: true }));
    const beforeBake = pct();
    expect(beforeBake).toBe(overall());
    act(() => useUIStore.getState().setArtBake(50, false));
    expect(pct()).toBeGreaterThan(beforeBake);
    expect(pct()).toBe(overall());
    expect(screen.getByTestId('warp-overall-pct').textContent).toBe(`${pct()}%`);
    act(() => useUIStore.setState({ joinMinimumElapsed: true, localPoseResolved: true, clientReadySent: true, arrivalTickFromServer: 42 }));
    expect(screen.getByTestId('warp-screen-status').textContent).toBe(stepName('arrive'));
    expect(pct()).toBeLessThan(100);
  });

  it('shows the pilot faction sigil, not a radar', () => {
    useUIStore.setState({ currentSectorKey: 'sol-prime' });
    renderWarp();
    expect(screen.getByTestId('warp-briefing-emblem')).toBeTruthy();
    expect(screen.queryByTestId('warp-briefing-radar')).toBeNull();
  });

  it('shows one fun line in one fixed spot', () => {
    renderWarp();
    expect(screen.getAllByTestId('warp-quips')).toHaveLength(1);
  });
});

describe('sectorBriefing helpers', () => {
  it('sectorKeyFromRoomName resolves only real galaxy sectors', () => {
    expect(sectorKeyFromRoomName('galaxy-sol-prime')).toBe('sol-prime');
    expect(sectorKeyFromRoomName('galaxy-test')).toBeNull();
    expect(sectorKeyFromRoomName('sector')).toBeNull();
    expect(sectorKeyFromRoomName(undefined)).toBeNull();
  });

  it('unmounts the briefing once loading lifts (no stale "Arriving at" text or roster re-renders in play)', () => {
    useUIStore.setState({ currentSectorKey: 'sol-prime', galaxyStats: [live({ players: 2 })] });
    renderWarp();
    expect(screen.getByTestId('warp-screen').getAttribute('data-warp-visible')).toBe('1');
    expect(screen.getByTestId('warp-briefing-name').textContent).toBe('Sol Prime');
    act(() => useUIStore.setState({
      firstSnapshotApplied: true, rendererFirstFrameRendered: true, joinMinimumElapsed: true,
      localPoseResolved: true, clientReadySent: true, arrivalTickFromServer: 1, arrivalAcked: true,
    }));
    expect(screen.getByTestId('warp-screen').getAttribute('data-warp-visible')).toBe('0');
    expect(screen.queryByTestId('warp-briefing')).toBeNull();
    expect(host.textContent).not.toContain('Arriving at');
    expect(host.textContent).not.toContain('Sol Prime');
    // The terminal status stays (e2e join-warp-screen locks it), off the a11y tree.
    expect(screen.getByTestId('warp-screen-status').textContent).toBe('WARP COMPLETE');
    expect(screen.getByTestId('warp-screen').getAttribute('aria-hidden')).toBe('true');
    // A re-arm (respawn) mounts it again.
    act(() => useUIStore.setState({ firstSnapshotApplied: false }));
    expect(screen.getByTestId('warp-briefing-name').textContent).toBe('Sol Prime');
  });
});
