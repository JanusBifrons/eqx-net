import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useGalaxyStats } from './useGalaxyStats';
import { useUIStore } from '../state/store';
import type { SectorLiveState } from '../../shared-types/galaxySnapshot.js';

describe('useGalaxyStats', () => {
  beforeEach(() => {
    useUIStore.getState().setGalaxyStats([]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not poll when inactive', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useGalaxyStats(false));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('polls /galaxy/snapshot and writes the parsed sectors to the store', async () => {
    const sectors: SectorLiveState[] = [
      { key: 'sol-prime', players: 1, enemies: 2, neutrals: 0, structures: 3, owner: { factionId: 'core', contested: false } },
    ];
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sectors }) });
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useGalaxyStats(true));
    await vi.waitFor(() => expect(useUIStore.getState().galaxyStats).toEqual(sectors));
    expect(fetchMock).toHaveBeenCalledWith('/galaxy/snapshot');
  });

  it('ignores a malformed (zod-rejected) response without writing the store', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sectors: [{ key: 'x', players: 'not-a-number' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useGalaxyStats(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(useUIStore.getState().galaxyStats).toEqual([]);
  });
});
