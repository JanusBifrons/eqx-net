/**
 * ArtService (plan iridescent-seeking-rainbow, A2): the renderer's Machined
 * art service. Fakes stand in for the atlas (needs a canvas), the worker pool
 * and IndexedDB, so the scheduling rules are tested in node.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Texture } from 'pixi.js';
import { ArtService, InlineBakeRunner, type ArtPacker, type BakeCache, type BakeRunner } from '../../src/client/render/art/ArtService';
import { Atlas, atlasGpuBytes } from '../../src/client/render/art/atlas';
import { bakeKey, quarterTurns, runBake, type Baked, type BakeJob } from '../../src/client/render/art/bake';
import { loadArtPreference, readArtDelayMs, readArtMode, resolveArtMode, saveArtPreference } from '../../src/client/render/art/artMode';
import { sunRigForSector } from '../../src/client/render/art/sunRig';
import { DEFAULT_RIG, type Frame, type LightRig } from '../../src/client/render/art/shade';

const frame = (w = 8, h = 8): Frame => ({ w, h, data: new Uint8ClampedArray(w * h * 4) });
const baked = (n: number): Baked => ({ frames: Array.from({ length: n }, () => frame()), w: 8, h: 8, density: 2, nozzles: [], navLights: [] });

class FakePacker implements ArtPacker {
  placed = 0;
  commits = 0;
  private out: Array<[Texture[], number]> = [];
  constructor(private readonly capacity = Infinity) {}
  canFit(frames: readonly Frame[]): boolean { return this.placed + frames.length <= this.capacity; }
  add(_fr: Frame, out: Texture[], idx: number): boolean { this.placed++; this.out.push([out, idx]); return true; }
  commit(): void { this.commits++; for (const [o, i] of this.out) o[i] = { fake: i } as unknown as Texture; this.out.length = 0; }
  get pageCount(): number { return Math.ceil(this.placed / 10); }
  get gpuBytes(): number { return this.pageCount * 100; }
  destroy(): void { /* nothing */ }
}

class FakeRunner implements BakeRunner {
  calls: BakeJob[] = [];
  rigs: LightRig[] = [];
  readonly workers = 2;
  run(job: BakeJob, rig: LightRig): Promise<Baked> {
    this.calls.push(job); this.rigs.push(rig);
    return Promise.resolve(baked(job.type === 'ship' ? 16 : 2));
  }
  destroy(): void { /* nothing */ }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function make(opts: { packer?: FakePacker; cache?: BakeCache | null; budget?: number; clockStep?: number } = {}) {
  const packer = opts.packer ?? new FakePacker();
  const runner = new FakeRunner();
  let t = 0;
  const svc = new ArtService({
    packer, runner, cache: opts.cache ?? null, packBudgetMs: opts.budget ?? 1000,
    now: () => { t += opts.clockStep ?? 0; return t; },
  });
  return { svc, packer, runner };
}

describe('ArtService', () => {
  it('hands out one handle per distinct job and bakes it once', async () => {
    const { svc, runner } = make();
    const a = svc.ship('fighter'), b = svc.ship('fighter'), c = svc.ship('fighter', 0x3366ff);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    await flush();
    expect(runner.calls).toHaveLength(2);
  });

  it('stays pending until a tick packs it, then exposes the textures', async () => {
    const { svc, packer } = make();
    const h = svc.ship('heavy');
    await flush();
    expect(h.state).toBe('pending');
    expect(h.ship).toBeNull();
    svc.tick();
    expect(h.state).toBe('ready');
    expect(h.ship!.frames).toHaveLength(16);
    expect(h.ship!.frames.every((t) => t !== undefined)).toBe(true);
    expect(packer.commits).toBe(1);
  });

  it('packs within the per-frame time budget, at least one bake per tick', async () => {
    // Every now() call advances the clock 2 ms; budget 3 ms.
    const { svc } = make({ budget: 3, clockStep: 2 });
    const hs = ['fighter', 'heavy', 'scout', 'gunship', 'interceptor'].map((id) => svc.ship(id));
    await flush();
    svc.tick();
    const after1 = hs.filter((h) => h.state === 'ready').length;
    expect(after1).toBeGreaterThanOrEqual(1);
    expect(after1).toBeLessThan(hs.length);
    for (let i = 0; i < 10; i++) svc.tick();
    expect(hs.every((h) => h.state === 'ready')).toBe(true);
  });

  it('serves the cache without baking, and saves fresh bakes after packing', async () => {
    const save = vi.fn((_: Array<[string, Baked]>) => Promise.resolve());
    const cache: BakeCache = {
      load: (keys) => Promise.resolve(new Map(keys.filter((k) => k.includes('m:fighter:')).map((k) => [k, baked(16)] as [string, Baked]))),
      save,
    };
    const { svc, runner } = make({ cache });
    const hit = svc.ship('fighter'), miss = svc.ship('heavy');
    await flush(); await flush();
    svc.tick();
    expect(hit.state).toBe('ready');
    expect(miss.state).toBe('ready');
    expect(runner.calls.map((j) => j.id)).toEqual(['heavy']);
    expect(svc.stats().fromCache).toBe(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0].map(([k]) => k.includes('m:heavy:'))).toEqual([true]);
  });

  it('fails a bake that would exceed the texture budget (the sprite keeps today\'s look)', async () => {
    const { svc } = make({ packer: new FakePacker(16) });
    const a = svc.ship('fighter'), b = svc.ship('heavy');
    await flush();
    svc.tick();
    expect(a.state).toBe('ready');
    expect(b.state).toBe('failed');
    expect(b.reason).toMatch(/budget/);
    expect(svc.stats()).toMatchObject({ ready: 1, failed: 1, pending: 0 });
  });

  it('lights new requests with the current sector\'s sun', async () => {
    const { svc, runner } = make();
    svc.setSector('sol-prime');
    const a = svc.ship('fighter');
    svc.setSector('vega-reach');
    const b = svc.ship('fighter');
    expect(b).not.toBe(a);
    await flush();
    expect(runner.rigs[0]!.sunAz).toBeCloseTo(sunRigForSector('sol-prime').sunAz);
    expect(runner.rigs[1]!.sunAz).toBeCloseTo(sunRigForSector('vega-reach').sunAz);
  });

  it('shares structure seeds across a few variants', () => {
    const { svc } = make();
    const seen = new Set([1, 2, 3, 4, 5, 6, 7].map((s) => svc.struct('turret', s)));
    expect(seen.size).toBe(3);
  });

  it('the inline fallback produces a real bake', async () => {
    const r = new InlineBakeRunner();
    const b = await r.run({ type: 'ship', id: 'scout' }, DEFAULT_RIG);
    expect(b.frames).toHaveLength(16);
    expect(b.frames[0]!.data.some((v) => v > 0)).toBe(true);
  });
});

