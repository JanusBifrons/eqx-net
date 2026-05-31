/**
 * Phase G — Bug A regression lock: the single arrival flash.
 *
 * User smoke-test report: an inter-sector transit shows the warp burst
 * TWICE (spool-exit burst + arrival-reveal flash, ~200-500 ms apart).
 *
 * Root cause (verified): Bug A is a *consequence* of Bug B. The
 * SPOOLING→IN_TRANSIT `setWarpMode(false)` spool-climax burst is meant
 * to fire behind an already-opaque load curtain. Pre-Phase-G the
 * curtain only rose when `loading` flipped true via the explicit
 * `transitState==='IN_TRANSIT'` term — i.e. in the SAME store
 * transition as the burst (curtain tween barely started → burst
 * visible). Phase G's `rearmJoinReadiness()` (from the `transit_ready`
 * handler) flips `gameReady→false` BEFORE `IN_TRANSIT`, so `loading`
 * (=`!gameReady|IN_TRANSIT|ARRIVED`) goes true at `transit_ready` and
 * the curtain rises a whole room-swap window EARLIER — opaque by the
 * time the burst fires → only the single arrival flash is seen.
 *
 * LEVEL (Invariant #13): the bug lives in App.tsx's transit→renderer
 * effect ORCHESTRATION (the relative timing of `setLoadCurtain` vs the
 * spool-exit `setWarpMode(false)`), NOT in `PixiRenderer` internals
 * (`fireBurst` is correct and already locked by
 * `PixiRenderer.warpDetach.test.ts`). So the faithful level is the
 * extracted `useWarpOrchestration` hook driven through the real store
 * sequence with a spy `IRenderer` recording an ordered call log — not
 * a renderer probe page (this is main-thread React effect ordering,
 * not a worker/postMessage boundary). The hook is a behaviour-
 * preserving extraction of the prior inline App.tsx effects, made so
 * this invariant is unit-lockable.
 *
 * The fix landed in G1 (the `rearmJoinReadiness` coupling); this spec
 * is the orchestration-ordering lock + the characterization that
 * proves the test distinguishes the pre/post regimes. Reverting the
 * G1 re-arm makes real transits take the "characterization" path; the
 * Bug-B locks (`ColyseusClient.transitRearmReadiness.test.ts` /
 * `WarpScreen.transit.test.tsx`) re-fail on that revert, and removing
 * the `rearmJoinReadiness` store action fails this spec at compile.
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

/** Steady "post-arrival, fully ready, docked" baseline.
 *  Plan: crispy-kazoo, Commit 2 — `useGameReady()` is now the 9-gate
 *  predicate; the handshake gates must be true for the steady state. */
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
  });
}
const lastCurtainBefore = (i: number): boolean | null => {
  for (let k = i - 1; k >= 0; k--) {
    const c = calls[k]!;
    if (c.fn === 'setLoadCurtain') return c.arg;
  }
  return null;
};

describe('useWarpOrchestration — single arrival flash (Phase G, Bug A)', () => {
  beforeEach(() => {
    calls = [];
    settle();
  });

  it('Phase-G: curtain rises at transit_ready, BEFORE the spool-exit burst → single flash', () => {
    const rr: RefObject<IRenderer | null> = { current: makeSpyRenderer() };
    render(<Harness rr={rr} />);
    calls = []; // drop mount baseline (setLoadCurtain(false)+setWarpMode(false))

    // Engage: SPOOLING. gameReady still true (rearm not yet) → loading
    // false → no curtain. The spool envelope starts.
    act(() => { useUIStore.getState().setTransitState('SPOOLING'); });
    expect(calls.some((c) => c.fn === 'setLoadCurtain' && c.arg === true)).toBe(false);
    expect(calls.some((c) => c.fn === 'setWarpMode' && c.arg === true)).toBe(true);

    // transit_ready re-arm (the G1 fix the handler performs). gameReady
    // → false → loading → true → curtain UP, now, before IN_TRANSIT.
    act(() => { (useUIStore.getState() as unknown as { rearmJoinReadiness: () => void }).rearmJoinReadiness(); });
    const curtainUpIdx = calls.findIndex((c) => c.fn === 'setLoadCurtain' && c.arg === true);
    expect(curtainUpIdx).toBeGreaterThanOrEqual(0); // THE LOCK: curtain up at transit_ready

    // IN_TRANSIT → the spool-exit burst. It must come AFTER the curtain
    // was already raised (→ masked).
    act(() => { useUIStore.getState().setTransitState('IN_TRANSIT'); });
    const burstIdx = calls.findIndex(
      (c, i) => c.fn === 'setWarpMode' && c.arg === false && i > curtainUpIdx,
    );
    expect(burstIdx).toBeGreaterThan(curtainUpIdx);
    expect(lastCurtainBefore(burstIdx)).toBe(true); // curtain opaque when burst fires

    // Arrival completes → single flash on the loading→ready edge.
    // Plan: crispy-kazoo, Commit 2 — handshake gates must also flip
    // for the curtain to drop. The bootstrap gates (firstSnapshotApplied,
    // joinMinimumElapsed) flip first, then sendClientReady fires, then
    // warp_in arrives with arrivalTick, then arrivalAcked. Drive the
    // post-handshake terminal state here so the test asserts the
    // curtain-drop and single-flash invariants.
    act(() => {
      useUIStore.getState().setFirstSnapshotApplied(true);
      useUIStore.getState().setJoinMinimumElapsed(true);
      useUIStore.getState().setLocalPoseResolved(true);
      useUIStore.getState().setClientReadySent(true);
      useUIStore.getState().setArrivalTickFromServer(123);
      useUIStore.getState().setArrivalAcked(true);
      useUIStore.getState().setTransitState('DOCKED');
    });
    expect(calls.filter((c) => c.fn === 'triggerWarpIn')).toHaveLength(1);
    const flashIdx = calls.findIndex((c) => c.fn === 'triggerWarpIn');
    expect(flashIdx).toBeGreaterThan(curtainUpIdx);
  });

  it('characterization: WITHOUT the re-arm the curtain has no head-start (pre-G1 double-flash window)', () => {
    const rr: RefObject<IRenderer | null> = { current: makeSpyRenderer() };
    render(<Harness rr={rr} />);
    calls = [];

    // SPOOLING with gameReady stuck-true (the pre-G1 reality — no
    // rearmJoinReadiness on transit). No curtain during the spool.
    act(() => { useUIStore.getState().setTransitState('SPOOLING'); });
    expect(calls.some((c) => c.fn === 'setLoadCurtain' && c.arg === true)).toBe(false);

    // IN_TRANSIT: the FIRST curtain-up coincides with the spool-exit
    // burst (same store transition) — the curtain tween only starts as
    // the burst fires, so the burst is visible: the double-flash
    // window. This proves the spec distinguishes the regimes (the
    // Phase-G case raised the curtain a whole step earlier).
    act(() => { useUIStore.getState().setTransitState('IN_TRANSIT'); });
    const firstCurtainUp = calls.findIndex((c) => c.fn === 'setLoadCurtain' && c.arg === true);
    const burst = calls.findIndex((c) => c.fn === 'setWarpMode' && c.arg === false);
    expect(firstCurtainUp).toBeGreaterThanOrEqual(0); // it does rise…
    expect(burst).toBeGreaterThanOrEqual(0);          // …but only now,
    // …in the SAME act() as the burst — no earlier transit_ready
    // head-start (contrast the Phase-G test, where curtainUpIdx was
    // established by the rearm step BEFORE IN_TRANSIT was driven).
  });
});
