/**
 * New effects in the art pipeline (plan iridescent-seeking-rainbow v3, B1):
 * effect textures are `fx` bake jobs, cached and packed like ship art.
 * Wrapping textures get their own texture, the rest share the atlas, and a
 * flipbook sheet is cut into its cells.
 */
import { describe, expect, it } from 'vitest';
import { Rectangle, Texture } from 'pixi.js';
import { ArtService, flipCells, type ArtPacker, type BakeRunner } from '../../src/client/render/art/ArtService';
import { bakeKey, runBake, type Baked, type BakeJob } from '../../src/client/render/art/bake';
import { resolveFxMode } from '../../src/client/render/art/artMode';
import { FX_SPECS, FX_VERSION, FX_WARM } from '../../src/client/render/art/fx/fxTextures';
import { DEFAULT_RIG, type Frame, type LightRig } from '../../src/client/render/art/shade';

const SHEET = new Texture({ source: Texture.WHITE.source, frame: new Rectangle(0, 0, 1, 1) });

class FakePacker implements ArtPacker {
  added = 0;
  singles: Array<{ repeat: boolean; mip: boolean }> = [];
  private out: Array<[Texture[], number]> = [];
  canFit(): boolean { return true; }
  add(_fr: Frame, out: Texture[], idx: number): boolean { this.added++; this.out.push([out, idx]); return true; }
  commit(): void { for (const [o, i] of this.out) o[i] = SHEET; this.out.length = 0; }
  standalone(_fr: Frame, repeat: boolean, mip: boolean): Texture { this.singles.push({ repeat, mip }); return SHEET; }
  get pageCount(): number { return 1; }
  get gpuBytes(): number { return 0; }
  destroy(): void { /* nothing */ }
}

/** Runs the real fx bake inline (small and fast enough for a unit test). */
class FxRunner implements BakeRunner {
  readonly workers = 1;
  calls: BakeJob[] = [];
  run(job: BakeJob, rig: LightRig): Promise<Baked> {
    this.calls.push(job);
    const f: Frame = { w: 4, h: 4, data: new Uint8ClampedArray(64) };
    return Promise.resolve(job.type === 'fx' ? { frames: [f], w: 4, h: 4, density: 1, nozzles: [], navLights: [] } : runBake(job, rig));
  }
  destroy(): void { /* nothing */ }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const make = () => {
  const packer = new FakePacker();
  const runner = new FxRunner();
  const svc = new ArtService({ packer, runner, cache: null, packBudgetMs: 1000, now: () => 0 });
  return { svc, packer, runner };
};

describe('fx bake jobs', () => {
  it('key on FX_VERSION, so a generator change never serves stale textures', () => {
    expect(bakeKey({ type: 'fx', id: 'glow' })).toContain(FX_VERSION);
    expect(bakeKey({ type: 'fx', id: 'nebula', variant: 'dark', seed: 3 })).not.toBe(bakeKey({ type: 'fx', id: 'nebula', variant: 'dark', seed: 4 }));
  });

  it('runBake makes the texture (and rejects an unknown id)', () => {
    const b = runBake({ type: 'fx', id: 'spark' }, DEFAULT_RIG);
    expect(b.frames).toHaveLength(1);
    expect(b.frames[0]!.w).toBe(32);
    expect(() => runBake({ type: 'fx', id: 'nope' }, DEFAULT_RIG)).toThrow();
  });

  it('every warm-up texture has a spec', () => {
    for (const id of FX_WARM) expect(FX_SPECS[id]).toBeDefined();
  });
});

describe('ArtService.fx', () => {
  it('a wrapping texture gets its own repeat texture; a sprite texture goes in the atlas', async () => {
    const { svc, packer } = make();
    const stars = svc.fx('starsFar'), glow = svc.fx('glow');
    await flush();
    svc.tick();
    expect(stars.state).toBe('ready');
    expect(glow.state).toBe('ready');
    expect(packer.singles).toEqual([{ repeat: true, mip: true }]);
    expect(packer.added).toBe(1);
    expect(stars.fx!.frames).toHaveLength(1);
  });

  it('a flipbook sheet is cut into its cells', async () => {
    const { svc } = make();
    const fire = svc.fx('fireball');
    await flush();
    svc.tick();
    expect(fire.fx!.frames).toHaveLength(FX_SPECS.fireball.flip!.frames);
  });

  it('stats count effect textures separately', async () => {
    const { svc } = make();
    svc.fx('ring'); svc.fx('trail');
    expect(svc.stats().fxPending).toBe(2);
    await flush();
    svc.tick();
    expect(svc.stats()).toMatchObject({ fxReady: 2, fxPending: 0 });
  });

  it('the warm-up bakes the effects first when the new effects are on, and not at all when off', async () => {
    const { warmUpJobs } = await import('../../src/client/render/art/warmUp');
    expect(warmUpJobs(false).some((j) => j.type === 'fx')).toBe(false);
    const on = warmUpJobs(true);
    expect(on.slice(0, FX_WARM.length).map((j) => j.id)).toEqual([...FX_WARM]);
  });
});

describe('flipCells', () => {
  it('cuts cells left to right, top to bottom, offset by the sheet frame', () => {
    const sheet = new Texture({ source: Texture.WHITE.source, frame: new Rectangle(0, 0, 1, 1) });
    // Pretend the sheet sits at (100, 50) on a big page.
    Object.defineProperty(sheet, 'frame', { value: new Rectangle(100, 50, 512, 512) });
    const cells = flipCells(sheet, { frames: 6, cols: 4, cell: 128 });
    expect(cells).toHaveLength(6);
    expect([cells[0]!.frame.x, cells[0]!.frame.y]).toEqual([100, 50]);
    expect([cells[5]!.frame.x, cells[5]!.frame.y]).toEqual([228, 178]);
  });
});

describe('the ?fx= switch', () => {
  it('is off by default, on with ?fx=new, and needs the Machined art service', () => {
    expect(resolveFxMode('', 'machined')).toBe(false);
    expect(resolveFxMode('?fx=new', 'machined')).toBe(true);
    expect(resolveFxMode('?a=1&fx=classic', 'machined')).toBe(false);
    expect(resolveFxMode('?fx=new', 'classic')).toBe(false);
  });
});

