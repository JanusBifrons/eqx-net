/**
 * @vitest-environment jsdom
 *
 * RTS slice 6c: each new renderer order (`orderSeq`) is SENT via
 * `sendFleetOrder` for the current fleet selection — once per seq, never
 * with an empty selection. Same harness shape as gameRafLoop.pause.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const storeState = vi.hoisted(() => ({
  clientReadySent: true,
  phase: 'game',
  setSelection: vi.fn(),
  setFleetPick: vi.fn(),
  setFleetPickPoints: vi.fn(),
}));

vi.mock('../state/store.js', () => ({
  useUIStore: { getState: () => storeState },
  computeBootstrapReadyFromState: () => true,
  computeIsLoadingActive: () => false,
}));
vi.mock('../debug/ClientLogger.js', () => ({ logEvent: vi.fn(), isFullDiagMode: () => false }));
vi.mock('../render/perFrameTriggers.js', () => ({ consumeOneFrameTriggers: vi.fn() }));
vi.mock('../perf/frameRateCap.js', () => ({ shouldSkipFrame: () => false }));
vi.mock('../ships/shipActionsClient.js', () => ({ sendFleetOrder: vi.fn() }));

import { createGameRafLoop } from './gameRafLoop.js';
import { sendFleetOrder } from '../ships/shipActionsClient.js';
import type { ColyseusGameClient } from '../net/ColyseusClient.js';
import type { FleetPickResultWire, IRenderer } from '@core/contracts/IRenderer';
import { setFleetCommands } from '../fleet/fleetCommands.js';

const fb = {
  firstFrameRendered: false, artReady: true, mountCounts: new Map(), haloArrowCount: 0,
  selectedPickId: null, selectedPickKind: null, helmCourseSeq: 0, helmCourseX: 0, helmCourseY: 0,
  fleetSelSeq: 0, fleetSelIds: [] as string[], orderSeq: 0, orderKind: 'move' as 'move' | 'attack',
  orderX: 0, orderY: 0, orderTargetId: null as string | null,
  takeControlsSeq: 0, takeControlsId: null as string | null,
  fleetPickPoints: 0, fleetPickSeq: 0, fleetPickResult: null as FleetPickResultWire | null,
};

function buildLoop(): (now: number) => void {
  const client = {
    tickPhysics: vi.fn(), tickInbound: vi.fn(), updateMirror: vi.fn(), sendClientReady: vi.fn(),
    consumePendingCameraGlide: () => null,
    consumePendingFleetArrival: () => null,
    mirror: { localPlayerId: 'ship-1', ships: new Map(), swarm: new Map(), projectiles: new Map() },
    transitInstr: { wantsFrame: () => false },
  } as unknown as ColyseusGameClient;
  const renderer = { update: vi.fn(), glideCameraTo: vi.fn(), getFeedback: () => fb } as unknown as IRenderer;
  return createGameRafLoop({
    el: document.createElement('div'), gameClient: client, renderer, useWorker: false,
    effectiveCapMs: 10, phaseEnterPerfNow: 0, animFrameRef: { current: 0 }, isDisposed: () => false,
  });
}

beforeEach(() => {
  vi.mocked(sendFleetOrder).mockClear();
  globalThis.requestAnimationFrame = vi.fn(() => 1) as unknown as typeof requestAnimationFrame;
  Object.assign(fb, { fleetSelIds: [], orderSeq: 0, orderKind: 'move', orderX: 0, orderY: 0, orderTargetId: null });
});

describe('gameRafLoop — fleet orders are sent (slice 6c)', () => {
  it('sends a move once per new seq, not again on the same seq', () => {
    const loop = buildLoop();
    Object.assign(fb, { fleetSelIds: ['a', 'b'], orderSeq: 1, orderKind: 'move', orderX: 10, orderY: -5 });
    loop(16.67);
    loop(40);
    loop(60);
    expect(sendFleetOrder).toHaveBeenCalledTimes(1);
    expect(sendFleetOrder).toHaveBeenCalledWith(['a', 'b'], { kind: 'move', x: 10, y: -5 });
    fb.orderSeq = 2;
    loop(80);
    expect(sendFleetOrder).toHaveBeenCalledTimes(2);
  });

  it('sends an attack with the target id', () => {
    const loop = buildLoop();
    Object.assign(fb, { fleetSelIds: ['a'], orderSeq: 1, orderKind: 'attack', orderTargetId: 's:7' });
    loop(16.67);
    expect(sendFleetOrder).toHaveBeenCalledWith(['a'], { kind: 'attack', targetId: 's:7' });
  });

  it('does not send with an empty selection', () => {
    const loop = buildLoop();
    Object.assign(fb, { fleetSelIds: [], orderSeq: 1, orderKind: 'move' });
    loop(16.67);
    expect(sendFleetOrder).not.toHaveBeenCalled();
  });
});

describe('gameRafLoop — fleet map picks are sent as set_mode (slice 14b)', () => {
  const setMode = vi.fn();
  beforeEach(() => {
    setMode.mockClear();
    storeState.setFleetPick.mockClear();
    storeState.setFleetPickPoints.mockClear();
    setFleetCommands({ setMode });
    Object.assign(fb, { fleetPickPoints: 0, fleetPickResult: null });
  });

  it('sends a patrol route once per seq, then ends the pick', () => {
    const loop = buildLoop();
    loop(16.67); // settle on the current seq
    const route: [number, number][] = [[0, 0], [100, 0], [100, 50]];
    Object.assign(fb, { fleetSelIds: ['a', 'b'], fleetPickSeq: fb.fleetPickSeq + 1, fleetPickResult: { kind: 'patrol', route } });
    loop(40);
    loop(60);
    expect(setMode).toHaveBeenCalledTimes(1);
    expect(setMode).toHaveBeenCalledWith(['a', 'b'], 'patrol', { route });
    expect(storeState.setFleetPick).toHaveBeenCalledWith(null);
  });

  it('sends escort with the picked ship and retreat with the point', () => {
    const loop = buildLoop();
    loop(16.67);
    Object.assign(fb, { fleetSelIds: ['a'], fleetPickSeq: fb.fleetPickSeq + 1, fleetPickResult: { kind: 'escort', escortId: 'hull-9' } });
    loop(40);
    expect(setMode).toHaveBeenLastCalledWith(['a'], 'escort', { escortId: 'hull-9' });
    Object.assign(fb, { fleetPickSeq: fb.fleetPickSeq + 1, fleetPickResult: { kind: 'retreat', x: 5, y: -7 } });
    loop(60);
    expect(setMode).toHaveBeenLastCalledWith(['a'], 'retreat', { x: 5, y: -7 });
  });

  it('mirrors the picked-point count into the store on change only', () => {
    const loop = buildLoop();
    loop(16.67);
    storeState.setFleetPickPoints.mockClear();
    fb.fleetPickPoints = 3;
    loop(40);
    loop(60);
    expect(storeState.setFleetPickPoints).toHaveBeenCalledTimes(1);
    expect(storeState.setFleetPickPoints).toHaveBeenCalledWith(3);
  });
});

describe('gameRafLoop — double tap on an own ship takes its controls (RTS slice 10)', () => {
  it('sends takeControls once per seq', () => {
    const takeControls = vi.fn();
    setFleetCommands({ takeControls });
    const loop = buildLoop();
    loop(16.67);
    Object.assign(fb, { takeControlsSeq: fb.takeControlsSeq + 1, takeControlsId: 'hull-3' });
    loop(40);
    loop(60);
    expect(takeControls).toHaveBeenCalledTimes(1);
    expect(takeControls).toHaveBeenCalledWith('hull-3');
  });
});

describe('gameRafLoop — a double-tap take goes straight to Fly (no panel flash)', () => {
  it("does not mirror the first tap's narrowed selection while the take is pending", () => {
    // Hostile clip review: the double tap's first tap narrowed the squad to the
    // tapped ship, and the fleet panel rendered "1 ship selected" for a frame
    // before the welcome flipped to Fly.
    setFleetCommands({ takeControls: vi.fn() });
    const s = storeState as typeof storeState & { pilotMode?: string };
    s.pilotMode = 'spectator';
    const loop = buildLoop();
    loop(16.67);
    storeState.setSelection.mockClear();
    Object.assign(fb, {
      fleetSelSeq: fb.fleetSelSeq + 1, fleetSelIds: ['hull-3'],
      takeControlsSeq: fb.takeControlsSeq + 1, takeControlsId: 'hull-3',
    });
    loop(40);
    loop(60);
    expect(storeState.setSelection).not.toHaveBeenCalled();
    // The welcome flips to Fly (panel hidden): the held change lands behind it.
    s.pilotMode = 'pilot';
    loop(80);
    expect(storeState.setSelection).toHaveBeenCalledWith(['hull-3'], null, null);
    delete s.pilotMode;
  });
});
