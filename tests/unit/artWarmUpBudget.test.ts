/**
 * Speculative warm-up bakes must never take the texture space that art on
 * screen needs. Phone report 2026-11-07 (sector trip): "the ship isn't
 * textured, both ends". On a phone the budget is 6 atlas pages; the warm-up
 * (every small ship kind at 2x scale + 18 structures) filled it, so the
 * pilot's own ship failed "over the texture memory budget" and drew bare.
 */
import { describe, expect, it } from 'vitest';
import { Rectangle, Texture } from 'pixi.js';
import { ArtService, type ArtPacker, type BakeRunner } from '../../src/client/render/art/ArtService';
import type { Baked, BakeJob } from '../../src/client/render/art/bake';
import type { Frame, LightRig } from '../../src/client/render/art/shade';

const SHEET = new Texture({ source: Texture.WHITE.source, frame: new Rectangle(0, 0, 1, 1) });

/** One "page" per frame; at most `max` pages, keeping `reserve` free when asked. */
class BudgetPacker implements ArtPacker {
  used = 0;
  private out: Array<[Texture[], number]> = [];
  constructor(private readonly max: number) {}
  canFit(frames: readonly Frame[], reservePages = 0): boolean { return this.used + frames.length <= this.max - reservePages; }
  add(_fr: Frame, out: Texture[], idx: number): boolean { this.used++; this.out.push([out, idx]); return true; }
  commit(): void { for (const [o, i] of this.out) o[i] = SHEET; this.out.length = 0; }
  standalone(): Texture { return SHEET; }
  get pageCount(): number { return this.used; }
  get maxPageCount(): number { return this.max; }
  get gpuBytes(): number { return 0; }
  destroy(): void { /* nothing */ }
}

class OneFrameRunner implements BakeRunner {
  readonly workers = 1;
  run(_job: BakeJob, _rig: LightRig): Promise<Baked> {
    const f: Frame = { w: 4, h: 4, data: new Uint8ClampedArray(64) };
    return Promise.resolve({ frames: [f], w: 4, h: 4, density: 1, nozzles: [], navLights: [] });
  }
  destroy(): void { /* nothing */ }
}

const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

describe('warm-up never starves on-screen art', () => {
  it("a warm-up bigger than the budget still leaves room for the pilot's own ship", async () => {
    const packer = new BudgetPacker(6);
    const svc = new ArtService({ packer, runner: new OneFrameRunner(), cache: null, packBudgetMs: 1000, now: () => 0 });
    const warm: BakeJob[] = [];
    for (let i = 0; i < 20; i++) warm.push({ type: 'ship', id: `warm-${i}` });
    svc.warmUp(warm);
    await flush(); svc.tick?.(); await flush(); svc.tick?.();
    const mine = svc.ship('fighter');
    await flush(); svc.tick?.(); await flush(); svc.tick?.();
    expect(mine.state).toBe('ready');
  });

  it('a warm bake skipped for space is not marked failed (asking for it later still works)', async () => {
    const packer = new BudgetPacker(4);
    const svc = new ArtService({ packer, runner: new OneFrameRunner(), cache: null, packBudgetMs: 1000, now: () => 0 });
    const warm: BakeJob[] = [];
    for (let i = 0; i < 10; i++) warm.push({ type: 'ship', id: `w${i}` });
    svc.warmUp(warm);
    await flush(); svc.tick?.(); await flush(); svc.tick?.();
    expect(svc.stats().failed).toBe(0);
  });

  it("the pilot's own ship is textured even when on-screen art has filled the budget", async () => {
    const packer = new BudgetPacker(1);
    const svc = new ArtService({ packer, runner: new OneFrameRunner(), cache: null, packBudgetMs: 1000, now: () => 0 });
    svc.ship('someone-else');
    await flush(); svc.tick?.(); await flush(); svc.tick?.();
    expect(packer.used).toBe(1); // budget full
    const mine = svc.ship('fighter');
    svc.prioritize(mine);
    await flush(); svc.tick?.(); await flush(); svc.tick?.();
    expect(mine.state).toBe('ready');
  });
});
