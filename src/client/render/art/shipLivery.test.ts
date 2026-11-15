/** Per-ship livery plumbing: bake keys and shipHandleFor's re-acquire check. */
import { describe, it, expect } from 'vitest';
import { bakeKey, type BakeJob } from './bake.js';
import { ownerLivery, shipHandleFor, type ShipArtCtx } from './shipArtSprites.js';
import { teamEdgeOf } from '../../../shared-types/factions.js';
import type { ArtHandle, ArtService } from './ArtService.js';
import type { Livery } from './fields.js';

const L: Livery = { treatment: 'a', team: 0x3a7bff, sigil: 0xffd23a };

describe('bakeKey with livery', () => {
  it('is unchanged without a livery', () => {
    expect(bakeKey({ type: 'ship', id: 'fighter', paint: 0x123456 })).toBe(bakeKey({ type: 'ship', id: 'fighter', paint: 0x123456, livery: undefined }));
    expect(bakeKey({ type: 'ship', id: 'fighter' })).not.toContain(':L');
  });
  it('differs per treatment, team and sigil (lit too)', () => {
    const k = (l: Livery, lit = false): string => bakeKey({ type: 'ship', id: 'fighter', livery: l, lit });
    const keys = [k(L), k({ ...L, treatment: 'b' }), k({ ...L, team: 0xff0000 }), k({ ...L, sigil: 0x00ff00 }), bakeKey({ type: 'ship', id: 'fighter' }),
      k({ ...L, treatment: 'b8' }), k({ ...L, treatment: 'b8', edge: 'swept' }), k({ ...L, treatment: 'b8', edge: 'tooth' })];
    expect(new Set(keys).size).toBe(keys.length);
    expect(k(L, true)).not.toBe(bakeKey({ type: 'ship', id: 'fighter', lit: true }));
  });
});

function ctx(livery?: Livery['treatment']): { actx: ShipArtCtx; calls: (Livery | undefined)[] } {
  const calls: (Livery | undefined)[] = [];
  const art = {
    ship: (id: string, paint?: number, _u?: boolean, rings?: boolean, dead?: boolean, lv?: Livery): ArtHandle => {
      calls.push(lv);
      const job: BakeJob = { type: 'ship', id, paint, ...(rings ? { rings } : {}), ...(dead ? { dead } : {}), ...(lv ? { livery: lv } : {}) };
      return { key: bakeKey(job), job, rig: undefined as never, state: 'pending', ship: null, struct: null };
    },
  } as unknown as ArtService;
  return { actx: { art, handles: new Map(), sunAz: 0, ...(livery ? { livery } : {}) }, calls };
}

describe('shipHandleFor livery', () => {
  it('re-acquires only when a livery scalar changes', () => {
    const { actx, calls } = ctx('a');
    const h1 = shipHandleFor(actx, 'k', 'fighter', undefined, false, L.team, L.sigil);
    expect(calls).toEqual([L]);
    expect(shipHandleFor(actx, 'k', 'fighter', undefined, false, L.team, L.sigil)).toBe(h1);
    expect(calls).toHaveLength(1);
    shipHandleFor(actx, 'k', 'fighter', undefined, false, 0xff0000, L.sigil);
    shipHandleFor(actx, 'k', 'fighter', undefined, false, 0xff0000, 0x00ff00);
    shipHandleFor(actx, 'k', 'fighter', undefined, false, 0xff0000, 0x00ff00);
    actx.livery = 'c';
    shipHandleFor(actx, 'k', 'fighter', undefined, false, 0xff0000, 0x00ff00);
    expect(calls.map((c) => c && `${c.treatment}${c.team}:${c.sigil}`)).toEqual([
      `a${L.team}:${L.sigil}`, `a${0xff0000}:${L.sigil}`, `a${0xff0000}:${0x00ff00}`, `c${0xff0000}:${0x00ff00}`,
    ]);
  });
  it('flag off or no team: no livery, existing callers unchanged', () => {
    const { actx, calls } = ctx();
    shipHandleFor(actx, 'k', 'fighter', undefined, false, L.team, L.sigil);
    shipHandleFor(actx, 'k', 'fighter', undefined);
    expect(calls).toEqual([undefined]);
    const on = ctx('b');
    shipHandleFor(on.actx, 'k', 'fighter', undefined);
    shipHandleFor(on.actx, 'k', 'fighter', undefined, false, L.team);
    expect(on.calls).toEqual([undefined, { treatment: 'b', team: L.team, sigil: L.team }]);
  });
});

describe('wreck pieces under a livery', () => {
  it('a dead bake keeps the owner livery and keys apart from the live hull', () => {
    const { actx, calls } = ctx('b8');
    const live = shipHandleFor(actx, 'live', 'fighter', undefined, false, L.team, L.sigil, 'swept')!;
    const dead = shipHandleFor(actx, 'wreck', 'fighter', undefined, true, L.team, L.sigil, 'swept')!;
    expect(shipHandleFor(actx, 'wreck', 'fighter', undefined, true, L.team, L.sigil, 'swept')).toBe(dead);
    expect(calls).toHaveLength(2);
    expect(dead.job).toMatchObject({ dead: true, livery: { treatment: 'b8', team: L.team, edge: 'swept' } });
    expect(dead.key).not.toBe(live.key);
  });
});

describe('livery edge plumbing (b8)', () => {
  it('ownerLivery carries the faction edge, and reuses one cached object per owner', () => {
    const a = ownerLivery('robots');
    expect(a.edge).toBe(teamEdgeOf('robots'));
    expect(ownerLivery('robots')).toBe(a);
  });
  it('shipHandleFor passes the edge into the Livery and re-acquires only when it changes', () => {
    const { actx, calls } = ctx('b8');
    const h1 = shipHandleFor(actx, 'k', 'fighter', undefined, false, L.team, L.sigil, 'swept');
    expect(shipHandleFor(actx, 'k', 'fighter', undefined, false, L.team, L.sigil, 'swept')).toBe(h1);
    shipHandleFor(actx, 'k', 'fighter', undefined, false, L.team, L.sigil, 'tooth');
    shipHandleFor(actx, 'k', 'fighter', undefined, false, L.team, L.sigil, 'tooth');
    expect(calls).toEqual([{ treatment: 'b8', team: L.team, sigil: L.sigil, edge: 'swept' }, { treatment: 'b8', team: L.team, sigil: L.sigil, edge: 'tooth' }]);
  });
});
