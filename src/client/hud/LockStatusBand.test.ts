import { describe, it, expect } from 'vitest';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { summariseOwnLock, summariseThreats } from './LockStatusBand';

function mirror(over: Partial<RenderMirror>): RenderMirror {
  return {
    ships: new Map(),
    swarm: new Map([
      [4, { kind: 1, shipKind: 'fighter', x: 0, y: 0 }],
      [5, { kind: 1, shipKind: 'fighter', x: 0, y: 0 }],
      [6, { kind: 1, shipKind: 'heavy', x: 0, y: 0 }],
    ]),
    ...over,
  } as unknown as RenderMirror;
}

describe('summariseThreats', () => {
  it('null when nobody is locking you', () => {
    expect(summariseThreats(mirror({ localLockedBy: [] }))).toBeNull();
  });
  it('counts locked vs acquiring, names by ship kind, picks the furthest-along lock', () => {
    const t = summariseThreats(mirror({
      localLockedBy: [{ t: 's:4', s: 2, p: 100 }, { t: 's:5', s: 2, p: 100 }, { t: 's:6', s: 1, p: 60 }],
    }))!;
    expect(t.locked).toBe(2);
    expect(t.lockedName).toMatch(/fighter/i);
    expect(t.acquiring).toBe(1);
    expect(t.acquiringPct).toBe(60);
    expect(t.lockedName).not.toMatch(/s:\d/); // never an id
  });
});

describe('summariseOwnLock', () => {
  it('reports the most advanced lock still building, with its group name', () => {
    const o = summariseOwnLock(mirror({
      localGroups: [
        { id: 'fore', m: 0, l: [{ t: 's:4', s: 2, p: 100 }] },
        { id: 'aft', m: 0, l: [{ t: 's:6', s: 1, p: 40 }] },
      ],
    }), ['Fore', 'Aft'])!;
    expect(o.group).toBe('Aft');
    expect(o.groupIndex).toBe(1);
    expect(o.pct).toBe(40);
    expect(o.failsafe).toBe(false);
  });
  it('null when every lock is complete', () => {
    expect(summariseOwnLock(mirror({ localGroups: [{ id: 'fore', m: 0, l: [{ t: 's:4', s: 2, p: 100 }] }] }), ['Fore'])).toBeNull();
  });
});
