/**
 * Plan: crispy-kazoo Commit 1 — locks the new loading-state surfaces:
 *   - `computeGameReadyFromState` pure helper mirrors `useGameReady`
 *   - `computeIsLoadingActive` decision matrix (kill switch, phase, ready)
 *   - `computeWarpProgress` weight table + monotonic `maxProgressSeen` latch
 *   - `commonReadinessRearm` extension covers the new fields
 *   - `?loading=cosmetic` kill switch behaviour
 *
 * Commit 2 will extend `computeGameReadyFromState` with the handshake
 * gates; these tests then get parallel cases added. For now they lock
 * the Commit-1 contract.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  useUIStore,
  computeGameReadyFromState,
  computeIsLoadingActive,
  computeWarpProgress,
} from './store.js';

function resetForTest(): void {
  // Restore a representative baseline so per-test mutations don't leak.
  useUIStore.setState({
    phase: 'meta',
    connectionStatus: 'disconnected',
    localShipInstanceId: null,
    rendererFirstFrameRendered: false,
    firstSnapshotApplied: false,
    joinMinimumElapsed: false,
    clientReadySent: false,
    arrivalTickFromServer: null,
    arrivalAcked: false,
    localPoseResolved: false,
    maxProgressSeen: 0,
    loadingCosmeticOnly: false,
    sectorReentryInFlight: false,
  });
}

beforeEach(resetForTest);

describe('computeGameReadyFromState — 5-gate predicate (Commit 1 set)', () => {
  it('all 5 gates true → ready', () => {
    expect(
      computeGameReadyFromState({
        connectionStatus: 'connected',
        localShipInstanceId: 'ship-1',
        rendererFirstFrameRendered: true,
        firstSnapshotApplied: true,
        joinMinimumElapsed: true,
      }),
    ).toBe(true);
  });

  it.each([
    ['connectionStatus', { connectionStatus: 'connecting' as const }],
    ['localShipInstanceId', { localShipInstanceId: null }],
    ['rendererFirstFrameRendered', { rendererFirstFrameRendered: false }],
    ['firstSnapshotApplied', { firstSnapshotApplied: false }],
    ['joinMinimumElapsed', { joinMinimumElapsed: false }],
  ])('not ready when %s gate is open', (_name, partial) => {
    const base = {
      connectionStatus: 'connected' as const,
      localShipInstanceId: 'ship-1' as string | null,
      rendererFirstFrameRendered: true,
      firstSnapshotApplied: true,
      joinMinimumElapsed: true,
    };
    expect(computeGameReadyFromState({ ...base, ...partial })).toBe(false);
  });
});

describe('computeIsLoadingActive — phase × ready × kill switch decision matrix', () => {
  it('phase==="connecting" → loading active (regardless of gates)', () => {
    useUIStore.setState({ phase: 'connecting' });
    expect(computeIsLoadingActive(useUIStore.getState())).toBe(true);
  });

  it('phase==="game" && !ready → loading active', () => {
    useUIStore.setState({
      phase: 'game',
      connectionStatus: 'connected',
      localShipInstanceId: 'ship-1',
      // remaining gates default false → not ready
    });
    expect(computeIsLoadingActive(useUIStore.getState())).toBe(true);
  });

  it('phase==="game" && ready → loading NOT active', () => {
    useUIStore.setState({
      phase: 'game',
      connectionStatus: 'connected',
      localShipInstanceId: 'ship-1',
      rendererFirstFrameRendered: true,
      firstSnapshotApplied: true,
      joinMinimumElapsed: true,
    });
    expect(computeIsLoadingActive(useUIStore.getState())).toBe(false);
  });

  it.each(['meta', 'auth', 'galaxy-map', 'local'] as const)(
    'phase==="%s" → loading NOT active (curtain only paints in game/connecting)',
    (p) => {
      useUIStore.setState({ phase: p });
      expect(computeIsLoadingActive(useUIStore.getState())).toBe(false);
    },
  );

  it('?loading=cosmetic kill switch forces loading active to false even when not ready', () => {
    useUIStore.setState({
      phase: 'game',
      connectionStatus: 'connected',
      localShipInstanceId: 'ship-1',
      // ready = false (firstSnapshotApplied etc. still false)
      loadingCosmeticOnly: true,
    });
    expect(computeIsLoadingActive(useUIStore.getState())).toBe(false);
  });

  it('kill switch also overrides phase==="connecting"', () => {
    useUIStore.setState({
      phase: 'connecting',
      loadingCosmeticOnly: true,
    });
    expect(computeIsLoadingActive(useUIStore.getState())).toBe(false);
  });
});

describe('computeWarpProgress — weight table + monotonic latch', () => {
  it('all gates false → raw progress 0 (latched at 0)', () => {
    expect(computeWarpProgress(useUIStore.getState())).toBe(0);
  });

  it('legacy 5-gate set fully satisfied → 65 (Commit 1 ceiling, handshake gates unwired)', () => {
    useUIStore.setState({
      connectionStatus: 'connected',
      localShipInstanceId: 'ship-1',
      firstSnapshotApplied: true,
      rendererFirstFrameRendered: true,
      joinMinimumElapsed: true,
    });
    // 10 + 15 + 15 + 15 + 10 = 65 (localPoseResolved + handshake gates
    // still false; Commit 2 wires them and reaches 100).
    expect(computeWarpProgress(useUIStore.getState())).toBe(65);
  });

  it('all gates true → exactly 100 (sum of weight table)', () => {
    useUIStore.setState({
      connectionStatus: 'connected',
      localShipInstanceId: 'ship-1',
      firstSnapshotApplied: true,
      localPoseResolved: true,
      rendererFirstFrameRendered: true,
      joinMinimumElapsed: true,
      clientReadySent: true,
      arrivalTickFromServer: 12345,
      arrivalAcked: true,
    });
    // 10 + 15 + 15 + 10 + 15 + 10 + 10 + 10 + 5 = 100
    expect(computeWarpProgress(useUIStore.getState())).toBe(100);
  });

  it('maxProgressSeen latch prevents bar from regressing on transient gate flip', () => {
    useUIStore.setState({
      connectionStatus: 'connected',
      localShipInstanceId: 'ship-1',
      firstSnapshotApplied: true,
      maxProgressSeen: 50,
    });
    // Raw progress: 10 + 15 + 15 = 40. Latch wins.
    expect(computeWarpProgress(useUIStore.getState())).toBe(50);
  });

  it('raw progress greater than latch → raw wins (forward monotone)', () => {
    useUIStore.setState({
      connectionStatus: 'connected',
      localShipInstanceId: 'ship-1',
      firstSnapshotApplied: true,
      rendererFirstFrameRendered: true,
      joinMinimumElapsed: true,
      maxProgressSeen: 30,
    });
    // Raw 65 > latch 30.
    expect(computeWarpProgress(useUIStore.getState())).toBe(65);
  });
});

describe('commonReadinessRearm extension — covers new spawn-handshake fields', () => {
  it('setPhase enter game resets new fields', () => {
    // Establish steady "ready" state, then leave + re-enter.
    useUIStore.setState({
      phase: 'auth',
      clientReadySent: true,
      arrivalTickFromServer: 99,
      arrivalAcked: true,
      localPoseResolved: true,
      maxProgressSeen: 75,
    });
    useUIStore.getState().setPhase('game');
    const s = useUIStore.getState();
    expect(s.clientReadySent).toBe(false);
    expect(s.arrivalTickFromServer).toBe(null);
    expect(s.arrivalAcked).toBe(false);
    expect(s.localPoseResolved).toBe(false);
    expect(s.maxProgressSeen).toBe(0);
  });

  it('rearmJoinReadiness() (transit path) also resets new fields', () => {
    useUIStore.setState({
      phase: 'game',
      clientReadySent: true,
      arrivalTickFromServer: 99,
      arrivalAcked: true,
      localPoseResolved: true,
      maxProgressSeen: 80,
    });
    useUIStore.getState().rearmJoinReadiness();
    const s = useUIStore.getState();
    expect(s.clientReadySent).toBe(false);
    expect(s.arrivalTickFromServer).toBe(null);
    expect(s.arrivalAcked).toBe(false);
    expect(s.localPoseResolved).toBe(false);
    expect(s.maxProgressSeen).toBe(0);
  });

  it('rearm does NOT touch loadingCosmeticOnly (set once at boot, immutable across sessions)', () => {
    useUIStore.setState({
      phase: 'auth',
      loadingCosmeticOnly: true,
    });
    useUIStore.getState().setPhase('game');
    expect(useUIStore.getState().loadingCosmeticOnly).toBe(true);
    useUIStore.getState().rearmJoinReadiness();
    expect(useUIStore.getState().loadingCosmeticOnly).toBe(true);
  });

  it('rearm does NOT touch sectorReentryInFlight (its own lifecycle — click → gameReady)', () => {
    useUIStore.setState({
      phase: 'auth',
      sectorReentryInFlight: true,
    });
    useUIStore.getState().setPhase('game');
    // Setting sectorReentryInFlight is the caller's job; the rearm
    // is for join-readiness gates, not click-state guards.
    expect(useUIStore.getState().sectorReentryInFlight).toBe(true);
  });
});

describe('setters wire correctly', () => {
  it.each([
    ['setClientReadySent', 'clientReadySent', true] as const,
    ['setArrivalAcked', 'arrivalAcked', true] as const,
    ['setLocalPoseResolved', 'localPoseResolved', true] as const,
    ['setLoadingCosmeticOnly', 'loadingCosmeticOnly', true] as const,
    ['setSectorReentryInFlight', 'sectorReentryInFlight', true] as const,
  ])('%s flips %s', (setterName, fieldName, value) => {
    const store = useUIStore.getState();
    const setter = (store as unknown as Record<string, (v: boolean) => void>)[setterName];
    setter(value);
    expect((useUIStore.getState() as unknown as Record<string, unknown>)[fieldName]).toBe(value);
  });

  it('setArrivalTickFromServer accepts number and null', () => {
    useUIStore.getState().setArrivalTickFromServer(12345);
    expect(useUIStore.getState().arrivalTickFromServer).toBe(12345);
    useUIStore.getState().setArrivalTickFromServer(null);
    expect(useUIStore.getState().arrivalTickFromServer).toBe(null);
  });

  it('setMaxProgressSeen accepts numeric latch', () => {
    useUIStore.getState().setMaxProgressSeen(42);
    expect(useUIStore.getState().maxProgressSeen).toBe(42);
  });
});
