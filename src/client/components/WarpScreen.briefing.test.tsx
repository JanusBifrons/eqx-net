/**
 * WarpScreen "sector briefing" (Idea A) locks: the facts come from the galaxy
 * data the client already holds (galaxyStats / shipRoster), the progress bar
 * counts REAL join gates, and the owner line never shows a raw id.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { LayoutContext } from '../layout/useLayout.js';
import { WarpScreen } from './WarpScreen.js';
import { useUIStore } from '../state/store.js';
import type { SectorLiveState } from '../../shared-types/galaxySnapshot.js';
import type { RosterEntry } from '../state/storeTypes.js';
import { buildSectorBriefing, joinGatesDone, sectorKeyFromRoomName, JOIN_GATE_COUNT, JOIN_STEP_TEXT, type JoinStepId } from './sectorBriefing.js';

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

  it('the progress bar advances one step per real gate', () => {
    renderWarp();
    const done = (): string | null => screen.getByTestId('warp-screen-progress').getAttribute('data-gates-done');
    expect(done()).toBe('2'); // connected + ship id
    act(() => useUIStore.setState({ rendererFirstFrameRendered: true, firstSnapshotApplied: true }));
    expect(done()).toBe('4');
    act(() => useUIStore.setState({ joinMinimumElapsed: true, localPoseResolved: true, clientReadySent: true }));
    expect(done()).toBe('7');
    act(() => useUIStore.setState({ arrivalTickFromServer: 42 }));
    expect(done()).toBe('8');
    expect(screen.getByTestId('warp-screen-status').textContent).toBe(stepName('arrive'));
  });

  it('plots own roster hulls in the sector as radar blips, none elsewhere', () => {
    const ship = (shipId: string, sectorKey: string): RosterEntry => ({
      shipId, kind: 'fighter', kindVersion: 1, health: 100, sectorKey, x: 0, y: 0, isActive: false,
    });
    useUIStore.setState({ currentSectorKey: 'sol-prime', shipRoster: [ship('a', 'sol-prime'), ship('b', 'vega-reach')] });
    renderWarp();
    expect(screen.getByTestId('warp-briefing-radar').getAttribute('data-blips')).toBe('1');
  });
});

describe('sectorBriefing helpers', () => {
  it('joinGatesDone counts all gates and treats a shipless spectator as having ship + pose', () => {
    const all = {
      connectionStatus: 'connected' as const, localShipInstanceId: 's', rendererFirstFrameRendered: true,
      firstSnapshotApplied: true, joinMinimumElapsed: true, localPoseResolved: true, clientReadySent: true,
      arrivalTickFromServer: 1, arrivalAcked: true, pilotMode: 'pilot' as const,
    };
    expect(joinGatesDone(all)).toBe(JOIN_GATE_COUNT);
    expect(joinGatesDone({ ...all, localShipInstanceId: null, localPoseResolved: false, pilotMode: 'spectator' })).toBe(JOIN_GATE_COUNT);
  });

  it('sectorKeyFromRoomName resolves only real galaxy sectors', () => {
    expect(sectorKeyFromRoomName('galaxy-sol-prime')).toBe('sol-prime');
    expect(sectorKeyFromRoomName('galaxy-test')).toBeNull();
    expect(sectorKeyFromRoomName('sector')).toBeNull();
    expect(sectorKeyFromRoomName(undefined)).toBeNull();
  });

  it('blips clamp to the radar rim and flip game Y', () => {
    const far: RosterEntry = { shipId: 'f', kind: 'fighter', kindVersion: 1, health: 1, sectorKey: 'sol-prime', x: 0, y: 1e9, isActive: false };
    const b = buildSectorBriefing('sol-prime', [], [far])!;
    expect(b.blips[0]!.cx).toBeCloseTo(50);
    expect(b.blips[0]!.cy).toBeCloseTo(6);
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
