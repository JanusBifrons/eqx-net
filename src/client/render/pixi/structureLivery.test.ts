/** Structure livery (structure restyle 1c, `?structLivery=1`): flag off is
 *  today's plan, bake key and art call; on adds bands + sigil slots. */
import { describe, it, expect } from 'vitest';
import { buildStructureVisual } from './structureVisuals.js';
import { bakeKey, type BakeJob } from '../art/bake.js';
import { ownerLivery, structHandleFor, type ShipArtCtx } from '../art/shipArtSprites.js';
import { readStructLivery } from '../art/artMode.js';
import type { ArtHandle, ArtService } from '../art/ArtService.js';
import type { StructLivery } from '../art/fields.js';
import { STRUCTURE_KINDS_LIST } from '../../../shared-types/structureKinds.js';

const SL: StructLivery = { team: 0x3a7bff, sigil: 0xffd23a };

describe('structure plan livery', () => {
  it('flag off: plan unchanged (no sigils/bands keys) for every kind', () => {
    for (const k of STRUCTURE_KINDS_LIST) {
      const base = buildStructureVisual(k.id, { accent: k.color, seed: 3 });
      expect(buildStructureVisual(k.id, { accent: k.color, seed: 3, livery: false })).toEqual(base);
      expect('sigils' in base).toBe(false);
      expect('bands' in base).toBe(false);
    }
  });
  it('flag on: the capital gets a big central sigil screen', () => {
    const v = buildStructureVisual('capital', { accent: 0xffffff, livery: true });
    const screen = v.sigils?.find((s) => s.screen === true);
    expect(screen).toBeDefined();
    expect(screen!.x).toBe(0);
    expect(screen!.y).toBe(0);
    expect(screen!.r).toBeGreaterThan(40);
    expect(v.bands?.length).toBeGreaterThan(0);
  });
  it('flag on: refinery, cargo bay and freight dock get smaller slots', () => {
    const capR = buildStructureVisual('capital', { accent: 0, livery: true }).sigils![0]!.r;
    for (const id of ['refinery', 'cargo_bay', 'freight_dock']) {
      const v = buildStructureVisual(id, { accent: 0, livery: true });
      expect(v.sigils?.length, id).toBeGreaterThan(0);
      for (const s of v.sigils!) {
        expect(s.r).toBeGreaterThan(0);
        expect(s.r).toBeLessThan(capR);
        expect(s.screen).not.toBe(true);
      }
    }
  });
});

describe('structure bake key livery', () => {
  const job = (livery?: StructLivery, lit = false): BakeJob => ({ type: 'struct', id: 'capital', seed: 1, rot: 0, ...(livery ? { livery, accent: livery.team } : {}), ...(lit ? { lit } : {}) });
  it('flag off: no livery tag', () => {
    expect(bakeKey(job())).not.toContain(':SL');
    expect(bakeKey(job(undefined, true))).not.toContain(':SL');
  });
  it('flag on: tagged, and differs per team / sigil (lit too)', () => {
    expect(bakeKey(job(SL))).toContain(':SL');
    expect(bakeKey(job(SL, true))).toContain(':SL');
    const keys = [bakeKey(job(SL)), bakeKey(job({ ...SL, team: 0xff0000 })), bakeKey(job({ ...SL, sigil: 1 })), bakeKey(job())];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

function ctx(structLivery: boolean): { actx: ShipArtCtx; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const art = {
    struct: (id: string, seed: number, rot = 0, accent?: number, urgent = true, rings = false, livery?: StructLivery): ArtHandle => {
      calls.push([id, seed, rot, accent, urgent, rings, livery]);
      const job: BakeJob = { type: 'struct', id, seed, rot, ...(accent !== undefined ? { accent } : {}), ...(livery ? { livery } : {}) };
      return { key: bakeKey(job), job, rig: undefined as never, state: 'pending', ship: null, struct: null };
    },
  } as unknown as ArtService;
  return { actx: { art, handles: new Map(), sunAz: 0, ...(structLivery ? { structLivery: true } : {}) }, calls };
}

describe('structHandleFor livery', () => {
  it('flag off: today\'s call even with an owner', () => {
    const { actx, calls } = ctx(false);
    structHandleFor(actx, 'a', 'capital', 0, 'player-1');
    structHandleFor(actx, 'b', 'capital', 0);
    expect(calls).toEqual([['capital', 1, 0, undefined, true, false, undefined], ['capital', 1, 0, undefined, true, false, undefined]]);
  });
  it('flag on: owner colours + sigil; re-acquires only on owner change', () => {
    const { actx, calls } = ctx(true);
    const h = structHandleFor(actx, 'a', 'capital', 0, 'player-1');
    expect(structHandleFor(actx, 'a', 'capital', 0, 'player-1')).toBe(h);
    const lv = ownerLivery('player-1');
    expect(calls).toEqual([['capital', 1, 0, lv.team, true, false, { team: lv.team, sigil: lv.sigil }]]);
    structHandleFor(actx, 'a', 'capital', 0, 'player-2');
    expect(calls).toHaveLength(2);
    structHandleFor(actx, 'a', 'capital', 0);
    expect(calls[2]).toEqual(['capital', 1, 0, undefined, true, false, undefined]);
  });
});

describe('readStructLivery', () => {
  it('parses ?structLivery=1 only', () => {
    expect(readStructLivery('?art=machined&structLivery=1')).toBe(true);
    expect(readStructLivery('?structLivery=0')).toBe(false);
    expect(readStructLivery('?structLivery=10')).toBe(false);
    expect(readStructLivery('')).toBe(false);
  });
});
