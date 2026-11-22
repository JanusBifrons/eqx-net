/**
 * Capital S5 lock: the trip's destination key (`transitTargetSectorKey`) that
 * the load curtain names is set by `transit_ready` (a commander following a
 * fleet warp gets no SPOOLING edge of their own) and survives the ARRIVED and
 * 2 s fallback timers; only the new sector's welcome clears it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Room } from 'colyseus.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { TransitInstrumentation } from '../../debug/TransitInstrumentation';
import { useUIStore } from '../../state/store';
import { registerTransitHandlers, type TransitHandlerCtx } from './transitHandlers';

type Handler = (msg: unknown) => unknown;

function fakeRoom(): { room: Room; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const room = {
    onMessage: (ch: string, h: Handler) => { handlers.set(ch, h); },
    leave: async () => undefined,
  } as unknown as Room;
  return { room, handlers };
}

function fakeCtx(): TransitHandlerCtx {
  const mirror = { ships: new Map(), localPlayerId: null } as unknown as RenderMirror;
  const instr = { mark: () => undefined, arm: () => undefined } as unknown as TransitInstrumentation;
  return {
    mirror, transitInstr: instr, now: () => 0, isDisposed: () => false,
    serverTickAtWelcome: () => 0, welcomePerfNow: () => 0,
    isTravelling: () => false, beginTravel: () => undefined, travelOutRemainingMs: () => 0,
    setFleetArrival: () => undefined, resetPredictionState: () => undefined,
    dropRemoteShip: () => undefined, onSectorHandoff: () => undefined,
    consumeSeatReservation: async () => fakeRoom().room, adoptRoom: () => undefined,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  useUIStore.setState({ transitTargetSectorKey: null, transitState: 'DOCKED', pilotMode: 'spectator', travelling: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('transit target key (capital S5)', () => {
  it('a commander following their fleet learns the destination from transit_ready', async () => {
    const { room, handlers } = fakeRoom();
    registerTransitHandlers(room, fakeCtx());
    await handlers.get('transit_ready')!({ reservation: {}, targetSectorKey: 'vega-reach', shipIds: ['s1'] });
    expect(useUIStore.getState().transitTargetSectorKey).toBe('vega-reach');
  });

  it('a stalled trip keeps the destination after the ARRIVED and fallback timers', async () => {
    const { room, handlers } = fakeRoom();
    registerTransitHandlers(room, fakeCtx());
    useUIStore.setState({ transitState: 'IN_TRANSIT' });
    await handlers.get('transit_ready')!({ reservation: {}, targetSectorKey: 'vega-reach', shipIds: ['s1'] });
    await vi.advanceTimersByTimeAsync(2600); // 2 s fallback → ARRIVED → DOCKED
    expect(useUIStore.getState().transitState).toBe('DOCKED');
    expect(useUIStore.getState().transitTargetSectorKey).toBe('vega-reach');
    handlers.get('transit_state')!({ type: 'transit_state', state: 'ARRIVED' });
    await vi.advanceTimersByTimeAsync(600);
    expect(useUIStore.getState().transitTargetSectorKey).toBe('vega-reach');
  });

  it('a cancelled trip still clears the destination', () => {
    const { room, handlers } = fakeRoom();
    registerTransitHandlers(room, fakeCtx());
    useUIStore.setState({ transitTargetSectorKey: 'vega-reach' });
    handlers.get('transit_state')!({ type: 'transit_state', state: 'DOCKED', reason: 'x' });
    expect(useUIStore.getState().transitTargetSectorKey).toBeNull();
  });
});
