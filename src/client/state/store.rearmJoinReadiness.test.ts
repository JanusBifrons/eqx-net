/**
 * Phase G — Bug B unit lock for the consolidated join-readiness re-arm.
 *
 * The bug: `setPhase` (store.ts) re-arms the three WarpScreen readiness
 * sub-flags ONLY on enter/leave-`game`. Its own comment claims "every
 * entry into 'game' (… transit arrival) re-arms the WarpScreen", but a
 * pure inter-sector transit keeps `phase==='game'` throughout, so the
 * reset never fires (the `prev.phase === p` path returns a bare
 * `{ phase }`). Same defect class as commit 7829d04 (a comment promising
 * a re-seed the code only performs on a different path).
 *
 * The fix introduces ONE consolidated action `rearmJoinReadiness()` that
 * clears the 3 flags AND bumps a monotone `joinGeneration` counter
 * (which re-arms the App.tsx 5 s `joinMinimumElapsed` timer effect),
 * invoked from BOTH `setPhase` enter/leave-`game` AND the
 * `transit_ready` handler — mirroring how `resetPredictionState()` is
 * the one spatial-seed site invoked by connect + `transit_ready`.
 *
 * This locks the store contract. It is NOT sufficient alone (it doesn't
 * prove the transit handler calls it — see
 * `ColyseusClient.transitRearmReadiness.test.ts` + the WarpScreen
 * component lock); it is the fast logic insurance for the action itself.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from './store.js';

// `rearmJoinReadiness` / `joinGeneration` do not exist pre-fix. A narrow
// structural cast lets the spec compile so the RED is a behavioural
// assertion failure, not a collection-time type error (same approach as
// the `asInternals` casts in the ColyseusClient specs).
type RearmApi = {
  rearmJoinReadiness?: () => void;
  joinGeneration?: number;
};
const api = (): ReturnType<typeof useUIStore.getState> & RearmApi =>
  useUIStore.getState() as ReturnType<typeof useUIStore.getState> & RearmApi;

describe('store — rearmJoinReadiness (Phase G, Bug B)', () => {
  beforeEach(() => {
    // Clean steady "post-arrival" baseline: in game, all 3 readiness
    // sub-flags satisfied (the stuck-true state a pure transit inherits).
    useUIStore.setState({
      phase: 'game',
      firstSnapshotApplied: true,
      rendererFirstFrameRendered: true,
      joinMinimumElapsed: true,
    });
  });

  it('baseline parity: setPhase non-game→game clears the 3 readiness flags', () => {
    // Existing, correct behaviour (initial join / ship-swap arrival).
    // Green pre- AND post-fix — characterises the path that DOES work.
    useUIStore.setState({ phase: 'auth' });
    useUIStore.getState().setPhase('game');
    const s = useUIStore.getState();
    expect(s.firstSnapshotApplied).toBe(false);
    expect(s.rendererFirstFrameRendered).toBe(false);
    expect(s.joinMinimumElapsed).toBe(false);
  });

  it('the gap: setPhase("game") while ALREADY in game does NOT re-arm', () => {
    // This is WHY a pure inter-sector transit (phase stays 'game') never
    // re-shows the WarpScreen. Characterisation — green pre- and
    // post-fix (the same-phase setPhase is intentionally a no-op; the
    // transit re-arm is driven by `transit_ready`, not setPhase).
    useUIStore.getState().setPhase('game');
    const s = useUIStore.getState();
    expect(s.firstSnapshotApplied).toBe(true);
    expect(s.rendererFirstFrameRendered).toBe(true);
    expect(s.joinMinimumElapsed).toBe(true);
  });

  it('rearmJoinReadiness() re-arms readiness even while phase stays "game"', () => {
    // THE RED: pre-fix the action does not exist → flags stay true.
    // Post-fix it clears the two flags a pure transit genuinely needs
    // re-armed (firstSnapshotApplied, joinMinimumElapsed) and bumps the
    // monotone joinGeneration counter (the App.tsx 5 s-timer re-arm
    // signal). It deliberately LEAVES rendererFirstFrameRendered true:
    // a pure inter-sector transit does NOT recreate/re-init the
    // renderer (it keeps painting), so resetting it would be a false
    // statement — GPU-init lag is an initial-join concern only, handled
    // by setPhase (GameSurface remounts there). This asymmetry is the
    // point: setPhase resets 3 flags, rearmJoinReadiness resets 2.
    expect(typeof api().rearmJoinReadiness).toBe('function');

    const genBefore = api().joinGeneration ?? 0;
    api().rearmJoinReadiness!();

    const s = api();
    expect(s.firstSnapshotApplied).toBe(false);
    expect(s.joinMinimumElapsed).toBe(false);
    expect(s.joinGeneration).toBe(genBefore + 1);
    // Genuinely unchanged — the renderer is still live across a transit.
    expect(s.rendererFirstFrameRendered).toBe(true);
  });

  it('setPhase non-game→game also bumps joinGeneration (shared re-arm)', () => {
    // Parity proof that setPhase and rearmJoinReadiness produce the SAME
    // re-arm delta (DRY — one definition). Post-fix only.
    useUIStore.setState({ phase: 'connecting' });
    const genBefore = api().joinGeneration ?? 0;
    useUIStore.getState().setPhase('game');
    expect(api().joinGeneration).toBe(genBefore + 1);
  });
});