describe('structure bakes follow the quarter turn', () => {
  it('a turned structure is lit as if the sun moved the other way', () => {
    const turned = runBake({ type: 'struct', id: 'connector', seed: 1, rot: Math.PI / 2 }, DEFAULT_RIG);
    const sunMoved = runBake({ type: 'struct', id: 'connector', seed: 1 }, { ...DEFAULT_RIG, sunAz: DEFAULT_RIG.sunAz - Math.PI / 2 });
    expect(Buffer.from(turned.frames[0]!.data).equals(Buffer.from(sunMoved.frames[0]!.data))).toBe(true);
  });

  it('quarterTurns snaps and wraps', () => {
    expect([0, Math.PI / 2, Math.PI, -Math.PI / 2, 2 * Math.PI, 0.1].map(quarterTurns)).toEqual([0, 1, 2, 3, 0, 0]);
    expect(bakeKey({ type: 'struct', id: 'x', seed: 1, rot: Math.PI })).not.toBe(bakeKey({ type: 'struct', id: 'x', seed: 1 }));
  });
});

describe('atlas budget', () => {
  it('counts whole pages (plus mipmaps), not the pixels placed', () => {
    expect(atlasGpuBytes(1, 2048, true)).toBe(Math.round((2048 * 2048 * 4 * 4) / 3));
    expect(atlasGpuBytes(2, 4096, false)).toBe(2 * 4096 * 4096 * 4);
  });

  it('refuses frames that need more pages than the budget', () => {
    const a = new Atlas(false, { pageSize: 2048, maxPages: 1 });
    expect(a.canFit([frame(1000, 1000)])).toBe(true);
    // Two 1000² frames per row, two rows: four fit on one 2048² page, five don't.
    expect(a.canFit(Array.from({ length: 4 }, () => frame(1000, 1000)))).toBe(true);
    expect(a.canFit(Array.from({ length: 5 }, () => frame(1000, 1000)))).toBe(false);
    expect(a.canFit([frame(3000, 10)])).toBe(false);
  });
});

describe('art mode and sun', () => {
  it('reads ?art=', () => {
    expect(readArtMode('')).toBeNull();
    expect(readArtMode('?art=machined')).toBe('machined');
    expect(readArtMode('?worker=0&art=classic')).toBe('classic');
    expect(readArtDelayMs('?artDelayMs=750')).toBe(750);
    expect(readArtDelayMs('')).toBe(0);
  });

  it('resolves the look: URL, then the saved choice, then classic under automation, else Machined', () => {
    expect(resolveArtMode('', false, null)).toBe('machined'); // players
    expect(resolveArtMode('', true, null)).toBe('classic'); // automated browsers
    expect(resolveArtMode('', false, 'classic')).toBe('classic'); // the player turned it off
    expect(resolveArtMode('', true, 'machined')).toBe('machined');
    expect(resolveArtMode('?art=machined', true, 'classic')).toBe('machined'); // URL wins
    expect(resolveArtMode('?art=classic', false, 'machined')).toBe('classic');
  });

  it("saves the player's choice per device, and survives broken storage", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
    expect(loadArtPreference(store)).toBeNull();
    saveArtPreference('classic', store);
    expect(loadArtPreference(store)).toBe('classic');
    mem.set('eqxArtStyle', 'nonsense');
    expect(loadArtPreference(store)).toBeNull();
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadArtPreference(broken)).toBeNull();
    expect(() => saveArtPreference('machined', broken)).not.toThrow();
  });

  it('gives each sector a stable sun from above the screen', () => {
    expect(sunRigForSector(null)).toBe(DEFAULT_RIG);
    const a = sunRigForSector('sol-prime');
    expect(sunRigForSector('sol-prime').sunAz).toBe(a.sunAz);
    for (const k of ['sol-prime', 'vega-reach', 'cinderpath', 'emerald-span', 'verdance']) {
      const az = sunRigForSector(k).sunAz;
      expect(az).toBeGreaterThanOrEqual((-150 / 180) * Math.PI - 1e-9);
      expect(az).toBeLessThanOrEqual((-30 / 180) * Math.PI + 1e-9);
    }
  });
});
