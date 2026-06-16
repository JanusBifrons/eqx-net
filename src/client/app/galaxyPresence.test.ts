import { describe, it, expect } from 'vitest';
import { mergePlayerPresence } from './galaxyPresence';
import type { RosterEntry } from '../state/storeTypes';

/** Minimal RosterEntry factory — only the fields mergePlayerPresence reads
 *  matter (sectorKey / isActive); the rest are filled with benign defaults. */
function ship(over: Partial<RosterEntry>): RosterEntry {
  return {
    shipId: 's',
    kind: 'fighter',
    kindVersion: 1,
    health: 100,
    sectorKey: 'sol-prime',
    x: 0,
    y: 0,
    isActive: false,
    ...over,
  };
}

describe('mergePlayerPresence (Equinox Phase 7)', () => {
  it('carries owned structures even with no ships in that sector', () => {
    const out = mergePlayerPresence([{ key: 'vega-reach', structures: 3 }], [], null);
    expect(out).toEqual([{ key: 'vega-reach', ships: 0, structures: 3 }]);
  });

  it('buckets non-active ships by their roster sectorKey and sums them', () => {
    const out = mergePlayerPresence(
      [],
      [ship({ sectorKey: 'orion-belt' }), ship({ sectorKey: 'orion-belt' }), ship({ sectorKey: 'lyra-fringe' })],
      'sol-prime',
    );
    const orion = out.find((s) => s.key === 'orion-belt')!;
    const lyra = out.find((s) => s.key === 'lyra-fringe')!;
    expect(orion).toEqual({ key: 'orion-belt', ships: 2, structures: 0 });
    expect(lyra).toEqual({ key: 'lyra-fringe', ships: 1, structures: 0 });
    // The active sector wasn't touched (no active ship here).
    expect(out.find((s) => s.key === 'sol-prime')).toBeUndefined();
  });

  it('places the ACTIVE ship at the live currentSectorKey, not its stale roster sectorKey', () => {
    const out = mergePlayerPresence(
      [],
      [ship({ isActive: true, sectorKey: 'stale-old-sector' })],
      'cygnus-arm',
    );
    expect(out).toEqual([{ key: 'cygnus-arm', ships: 1, structures: 0 }]);
    expect(out.find((s) => s.key === 'stale-old-sector')).toBeUndefined();
  });

  it('falls back to the active ship roster sectorKey when currentSectorKey is null', () => {
    const out = mergePlayerPresence([], [ship({ isActive: true, sectorKey: 'thornfield' })], null);
    expect(out).toEqual([{ key: 'thornfield', ships: 1, structures: 0 }]);
  });

  it('skips a ship with no resolvable sector', () => {
    const out = mergePlayerPresence([], [ship({ isActive: false, sectorKey: '' })], null);
    expect(out).toEqual([]);
  });

  it('merges owned structures + ships in the same sector', () => {
    const out = mergePlayerPresence(
      [{ key: 'sol-prime', structures: 5 }],
      [ship({ isActive: true, sectorKey: 'sol-prime' }), ship({ sectorKey: 'sol-prime' })],
      'sol-prime',
    );
    expect(out).toEqual([{ key: 'sol-prime', ships: 2, structures: 5 }]);
  });
});
