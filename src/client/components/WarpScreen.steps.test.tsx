/**
 * WarpScreen loading-step breakdown locks: the join gates group into named
 * steps (a playful name + a plain explainer), listed in order with the first
 * not-done step marked current; the bar's gate count is derived from the
 * same steps, so the two never disagree.
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
  joinGatesDone,
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
};
const ORDER = ['connect', 'ship', 'sector', 'draw', 'place', 'arrive'];

const sumGates = (s: JoinGateState): number =>
  joinGateSteps(s).reduce((n, st) => n + st.gatesDone, 0);

describe('joinGateSteps', () => {
  it('lists the steps in order, covering all nine gates, each with a name and an explainer', () => {
    const steps = joinGateSteps(NONE);
    expect(steps.map((s) => s.id)).toEqual(ORDER);
    expect(JOIN_STEP_TEXT.map((s) => s.id)).toEqual(ORDER);
    expect(steps.reduce((n, s) => n + s.gates, 0)).toBe(JOIN_GATE_COUNT);
    for (const s of steps) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.detail.length).toBeGreaterThan(0);
      expect(s.name).not.toBe(s.detail);
    }
  });

  it('joinGatesDone equals the count derived from the steps, for every single-gate flip', () => {
    const keys: (keyof JoinGateState)[] = [
      'rendererFirstFrameRendered', 'firstSnapshotApplied', 'joinMinimumElapsed',
      'localPoseResolved', 'clientReadySent', 'arrivalAcked',
    ];
    expect(joinGatesDone(NONE)).toBe(sumGates(NONE));
    expect(joinGatesDone(ALL)).toBe(JOIN_GATE_COUNT);
    for (const k of keys) {
      const s = { ...NONE, [k]: true };
      expect(joinGatesDone(s)).toBe(1);
      expect(joinGatesDone(s)).toBe(sumGates(s));
    }
  });

  it('folds the minimum-display floor into drawing, never a step of its own', () => {
    const s = { ...ALL, joinMinimumElapsed: false };
    const steps = joinGateSteps(s);
    expect(steps[currentJoinStepIndex(steps)]!.id).toBe('draw');
    expect(steps.find((st) => st.id === 'draw')!.gates).toBe(2);
  });

  it('a shipless spectator has the ship and placing gates done', () => {
    const spec = { ...NONE, connectionStatus: 'connected' as const, pilotMode: 'spectator' as const };
    const steps = joinGateSteps(spec);
    expect(steps.find((st) => st.id === 'ship')!.done).toBe(true);
    expect(steps.find((st) => st.id === 'place')!.gatesDone).toBe(1);
    expect(steps[currentJoinStepIndex(steps)]!.id).toBe('sector');
    expect(joinGatesDone(spec)).toBe(3);
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
  it('renders the steps in order, marks the first unfinished one current and explains it', () => {
    renderWarp();
    const list = screen.getByTestId('warp-steps');
    const ids = Array.from(list.querySelectorAll('[data-step-id]')).map((el) => el.getAttribute('data-step-id'));
    expect(ids).toEqual(ORDER);
    expect(stepStates()).toEqual(['done', 'done', 'current', 'waiting', 'waiting', 'waiting']);
    const sector = JOIN_STEP_TEXT[2]!;
    expect(screen.getByTestId('warp-screen-status').textContent).toBe(sector.name);
    expect(screen.getByTestId('warp-step-detail').textContent).toBe(sector.detail);
    expect(screen.getByTestId('warp-step-count').textContent).toBe('2 of 6');
  });

  it('moves the highlight as gates flip, and the bar agrees with the steps', () => {
    renderWarp();
    act(() => useUIStore.setState({ firstSnapshotApplied: true, rendererFirstFrameRendered: true }));
    // Drawing still waits on the display floor: it stays current.
    expect(stepStates()).toEqual(['done', 'done', 'done', 'current', 'waiting', 'waiting']);
    act(() => useUIStore.setState({ joinMinimumElapsed: true, localPoseResolved: true, clientReadySent: true }));
    expect(stepStates()).toEqual(['done', 'done', 'done', 'done', 'done', 'current']);
    expect(screen.getByTestId('warp-screen-status').textContent).toBe(JOIN_STEP_TEXT[5]!.name);
    const bar = screen.getByTestId('warp-screen-progress');
    expect(bar.getAttribute('data-gates-done')).toBe(String(joinGatesDone(useUIStore.getState())));
    expect(bar.getAttribute('data-gates-done')).toBe('7');
  });

  it('a shipless spectator sees the ship and placing steps done', () => {
    useUIStore.setState({ localShipInstanceId: null, pilotMode: 'spectator', firstSnapshotApplied: true, rendererFirstFrameRendered: true, joinMinimumElapsed: true, clientReadySent: true });
    renderWarp();
    expect(stepStates()).toEqual(['done', 'done', 'done', 'done', 'done', 'current']);
  });
});
