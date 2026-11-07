/**
 * Phase 4 travel state (plan prancy-squishing-donut, 2026-11-07): a
 * sector-to-sector trip IS the loading screen. The pilot keeps the normal view
 * (own ship flying, engines, sky) while the destination loads; the curtain
 * never rises for a transit, the old shader warp envelope and arrival flash are
 * gone (the user: "they're incredibly expensive and suck"), and the trip ends
 * on the loading→ready edge (the ship drops in, drawn by WarpFx).
 *
 * The very first join (no trip under way) keeps the curtain.
 *
 * LEVEL: the orchestration lives in `useWarpOrchestration` (main-thread React
 * effect ordering against the real store), so this drives the real store
 * sequence with a spy `IRenderer` recording calls.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import type { RefObject } from 'react';
import type { IRenderer } from '@core/contracts/IRenderer';
import { useUIStore } from './state/store.js';
import { useWarpOrchestration } from './useWarpOrchestration.js';

type Call =
  | { fn: 'setLoadCurtain'; arg: boolean }
  | { fn: 'setWarpMode'; arg: boolean }
  | { fn: 'setWarpCenter' }
  | { fn: 'triggerWarpIn' };

let calls: Call[];

function makeSpyRenderer(): IRenderer {
  const spy = {
    setLoadCurtain: (a: boolean) => calls.push({ fn: 'setLoadCurtain', arg: a }),
    setWarpMode: (a: boolean) => calls.push({ fn: 'setWarpMode', arg: a }),
    setWarpCenter: () => calls.push({ fn: 'setWarpCenter' }),
    triggerWarpIn: () => calls.push({ fn: 'triggerWarpIn' }),
  };
  return spy as unknown as IRenderer;
}

function Harness({ rr }: { rr: RefObject<IRenderer | null> }): null {
  useWarpOrchestration(rr);
  return null;
}

function settle(): void {
  useUIStore.setState({
    phase: 'game',
    connectionStatus: 'connected',
    localShipInstanceId: 'ship-1',
    firstSnapshotApplied: true,
    rendererFirstFrameRendered: true,
    joinMinimumElapsed: true,
    localPoseResolved: true,
    clientReadySent: true,
    arrivalTickFromServer: 123,
    arrivalAcked: true,
    transitState: 'DOCKED',
    travelling: false,
  });
}

describe('useWarpOrchestration — the trip is the loading screen (Phase 4 travel)', () => {
  beforeEach(() => {
    calls = [];
    settle();
  });

  it('a transit never raises the curtain, never runs the old shader, and ends the trip on arrival', () => {
    const rr: RefObject<IRenderer | null> = { current: makeSpyRenderer() };
    render(<Harness rr={rr} />);
    calls = [];

    act(() => { useUIStore.getState().setTransitState('SPOOLING'); });
    // transit_ready: the trip starts, then readiness re-arms (destination loading).
    act(() => {
      useUIStore.getState().setTravelling(true);
      (useUIStore.getState() as unknown as { rearmJoinReadiness: () => void }).rearmJoinReadiness();
    });
    act(() => { useUIStore.getState().setTransitState('IN_TRANSIT'); });

    expect(calls.some((c) => c.fn === 'setLoadCurtain' && c.arg === true)).toBe(false);
    expect(calls.some((c) => c.fn === 'setWarpMode' && c.arg === true)).toBe(false);

    // The destination is loaded: the trip ends, with no old arrival flash.
    act(() => {
      useUIStore.getState().setFirstSnapshotApplied(true);
      useUIStore.getState().setJoinMinimumElapsed(true);
      useUIStore.getState().setLocalPoseResolved(true);
      useUIStore.getState().setClientReadySent(true);
      useUIStore.getState().setArrivalTickFromServer(123);
      useUIStore.getState().setArrivalAcked(true);
      useUIStore.getState().setTransitState('DOCKED');
    });
    expect(calls.some((c) => c.fn === 'triggerWarpIn')).toBe(false);
    expect(calls.some((c) => c.fn === 'setLoadCurtain' && c.arg === true)).toBe(false);
    expect(useUIStore.getState().travelling).toBe(false);
  });

  it('the first join (no trip) still raises the curtain until ready', () => {
    useUIStore.setState({ firstSnapshotApplied: false, travelling: false });
    const rr: RefObject<IRenderer | null> = { current: makeSpyRenderer() };
    render(<Harness rr={rr} />);
    expect(calls.some((c) => c.fn === 'setLoadCurtain' && c.arg === true)).toBe(true);
  });
});
