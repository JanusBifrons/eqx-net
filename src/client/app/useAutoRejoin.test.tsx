/**
 * Away-from-home phone playtest (2026-11-21, capture `v7p1ce`): the phone was
 * backgrounded mid-game, the room dropped while the page was frozen, and on
 * return (`visibilitychange visible` → `/healthz` unreachable→healthy ~1 s
 * later) the player sat on the Lost Connection overlay until they tapped
 * "Return to menu" and re-launched the same ship from the Hangar — which the
 * server accepted (`rescued_own_ship_from_lingering`, same playerId). These
 * lock the automatic version of that rejoin.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUIStore } from '../state/store';
import { setGameClient } from '../net/clientSingleton';
import type { ColyseusGameClient } from '../net/ColyseusClient';
import { useAutoRejoin } from './useAutoRejoin';
import { useShipSwapDispatcher } from './appHooks';

function fakeClient(shipInstanceId: string | null): ColyseusGameClient {
  return { mirror: { localShipInstanceId: shipInstanceId } } as unknown as ColyseusGameClient;
}

function droppedInGame(): void {
  const s = useUIStore.getState();
  s.setPhase('game');
  s.setCurrentSectorKey('sol-prime');
  s.setPendingShipSwap(null);
  s.setServerHealth('unreachable', null);
  s.setConnectionStatus('disconnected');
}

describe('useAutoRejoin — back in the sector after the phone comes back', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    droppedInGame();
  });
  afterEach(() => {
    setGameClient(null);
    vi.useRealTimers();
  });

  it('rejoins the same ship and sector once the server is reachable again (command view stays command)', () => {
    setGameClient(fakeClient('ship-1'));
    useUIStore.getState().setPilotMode('spectator'); // RTS command view
    renderHook(() => useAutoRejoin());
    expect(useUIStore.getState().pendingShipSwap).toBeNull(); // server still unreachable
    act(() => { useUIStore.getState().setServerHealth('healthy', 3); });
    expect(useUIStore.getState().pendingShipSwap).toEqual({ shipId: 'ship-1', sectorKey: 'sol-prime', startMode: 'command' });
  });

  it('a pilot at the controls rejoins flying', () => {
    setGameClient(fakeClient('ship-1'));
    useUIStore.getState().setPilotMode('pilot');
    renderHook(() => useAutoRejoin());
    act(() => { useUIStore.getState().setServerHealth('healthy', 3); });
    expect(useUIStore.getState().pendingShipSwap?.startMode).toBe('fly');
  });

  it('does nothing without a ship to rejoin (shipless spectator) — the overlay path is unchanged', () => {
    setGameClient(fakeClient(null));
    renderHook(() => useAutoRejoin());
    act(() => { useUIStore.getState().setServerHealth('healthy', 3); });
    expect(useUIStore.getState().pendingShipSwap).toBeNull();
  });

  it('a failed rejoin retries a bounded number of times, spaced out', () => {
    setGameClient(fakeClient('ship-1'));
    renderHook(() => useAutoRejoin());
    act(() => { useUIStore.getState().setServerHealth('healthy', 3); });
    let attempts = 0;
    for (let i = 0; i < 10; i++) {
      if (useUIStore.getState().pendingShipSwap) {
        attempts++;
        act(() => {
          useUIStore.getState().setPendingShipSwap(null); // dispatcher consumed it
          useUIStore.getState().setConnectionStatus('connecting');
          useUIStore.getState().setConnectionStatus('error'); // join failed
        });
      }
      act(() => { vi.advanceTimersByTime(10_000); });
    }
    expect(attempts).toBe(3);
  });

  it('a retry keeps the first attempt\'s control mode (teardown resets pilotMode to pilot)', () => {
    setGameClient(fakeClient('ship-1'));
    useUIStore.getState().setPilotMode('spectator');
    renderHook(() => useAutoRejoin());
    act(() => { useUIStore.getState().setServerHealth('healthy', 3); });
    expect(useUIStore.getState().pendingShipSwap?.startMode).toBe('command');
    act(() => {
      useUIStore.getState().setPendingShipSwap(null);
      useUIStore.getState().setPilotMode('pilot'); // clientTeardown
      useUIStore.getState().setCurrentSectorKey(null); // dispatcher clears it
      setGameClient(fakeClient(null)); // fresh client, no welcome yet
      useUIStore.getState().setConnectionStatus('connecting');
      useUIStore.getState().setConnectionStatus('error');
    });
    act(() => { vi.advanceTimersByTime(6_000); });
    expect(useUIStore.getState().pendingShipSwap).toEqual({ shipId: 'ship-1', sectorKey: 'sol-prime', startMode: 'command' });
  });
});

describe('useShipSwapDispatcher — carries the rejoin start mode', () => {
  it('joins with the requested startMode (defaults to fly for the galaxy-map pilot swap)', () => {
    vi.useFakeTimers();
    const setRoom = vi.fn();
    const setOpts = vi.fn();
    useUIStore.getState().setPhase('game');
    renderHook(() => useShipSwapDispatcher(setRoom, setOpts));
    act(() => { useUIStore.getState().setPendingShipSwap({ shipId: 's', sectorKey: 'sol-prime', startMode: 'command' }); });
    expect(setOpts).toHaveBeenLastCalledWith({ shipId: 's', startMode: 'command' });
    act(() => { vi.advanceTimersByTime(300); });
    act(() => { useUIStore.getState().setPendingShipSwap({ shipId: 's', sectorKey: 'sol-prime' }); });
    expect(setOpts).toHaveBeenLastCalledWith({ shipId: 's', startMode: 'fly' });
    act(() => { vi.advanceTimersByTime(300); });
    vi.useRealTimers();
  });
});
