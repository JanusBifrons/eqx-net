/** Structure styles (structure restyle 1d, `?restyle=`): `current` or no
 *  param is today's plan, bake key and forge bytes; style A draws the six
 *  outpost pieces as faceted plates inside each kind's outline. */
import { describe, it, expect } from 'vitest';
import { buildStructureVisual } from './structureVisuals.js';
import { parseStructureStyle, STRUCTURE_STYLE_IDS, STRUCTURE_STYLES, structureStyleDrawer } from './structureStyles.js';
import { artFramePx, insidePoly, outlinePx, polyEdgeDist } from './structureStyleKit.js';
import { bakeKey, type BakeJob } from '../art/bake.js';
import { DEFAULT_STRUCT_STYLE, readStructStyle } from '../art/artMode.js';
import { forgeStructure, MAT, type Fields } from '../art/fields.js';
import { structHandleFor, type ShipArtCtx } from '../art/shipArtSprites.js';
import type { ArtHandle, ArtService } from '../art/ArtService.js';
import { STRUCTURE_KINDS_LIST, structureSockets } from '../../../shared-types/structureKinds.js';
import { STYLE_C_FAMILIES } from './structureStyleC.js';

/** The kinds style C draws, read from its family files (`structureStyleC.<family>.ts`). */
const C_KINDS = Object.values(STYLE_C_FAMILIES).flatMap((f) => Object.keys(f.kinds));
/** The six outpost pieces styles A and B draw (their own tables). */
const OUTPOST = Object.keys(STRUCTURE_STYLES.a.kinds);
const bytes = (f: Fields): Buffer[] => [f.albedo, f.height, f.emis, f.mat, f.key, f.cov].map((a) => Buffer.from(a.buffer));

