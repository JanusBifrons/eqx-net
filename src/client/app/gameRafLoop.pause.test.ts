/**
 * @vitest-environment jsdom
 *
 * Plan: crispy-kazoo, Commit 4 — gameRafLoop pause-boundary lock.
 *
 *   - When `computeIsLoadingActive(state)` is true, the loop early-returns
 *     BEFORE doing game work AND BEFORE updating `lastFrameTime` (so the
 *     post-resume `deltaMs` doesn't anchor to a stale value).
 *   - The handshake trigger (sendClientReady) runs ABOVE the pause early-
 *     return so it fires during the loading window (when bootstrap-ready
 *     flips true).
 *   - The RAF chain stays alive (the loop re-arms itself via
 *     `animFrameRef.current = requestAnimationFrame(loop)`).
 *
 * Strategy: stub the store + ClientLogger, build a fake renderer / client,
 * call the loop directly with synthetic `now` values, observe whether the
 * game-work methods (tickPhysics, updateMirror, renderer.update) are called.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks must be declared BEFORE imports of the module under test.
const storeState = vi.hoisted(() => ({
  clientReadySent: false,
  loadingCosmeticOnly: false,
  phase: 'game' as 'meta' | 'auth' | 'galaxy-map' | 'connecting' | 'game' | 'local',
  connectionStatus: 'connected' as 'connecting' | 'connected' | 'disconnected' | 'error',
  localShipInstanceId: 'ship-1' as string | null,
  rendererFirstFrameRendered: true,
  firstSnapshotApplied: true,
  joinMinimumElapsed: true,
  localPoseResolved: true,
  arrivalTickFromServer: 123 as number | null,
  arrivalAcked: true,
}));

vi.mock('../state/store.js', () => ({
  useUIStore: {
    getState: () => storeState,
  },
  computeBootstrapReadyFromState: (s: typeof storeState) =>
    s.connectionStatus === 'connected'
    && s.localShipInstanceId !== null
    && s.rendererFirstFrameRendered
    && s.firstSnapshotApplied
    && s.joinMinimumElapsed
    && s.localPoseResolved,
  computeIsLoadingActive: (s: typeof storeState) => {
    if (s.loadingCosmeticOnly) return false;
    if (s.phase === 'connecting') return true;
    if (s.phase !== 'game') return false;
    return !(
      s.connectionStatus === 'connected'
      && s.localShipInstanceId !== null
      && s.rendererFirstFrameRendered
      && s.firstSnapshotApplied
      && s.joinMinimumElapsed
      && s.localPoseResolved
      && s.clientReadySent
      && s.arrivalTickFromServer !== null
      && s.arrivalAcked
    );
  },
}));

vi.mock('../debug/ClientLogger.js', () => ({
  logEvent: vi.fn(),
  isFullDiagMode: () => false,
}));

vi.mock('../render/perFrameTriggers.js', () => ({
  consumeOneFrameTriggers: vi.fn(),
}));

vi.mock('../perf/frameRateCap.js', () => ({
  shouldSkipFrame: () => false,
}));

import { createGameRafLoop } from './gameRafLoop.js';
import type { ColyseusGameClient } from '../net/ColyseusClient.js';
import type { IRenderer } from '@core/contracts/IRenderer';

interface Fake {
  tickPhysics: ReturnType<typeof vi.fn>;
  updateMirror: ReturnType<typeof vi.fn>;
  rendererUpdate: ReturnType<typeof vi.fn>;
  sendClientReady: ReturnType<typeof vi.fn>;
}

function buildLoop(fake: Fake): { loop: (now: number) => void; animFrameRef: { current: number } } {
  const mockClient = {
    tickPhysics: fake.tickPhysics,
    updateMirror: fake.updateMirror,
    sendClientReady: fake.sendClientReady,
    mirror: {
      localPlayerId: 'ship-1',
      ships: new Map(),
      swarm: new Map(),
      projectiles: new Map(),
    },
    transitInstr: { wantsFrame: () => false },
  } as unknown as ColyseusGameClient;
  const mockRenderer = {
    update: fake.rendererUpdate,
    getFeedback: () => ({ firstFrameRendered: false, mountCounts: new Map(), haloArrowCount: 0 }),
  } as unknown as IRenderer;
  const el = document.createElement('div');
  const animFrameRef = { current: 0 };
  const loop = createGameRafLoop({
    el,
    gameClient: mockClient,
    renderer: mockRenderer,
    useWorker: false,
    effectiveCapMs: 10,
    phaseEnterPerfNow: 0,
    animFrameRef,
    isDisposed: () => false,
  });
  return { loop, animFrameRef };
}

let fake: Fake;
let rafSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fake = {
    tickPhysics: vi.fn(),
    updateMirror: vi.fn(),
    rendererUpdate: vi.fn(),
    sendClientReady: vi.fn(),
  };
  // Stub requestAnimationFrame so the loop can re-arm without an
  // actual browser frame.
  rafSpy = vi.fn(() => 42);
  globalThis.requestAnimationFrame = rafSpy as unknown as typeof globalThis.requestAnimationFrame;

  // Reset store to "fully ready" baseline; tests mutate per-case.
  storeState.clientReadySent = true;
  storeState.loadingCosmeticOnly = false;
  storeState.phase = 'game';
  storeState.connectionStatus = 'connected';
  storeState.localShipInstanceId = 'ship-1';
  storeState.rendererFirstFrameRendered = true;
  storeState.firstSnapshotApplied = true;
  storeState.joinMinimumElapsed = true;
  storeState.localPoseResolved = true;
  storeState.arrivalTickFromServer = 123;
  storeState.arrivalAcked = true;
});

describe('gameRafLoop — pause boundary (Commit 4)', () => {
  it('NOT loading + ready → game-work runs', () => {
    const { loop } = buildLoop(fake);
    loop(16.67);
    expect(fake.tickPhysics).toHaveBeenCalledTimes(1);
    expect(fake.updateMirror).toHaveBeenCalledTimes(1);
    expect(fake.rendererUpdate).toHaveBeenCalledTimes(1);
    expect(rafSpy).toHaveBeenCalledTimes(1);
  });

  it('phase==="connecting" → loading active → game-work SKIPPED', () => {
    storeState.phase = 'connecting';
    const { loop } = buildLoop(fake);
    loop(16.67);
    expect(fake.tickPhysics).not.toHaveBeenCalled();
    expect(fake.updateMirror).not.toHaveBeenCalled();
    expect(fake.rendererUpdate).not.toHaveBeenCalled();
    // RAF chain stays alive.
    expect(rafSpy).toHaveBeenCalledTimes(1);
  });

  it('phase==="game" + handshake pending → loading active → game-work SKIPPED', () => {
    storeState.arrivalAcked = false;
    storeState.arrivalTickFromServer = null;
    storeState.clientReadySent = false;
    const { loop } = buildLoop(fake);
    loop(16.67);
    expect(fake.tickPhysics).not.toHaveBeenCalled();
    expect(rafSpy).toHaveBeenCalledTimes(1);
  });

  it('kill switch ?loading=cosmetic forces NOT loading → game-work runs even mid-handshake', () => {
    storeState.loadingCosmeticOnly = true;
    storeState.arrivalAcked = false; // would normally be loading
    const { loop } = buildLoop(fake);
    loop(16.67);
    expect(fake.tickPhysics).toHaveBeenCalledTimes(1);
    expect(fake.rendererUpdate).toHaveBeenCalledTimes(1);
  });

  it('sendClientReady fires during loading window when bootstrap-ready', () => {
    // Phase=game, bootstrap gates all true, but handshake not yet started
    // → loading-active AND bootstrap-ready. sendClientReady must fire.
    storeState.clientReadySent = false;
    storeState.arrivalAcked = false;
    storeState.arrivalTickFromServer = null;
    const { loop } = buildLoop(fake);
    loop(16.67);
    expect(fake.sendClientReady).toHaveBeenCalledTimes(1);
    // Game-work still skipped (we're still loading).
    expect(fake.tickPhysics).not.toHaveBeenCalled();
  });

  it('sendClientReady does NOT fire when clientReadySent is already true', () => {
    storeState.clientReadySent = true;
    const { loop } = buildLoop(fake);
    loop(16.67);
    expect(fake.sendClientReady).not.toHaveBeenCalled();
  });

  it('lastFrameTime stays at 0 across a pause then resumes fresh', () => {
    // Drive a loading-active frame at t=1000, then a not-loading frame at
    // t=1016 (16ms later). The active-path delta should reflect the FRESH
    // boundary, not the 1016ms gap from the first call.
    storeState.arrivalAcked = false;
    storeState.arrivalTickFromServer = null;
    storeState.clientReadySent = false;
    const { loop } = buildLoop(fake);
    loop(1_000); // loading-active path
    expect(fake.tickPhysics).not.toHaveBeenCalled();

    // Resume: flip everything to ready and drive the next frame.
    storeState.clientReadySent = true;
    storeState.arrivalAcked = true;
    storeState.arrivalTickFromServer = 123;
    loop(1_016);
    expect(fake.tickPhysics).toHaveBeenCalledTimes(1);
    // The deltaMs argument is the second positional arg; for the first
    // active-path call it falls back to 1000/60 (lastFrameTime was 0).
    const [deltaMs] = fake.tickPhysics.mock.calls[0]!;
    // Either the firstFrame fallback (1000/60 ≈ 16.67) OR the 16ms gap
    // — but NOT 1016ms (which would have happened if lastFrameTime had
    // been updated on the paused call).
    expect(deltaMs).toBeLessThanOrEqual(20);
  });
});
