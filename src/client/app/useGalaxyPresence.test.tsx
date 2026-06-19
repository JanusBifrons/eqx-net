import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useGalaxyPresence } from './useGalaxyPresence';
import { useUIStore } from '../state/store';

const PID = '00000000-0000-4000-8000-000000000001';

describe('useGalaxyPresence', () => {
  beforeEach(() => {
    useUIStore.getState().setGalaxyOwnedStructures([]);
    useUIStore.getState().setGalaxyPresenceLoaded(false);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not poll when inactive', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useGalaxyPresence(false, PID));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not poll without a playerId (logged-out browses the map freely)', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useGalaxyPresence(true, null));
    expect(fetchMock).not.toHaveBeenCalled();
    // …and the gate's own-presence flag stays false (the gate short-circuits it
    // for a logged-out pilot, so this never blocks the reveal).
    expect(useUIStore.getState().galaxyPresenceLoaded).toBe(false);
  });

  it('writes owned structures and flips galaxyPresenceLoaded on the first completed poll', async () => {
    const sectors = [{ key: 'sol-prime', structures: 2 }];
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sectors }) });
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useGalaxyPresence(true, PID));
    await vi.waitFor(() => expect(useUIStore.getState().galaxyOwnedStructures).toEqual(sectors));
    // 2026-06-19 pop-in gate — flips so the landing reveal waits on OWN structures.
    expect(useUIStore.getState().galaxyPresenceLoaded).toBe(true);
  });

  it('flips galaxyPresenceLoaded even on a malformed response (opaque gate must never black-screen)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sectors: [{ key: 'x', structures: 'not-a-number' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useGalaxyPresence(true, PID));
    await vi.waitFor(() => expect(useUIStore.getState().galaxyPresenceLoaded).toBe(true));
    // …but the malformed payload is NOT written to the store.
    expect(useUIStore.getState().galaxyOwnedStructures).toEqual([]);
  });
});
