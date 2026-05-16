/**
 * Phase G — Bug B wiring lock: the inter-sector transit reset sequence
 * re-arms BOTH the prediction seed (7829d04) AND the UI join-readiness.
 *
 * The `transit_ready` handler treats the destination like a fresh
 * connect. After commit 7829d04 it does this for the SPATIAL layer:
 * `resetPredictionState()` despawns the local predWorld body + nulls the
 * `Reconciler`. Phase G adds the UI-readiness analogue as a sibling
 * line: `useUIStore.getState().rearmJoinReadiness()`. This locks that
 * the two reset concerns, run together as the handler runs them,
 * produce the combined post-condition — reverting either re-fails.
 *
 * LEVEL CHOICE (Invariant #13): the literal
 * `room.onMessage('transit_ready', …)` callback needs a live WS / room
 * (not available in a node unit test). The sanctioned pattern here is
 * `ColyseusClient.transitArrivalDrift.test.ts` /
 * `…resetPredictionState.test.ts`: construct a real `ColyseusGameClient`,
 * reach the private reset via a narrow structural cast, run the SAME
 * sequence the handler runs, assert the real post-condition. Proving the
 * WS callback literally invokes it is deferred to the E2E/room layer
 * (the store-unit + WarpScreen-component locks already fail pre-fix /
 * pass post-fix; the literal-callback assertion adds flake for marginal
 * coverage — see the Phase G plan).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { useUIStore } from '../state/store.js';

type Internals = {
  reconciler: unknown | null;
  resetPredictionState: () => void;
};
type RearmApi = { rearmJoinReadiness?: () => void };
const asInternals = (c: ColyseusGameClient): Internals =>
  c as unknown as Internals;
const api = (): ReturnType<typeof useUIStore.getState> & RearmApi =>
  useUIStore.getState() as ReturnType<typeof useUIStore.getState> & RearmApi;

describe('ColyseusGameClient — transit reset re-arms prediction + UI readiness (Phase G, Bug B)', () => {
  beforeEach(() => {
    // Stuck-true steady state a pure inter-sector transit inherits
    // (phase never leaves 'game', so setPhase never re-armed these).
    useUIStore.setState({
      phase: 'game',
      firstSnapshotApplied: true,
      rendererFirstFrameRendered: true,
      joinMinimumElapsed: true,
    });
  });

  it('the handler reset sequence clears UI readiness AND keeps the reconciler nulled', () => {
    const client = new ColyseusGameClient();
    const internals = asInternals(client);
    // A non-null reconciler stub — `resetPredictionState()` must null it
    // (7829d04). predWorld is null on a bare client, so the spatial
    // despawn guard is skipped and the test stays light.
    internals.reconciler = { lastDrift: 0 };

    const genBefore = (api().joinGeneration as number | undefined) ?? 0;

    // The exact two operations the `transit_ready` handler performs,
    // in order (the WS-only steps in between don't touch either seed).
    internals.resetPredictionState();
    api().rearmJoinReadiness?.();

    // 7829d04 invariant preserved (reverting that fix re-fails here).
    expect(internals.reconciler).toBeNull();

    // Phase G: UI join-readiness re-armed even though phase stayed
    // 'game'. rearmJoinReadiness resets the two flags a pure transit
    // needs (firstSnapshotApplied, joinMinimumElapsed) + bumps the
    // generation counter; it LEAVES rendererFirstFrameRendered true
    // (the renderer is genuinely still painting across a transit —
    // resetting it would be false and is unnecessary).
    const s = api();
    expect(s.firstSnapshotApplied).toBe(false);
    expect(s.joinMinimumElapsed).toBe(false);
    expect(s.joinGeneration).toBe(genBefore + 1);
    expect(s.rendererFirstFrameRendered).toBe(true);
  });

  it('rearmJoinReadiness is wired on the store (handler dependency exists)', () => {
    // Guards the sibling line: if `rearmJoinReadiness` is removed from
    // the store the handler call site no longer compiles/works.
    new ColyseusGameClient();
    expect(typeof api().rearmJoinReadiness).toBe('function');
  });
});
