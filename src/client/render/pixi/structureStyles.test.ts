/** Structure styles (structure restyle 1d, `?restyle=`): `current` or no
 *  param is today's plan, bake key and forge bytes; style A draws the six
 *  outpost pieces as faceted plates inside each kind's outline. */
import { describe, it, expect } from 'vitest';
import { buildStructureVisual } from './structureVisuals.js';
import { parseStructureStyle, STRUCTURE_STYLE_IDS, STRUCTURE_STYLES, structureStyleDrawer } from './structureStyles.js';
import { insidePoly, outlinePx, polyEdgeDist } from './structureStyleKit.js';
import { bakeKey, type BakeJob } from '../art/bake.js';
import { readStructStyle } from '../art/artMode.js';
import { forgeStructure, MAT, type Fields } from '../art/fields.js';
import { structHandleFor, type ShipArtCtx } from '../art/shipArtSprites.js';
import type { ArtHandle, ArtService } from '../art/ArtService.js';
import { STRUCTURE_KINDS_LIST } from '../../../shared-types/structureKinds.js';

const OUTPOST = ['capital', 'connector', 'freight_dock', 'reactor', 'cargo_bay', 'refinery'] as const;
const bytes = (f: Fields): Buffer[] => [f.albedo, f.height, f.emis, f.mat, f.key, f.cov].map((a) => Buffer.from(a.buffer));

describe('style registry', () => {
  it('ids are current + the table; unknown/absent parse to current', () => {
    expect(STRUCTURE_STYLE_IDS).toEqual(['current', ...Object.keys(STRUCTURE_STYLES)]);
    expect(parseStructureStyle('a')).toBe('a');
    expect(parseStructureStyle(null)).toBe('current');
    expect(parseStructureStyle('zzz')).toBe('current');
  });
  it('readStructStyle: only a registered non-current style', () => {
    expect(readStructStyle('?art=machined&restyle=a')).toBe('a');
    expect(readStructStyle('?restyle=current')).toBeUndefined();
    expect(readStructStyle('?restyle=zzz')).toBeUndefined();
    expect(readStructStyle('')).toBeUndefined();
  });
  it('style A restyles exactly the six outpost pieces', () => {
    expect(Object.keys(STRUCTURE_STYLES.a.kinds).sort()).toEqual([...OUTPOST].sort());
    expect(structureStyleDrawer('current', 'capital')).toBeUndefined();
    expect(structureStyleDrawer(undefined, 'capital')).toBeUndefined();
  });
});

describe('restyle=current is byte-identical to today', () => {
  it('plan: unchanged for every kind, livery on and off', () => {
    for (const k of STRUCTURE_KINDS_LIST) {
      for (const livery of [false, true]) {
        const base = buildStructureVisual(k.id, { accent: k.color, seed: 3, livery });
        expect(buildStructureVisual(k.id, { accent: k.color, seed: 3, livery, style: 'current' })).toEqual(base);
        expect('polys' in base).toBe(false);
      }
    }
  });
  it('bake key: no style tag for absent style', () => {
    const job: BakeJob = { type: 'struct', id: 'capital', seed: 1, rot: 0 };
    expect(bakeKey(job)).toBe('m:capital:1:');
    expect(bakeKey({ ...job, style: 'a' })).toBe('m:capital:1::Sa');
    expect(bakeKey({ ...job, lit: true })).not.toContain(':S');
    expect(bakeKey({ ...job, lit: true, style: 'a' })).toContain(':Sa');
  });
  it('forge: current = the opts-free bake, byte for byte', () => {
    for (const id of OUTPOST) {
      const a = bytes(forgeStructure(id, { ppu: 0.5, seed: 1 }));
      const b = bytes(forgeStructure(id, { ppu: 0.5, seed: 1, style: 'current' }));
      a.forEach((x, i) => expect(x.equals(b[i]!), id).toBe(true));
    }
  });
  it('structHandleFor: no style asked = no style on the job', () => {
    const jobs: BakeJob[] = [];
    const art = {
      struct: (id: string, seed: number, rot = 0, accent?: number, _u = true, rings = false, _l?: unknown, style?: string): ArtHandle => {
        const job: BakeJob = { type: 'struct', id, seed, rot, accent, ...(rings ? { rings } : {}), ...(style && style !== 'current' ? { style } : {}) };
        jobs.push(job);
        return { key: bakeKey(job), job, rig: undefined as never, state: 'pending', ship: null, struct: null } as ArtHandle;
      },
    } as unknown as ArtService;
    const actx: ShipArtCtx = { art, handles: new Map(), sunAz: 0 };
    structHandleFor(actx, 'k', 'capital', 0);
    expect(jobs[0]!.type === 'struct' && 'style' in jobs[0]!).toBe(false);
    const styled: ShipArtCtx = { art, handles: new Map(), sunAz: 0, structStyle: 'a' };
    const h = structHandleFor(styled, 'k', 'capital', 0);
    expect(h!.key).toContain(':Sa');
    expect(structHandleFor(styled, 'k', 'capital', 0)).toBe(h);
  });
});

describe('style A', () => {
  it('draws faceted polygons inside the kind outline (no plain boxes)', () => {
    for (const id of OUTPOST) {
      const v = buildStructureVisual(id, { accent: 0x66ccaa, style: 'a', livery: true });
      expect(v.polys!.length, id).toBeGreaterThan(3);
      expect(v.rects, id).toEqual([]);
      const out = outlinePx(id, 'a');
      for (const p of v.polys!) {
        expect(p.pts.length, id).toBeGreaterThanOrEqual(3);
        for (const [x, y] of p.pts) expect(polyEdgeDist(out, x, y), `${id} ${x},${y}`).toBeGreaterThan(-0.5);
      }
      for (const l of v.lights) expect(insidePoly(out, l.x, l.y), id).toBe(true);
      for (const s of v.sigils!) expect(polyEdgeDist(out, s.x, s.y), id).toBeGreaterThan(s.r);
      expect(v.bands!.length, id).toBeGreaterThan(0);
    }
  });
  it('the beacon carries the biggest sigil screen, centred', () => {
    const cap = buildStructureVisual('capital', { accent: 0, style: 'a', livery: true }).sigils!;
    const screen = cap.find((s) => s.screen === true)!;
    expect(screen).toMatchObject({ x: 0, y: 0 });
    for (const id of OUTPOST) {
      if (id === 'capital') continue;
      for (const s of buildStructureVisual(id, { accent: 0, style: 'a', livery: true }).sigils ?? []) expect(s.r).toBeLessThan(screen.r);
    }
  });
  it('forge: bakes the plates (differs from today, has glow and coverage)', () => {
    for (const id of OUTPOST) {
      const f = forgeStructure(id, { ppu: 0.5, seed: 1, style: 'a', livery: { team: 0x3a7bff, sigil: 0xffd23a } });
      const today = forgeStructure(id, { ppu: 0.5, seed: 1 });
      expect(Buffer.from(f.albedo.buffer).equals(Buffer.from(today.albedo.buffer)), id).toBe(false);
      expect(f.mat.some((m) => m === MAT.WINDOW), id).toBe(true);
      expect(f.cov.some((c) => c > 0.5), id).toBe(true);
    }
  });
});
