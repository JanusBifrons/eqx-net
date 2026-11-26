/**
 * WarpScreen loading-step locks: the join gates group into steps named for
 * what the game is really doing, listed in order with the first not-done step
 * marked current, each with its own percentage; the art bake shows its real
 * share; the bar is the mean of the steps, so the two never disagree.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { LayoutContext } from '../layout/useLayout.js';
import { WarpScreen } from './WarpScreen.js';
import { useUIStore } from '../state/store.js';
import {
  currentJoinStepIndex,
  JOIN_GATE_COUNT,
  JOIN_STEP_TEXT,
  joinGateSteps,
  joinOverallPct,
  type JoinGateState,
} from './sectorBriefing.js';

const NONE: JoinGateState = {
  connectionStatus: 'connecting',
  localShipInstanceId: null,
  rendererFirstFrameRendered: false,
  firstSnapshotApplied: false,
  joinMinimumElapsed: false,
  localPoseResolved: false,
  clientReadySent: false,
  arrivalTickFromServer: null,
  arrivalAcked: false,
  pilotMode: 'pilot',
  artBakeReady: false,
  artBakePct: 0,
};
const ALL: JoinGateState = {
  connectionStatus: 'connected',
  localShipInstanceId: 's',
  rendererFirstFrameRendered: true,
  firstSnapshotApplied: true,
  joinMinimumElapsed: true,
  localPoseResolved: true,
  clientReadySent: true,
  arrivalTickFromServer: 1,
  arrivalAcked: true,
  pilotMode: 'pilot',
  artBakeReady: true,
  artBakePct: 100,
};
const ORDER = ['connect', 'ship', 'sector', 'draw', 'bake', 'place', 'arrive'];

const stepOf = (s: JoinGateState, id: string) => joinGateSteps(s).find((st) => st.id === id)!;

describe('joinGateSteps', () => {
  it('lists the steps in order, covering all the gates, each with a plain name', () => {
    const steps = joinGateSteps(NONE);
    expect(steps.map((s) => s.id)).toEqual(ORDER);
    expect(JOIN_STEP_TEXT.map((s) => s.id)).toEqual(ORDER);
    expect(steps.reduce((n, s) => n + s.gates, 0)).toBe(JOIN_GATE_COUNT);
    for (const s of steps) expect(s.name.length).toBeGreaterThan(0);
    expect(steps.every((s) => s.pct === 0)).toBe(true);
    expect(joinOverallPct(steps)).toBe(0);
  });

  it('everything done reads 100% overall and per step', () => {
    const steps = joinGateSteps(ALL);
    expect(steps.every((s) => s.done && s.pct === 100)).toBe(true);
    expect(joinOverallPct(steps)).toBe(100);
    expect(currentJoinStepIndex(steps)).toBe(-1);
  });

  it('the bake step shows the real bake share, capped below 100 until ready', () => {
    const base = { ...ALL, clientReadySent: false, artBakeReady: false };
    expect(stepOf({ ...base, artBakePct: 37 }, 'bake').pct).toBe(37);
    expect(stepOf({ ...base, artBakePct: 100 }, 'bake').pct).toBe(99);
    expect(stepOf({ ...base, artBakePct: 37 }, 'bake').done).toBe(false);
    expect(stepOf({ ...base, artBakeReady: true, artBakePct: 37 }, 'bake').pct).toBe(100);
    // Once client_ready went out the bake is behind us, whatever the slice says.
    expect(stepOf({ ...base, clientReadySent: true }, 'bake').done).toBe(true);
  });

  it('the overall % moves when only the bake progresses', () => {
    const s = { ...NONE, connectionStatus: 'connected' as const, localShipInstanceId: 's', firstSnapshotApplied: true, rendererFirstFrameRendered: true };
    const a = joinOverallPct(joinGateSteps({ ...s, artBakePct: 10 }));
    const b = joinOverallPct(joinGateSteps({ ...s, artBakePct: 80 }));
    expect(b).toBeGreaterThan(a);
  });

  it('a multi-gate step shows the share of its gates done', () => {
    expect(stepOf({ ...NONE, arrivalTickFromServer: 1 }, 'arrive').pct).toBe(50);
    expect(stepOf({ ...NONE, localPoseResolved: true }, 'place').pct).toBe(33);
  });

  it('folds the minimum-display floor into placing, never a step of its own', () => {
    const s = { ...ALL, joinMinimumElapsed: false };
    const steps = joinGateSteps(s);
    expect(steps[currentJoinStepIndex(steps)]!.id).toBe('place');
    expect(steps.find((st) => st.id === 'place')!.gates).toBe(3);
  });

  it('a shipless spectator has the ship and pose gates done', () => {
    const spec = { ...NONE, connectionStatus: 'connected' as const, pilotMode: 'spectator' as const };
    const steps = joinGateSteps(spec);
    expect(steps.find((st) => st.id === 'ship')!.done).toBe(true);
    expect(steps.find((st) => st.id === 'place')!.gatesDone).toBe(1);
    expect(steps[currentJoinStepIndex(steps)]!.id).toBe('sector');
    expect(currentJoinStepIndex(joinGateSteps({ ...ALL, localShipInstanceId: null, localPoseResolved: false, pilotMode: 'spectator' }))).toBe(-1);
  });
});

let host: HTMLDivElement;

function renderWarp(): void {
  render(
    <LayoutContext.Provider value={{ fullscreen: host }}>
      <WarpScreen />
    </LayoutContext.Provider>,
  );
}

const stepStates = (): (string | null)[] =>
  ORDER.map((id) => screen.getByTestId(`warp-step-${id}`).getAttribute('data-step-state'));
const stepPct = (id: string): string | null =>
  screen.getByTestId(`warp-step-${id}`).getAttribute('data-step-pct');

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  useUIStore.setState({
    ...ALL,
    phase: 'game',
    rendererFirstFrameRendered: false,
    firstSnapshotApplied: false,
    joinMinimumElapsed: false,
    localPoseResolved: false,
    clientReadySent: false,
    arrivalTickFromServer: null,
    arrivalAcked: false,
    artBakeReady: false,
    artBakePct: 0,
    travelling: false,
    currentSectorKey: null,
    transitTargetSectorKey: null,
    galaxyStats: [],
    shipRoster: [],
  });
});

afterEach(() => {
  host.remove();
});

describe('WarpScreen step list', () => {
  it('renders the steps in order, marks the first unfinished one current and names it', () => {
    renderWarp();
    const list = screen.getByTestId('warp-steps');
    const ids = Array.from(list.querySelectorAll('[data-step-id]')).map((el) => el.getAttribute('data-step-id'));
    expect(ids).toEqual(ORDER);
    expect(stepStates()).toEqual(['done', 'done', 'current', 'waiting', 'waiting', 'waiting', 'waiting']);
    expect(screen.getByTestId('warp-screen-status').textContent).toBe(JOIN_STEP_TEXT[2]!.name);
    expect(stepPct('connect')).toBe('100');
    expect(stepPct('sector')).toBe('0');
  });

  it('shows the bake ticking up as its own step, then moves on', () => {
    renderWarp();
    act(() => useUIStore.setState({ firstSnapshotApplied: true, rendererFirstFrameRendered: true }));
    expect(stepStates()).toEqual(['done', 'done', 'done', 'done', 'current', 'waiting', 'waiting']);
    expect(screen.getByTestId('warp-screen-status').textContent).toBe('Baking ship textures');
    act(() => useUIStore.getState().setArtBake(42.7, false));
    expect(stepPct('bake')).toBe('42');
    expect(screen.getByTestId('warp-step-bake').textContent).toContain('42%');
    act(() => useUIStore.getState().setArtBake(100, true));
    expect(stepPct('bake')).toBe('100');
    expect(stepStates()).toEqual(['done', 'done', 'done', 'done', 'done', 'current', 'waiting']);
    act(() => useUIStore.setState({ joinMinimumElapsed: true, localPoseResolved: true, clientReadySent: true }));
    expect(screen.getByTestId('warp-screen-status').textContent).toBe(JOIN_STEP_TEXT[6]!.name);
    expect(screen.getByTestId('warp-screen-progress').getAttribute('data-pct'))
      .toBe(String(joinOverallPct(joinGateSteps(useUIStore.getState()))));
    act(() => useUIStore.setState({ arrivalTickFromServer: 1, arrivalAcked: true }));
    expect(screen.getByTestId('warp-screen-status').textContent).toBe('WARP COMPLETE');
    // Loading lifted: the briefing (step list) is unmounted.
    expect(screen.queryByTestId('warp-steps')).toBeNull();
  });

  it('a shipless spectator sees the ship and placing steps done', () => {
    useUIStore.setState({ localShipInstanceId: null, pilotMode: 'spectator', firstSnapshotApplied: true, rendererFirstFrameRendered: true, joinMinimumElapsed: true, clientReadySent: true });
    renderWarp();
    expect(stepStates()).toEqual(['done', 'done', 'done', 'done', 'done', 'done', 'current']);
  });
});