describe('style registry', () => {
  it('ids are current + the table; unknown/absent parse to current', () => {
    expect(STRUCTURE_STYLE_IDS).toEqual(['current', ...Object.keys(STRUCTURE_STYLES)]);
    expect(parseStructureStyle('a')).toBe('a');
    expect(parseStructureStyle(null)).toBe('current');
    expect(parseStructureStyle('zzz')).toBe('current');
  });
  it('readStructStyle: style c by default; off / current = the old bakes', () => {
    expect(DEFAULT_STRUCT_STYLE).toBe('c');
    expect(readStructStyle('?art=machined&restyle=a')).toBe('a');
    expect(readStructStyle('')).toBe(DEFAULT_STRUCT_STYLE);
    expect(readStructStyle('?room=rig-home')).toBe(DEFAULT_STRUCT_STYLE);
    expect(readStructStyle('?restyle=zzz')).toBe(DEFAULT_STRUCT_STYLE);
    expect(readStructStyle('?restyle=current')).toBeUndefined();
    expect(readStructStyle('?restyle=off')).toBeUndefined();
  });
  it('style A restyles six outpost pieces, each also drawn by style C', () => {
    expect(OUTPOST).toHaveLength(6);
    for (const id of OUTPOST) expect(C_KINDS, id).toContain(id);
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
    for (const id of C_KINDS) {
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
      // The Ancients' gate is nobody's plating: no livery bands.
      if (id === 'alien_gate') expect(v.bands!.length, id).toBe(0);
      else expect(v.bands!.length, id).toBeGreaterThan(0);
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

describe('style C (shipyard brutalist, 1f)', () => {
  it('is registered, parses, and has a drawer for every kind in its family files', () => {
    expect(STRUCTURE_STYLE_IDS).toContain('c');
    expect(parseStructureStyle('c')).toBe('c');
    expect(readStructStyle('?restyle=c')).toBe('c');
    expect(Object.keys(STRUCTURE_STYLES.c.kinds).sort()).toEqual([...C_KINDS].sort());
    for (const id of C_KINDS) expect(typeof structureStyleDrawer('c', id), id).toBe('function');
  });
  it('bake key differs from today and from style A', () => {
    const job: BakeJob = { type: 'struct', id: 'capital', seed: 1, rot: 0 };
    expect(bakeKey({ ...job, style: 'c' })).toBe('m:capital:1::Sc');
    expect(bakeKey({ ...job, style: 'c' })).not.toBe(bakeKey(job));
    expect(bakeKey({ ...job, style: 'c' })).not.toBe(bakeKey({ ...job, style: 'a' }));
  });
  it('draws inside the art frame (the outline; a chamber its square), with livery bands, and differs from style A', () => {
    for (const id of C_KINDS) {
      const v = buildStructureVisual(id, { accent: 0x66ccaa, style: 'c', livery: true });
      const a = buildStructureVisual(id, { accent: 0x66ccaa, style: 'a', livery: true });
      expect(v.polys!.length, id).toBeGreaterThan(3);
      expect(v.rects, id).toEqual([]);
      expect(v.polys, id).not.toEqual(a.polys);
      const out = artFramePx(id, 'c');
      for (const p of v.polys!) for (const [x, y] of p.pts) expect(polyEdgeDist(out, x, y), `${id} ${x},${y}`).toBeGreaterThan(-0.5);
      for (const l of v.lights) expect(insidePoly(out, l.x, l.y), id).toBe(true);
      for (const s of v.sigils ?? []) expect(polyEdgeDist(out, s.x, s.y), id).toBeGreaterThan(s.r);
      // The Ancients' gate is nobody's plating: no livery bands.
      if (id === 'alien_gate') expect(v.bands!.length, id).toBe(0);
      else expect(v.bands!.length, id).toBeGreaterThan(0);
    }
    const cap = buildStructureVisual('capital', { accent: 0, style: 'c', livery: true }).sigils!;
    expect(cap.find((s) => s.screen === true)).toMatchObject({ x: 0, y: 0 });
  });
  it('connector hub: a hex core with one strut out to each of its six sockets', () => {
    const v = buildStructureVisual('connector', { accent: 0x66ccaa, style: 'c' });
    const socks = structureSockets('connector');
    expect(socks.length).toBe(6);
    // Struts: the 4-point strips whose centre line runs out along a socket
    // normal (Pixi frame: y flipped), one per socket.
    const struts = v.polys!.filter((p) => p.pts.length === 4 && p.mat === 'metal');
    const along = socks.map((s) => struts.filter((p) => {
      const mx = p.pts.reduce((a, q) => a + q[0], 0) / 4, my = p.pts.reduce((a, q) => a + q[1], 0) / 4;
      const r = Math.hypot(mx, my);
      return r > 15 && r < 27 && Math.abs(mx / r - s.nx) < 1e-6 && Math.abs(my / r + s.ny) < 1e-6;
    }).length);
    expect(along).toEqual([1, 1, 1, 1, 1, 1]);
    // The body is the flat-top hex outline (its deck is the outline itself).
    expect(v.polys![0]!.pts).toEqual(outlinePx('connector', 'c'));
    expect(v.polys![0]!.pts.length).toBe(6);
  });
  it('forge: bakes differently from today and from style A', () => {
    for (const id of C_KINDS) {
      const livery = { team: 0x3a7bff, sigil: 0xffd23a };
      const c = forgeStructure(id, { ppu: 0.5, seed: 1, style: 'c', livery });
      const a = forgeStructure(id, { ppu: 0.5, seed: 1, style: 'a', livery });
      const today = forgeStructure(id, { ppu: 0.5, seed: 1 });
      expect(Buffer.from(c.albedo.buffer).equals(Buffer.from(today.albedo.buffer)), id).toBe(false);
      expect(Buffer.from(c.albedo.buffer).equals(Buffer.from(a.albedo.buffer)), id).toBe(false);
      expect(c.mat.some((m) => m === MAT.WINDOW), id).toBe(true);
    }
  });
});

describe('style B (clustered modules)', () => {
  it('is registered, parses, and draws every outpost kind', () => {
    expect(STRUCTURE_STYLE_IDS).toContain('b');
    expect(parseStructureStyle('b')).toBe('b');
    expect(readStructStyle('?art=machined&restyle=b')).toBe('b');
    expect(Object.keys(STRUCTURE_STYLES.b.kinds).sort()).toEqual([...OUTPOST].sort());
    for (const id of OUTPOST) expect(structureStyleDrawer('b', id), id).toBeTypeOf('function');
  });
  it('bake key differs from today and from style A', () => {
    const job: BakeJob = { type: 'struct', id: 'capital', seed: 1, rot: 0 };
    const b = bakeKey({ ...job, style: 'b' });
    expect(b).toContain(':Sb');
    expect(b).not.toBe(bakeKey(job));
    expect(b).not.toBe(bakeKey({ ...job, style: 'a' }));
  });
  it('draws pods inside the kind outline, livery on, beacon screen biggest', () => {
    const screen = buildStructureVisual('capital', { accent: 0, style: 'b', livery: true }).sigils!.find((s) => s.screen === true)!;
    expect(screen).toMatchObject({ x: 0, y: 0 });
    for (const id of OUTPOST) {
      const v = buildStructureVisual(id, { accent: 0x66ccaa, style: 'b', livery: true });
      expect(v.polys!.length, id).toBeGreaterThan(5);
      expect(v.rects, id).toEqual([]);
      const out = outlinePx(id, 'b');
      for (const p of v.polys!) for (const [x, y] of p.pts) expect(polyEdgeDist(out, x, y), `${id} ${x},${y}`).toBeGreaterThan(-0.5);
      for (const l of v.lights) expect(insidePoly(out, l.x, l.y), id).toBe(true);
      for (const s of v.sigils!) expect(polyEdgeDist(out, s.x, s.y), id).toBeGreaterThan(s.r);
      for (const s of v.sigils!) if (!s.screen) expect(s.r, id).toBeLessThan(screen.r);
      expect(v.bands!.length, id).toBeGreaterThan(0);
    }
  });
  it('forge: differs from style A and today, has glow and coverage', () => {
    for (const id of OUTPOST) {
      const liv = { team: 0x3a7bff, sigil: 0xffd23a };
      const f = forgeStructure(id, { ppu: 0.5, seed: 1, style: 'b', livery: liv });
      const a = forgeStructure(id, { ppu: 0.5, seed: 1, style: 'a', livery: liv });
      expect(Buffer.from(f.albedo.buffer).equals(Buffer.from(a.albedo.buffer)), id).toBe(false);
      expect(f.mat.some((m) => m === MAT.WINDOW), id).toBe(true);
      expect(f.cov.some((c) => c > 0.5), id).toBe(true);
    }
  });
});
