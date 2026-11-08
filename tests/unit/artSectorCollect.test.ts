/**
 * After a sector trip the old sector's art must give its texture space back.
 * Phone report 2026-11-07 (sector trip, perf lab): ~67 art bakes failed "over
 * the texture memory budget" in base-heavy sectors, because each sector's
 * lit art (a different sun) stayed in the few phone atlas pages for good.
 * `ArtService.collect` frees older sectors' pages once nothing draws them.
 */
import { describe, expect, it } from 'vitest';
import { Rectangle, Texture } from 'pixi.js';
import { ArtService, type ArtPacker, type BakeRunner } from '../../src/client/render/art/ArtService';
import type { Baked, BakeJob } from '../../src/client/render/art/bake';
import type { Frame, LightRig } from '../../src/client/render/art/shade';

const SHEET = new Texture({ source: Texture.WHITE.source, frame: new Rectangle(0, 0, 1, 1) });

/** One "page" per frame, tracked per group, at most `max` pages. */
class GroupPacker implements ArtPacker {
  private group = 0;
  private readonly byGroup = new Map<number, number>();
  private out: Array<[Texture[], number]> = [];
  constructor(private readonly max: number) {}
  get used(): number { let n = 0; for (const v of this.byGroup.values()) n += v; return n; }
  setGroup(g: number): void { this.group = g; }
  freeGroup(g: number): number { const n = this.byGroup.get(g) ?? 0; this.byGroup.delete(g); return n; }
  canFit(frames: readonly Frame[], reservePages = 0): boolean { return this.used + frames.length <= this.max - reservePages; }
  add(_fr: Frame, out: Texture[], idx: number): boolean {
    this.byGroup.set(this.group, (this.byGroup.get(this.group) ?? 0) + 1);
    this.out.push([out, idx]);
    return true;
  }
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
const settle = async (svc: ArtService): Promise<void> => { await flush(); svc.tick?.(); await flush(); svc.tick?.(); };

function newService(packer: GroupPacker): ArtService {
  const svc = new ArtService({ packer, runner: new OneFrameRunner(), cache: null, packBudgetMs: 1000, now: () => 0 });
  svc.setSector('sol-prime');
  return svc;
}

describe('a sector trip frees the old sector art', () => {
  it("frees the old sector's pages once nothing draws them, so the new sector's art fits", async () => {
    const packer = new GroupPacker(4);
    const svc = newService(packer);
    const old = ['a', 'b', 'c', 'd'].map((id) => svc.ship(id));
    await settle(svc);
    expect(old.every((h) => h.state === 'ready')).toBe(true);
    expect(packer.used).toBe(4); // budget full of Sol Prime art

    svc.setSector('vega-reach');
    svc.collect(new Set());
    expect(packer.used).toBe(0);
    const next = svc.ship('a');
    await settle(svc);
    expect(next.state).toBe('ready');
    expect(next).not.toBe(old[0]); // re-lit for the new sun
  });

  it('keeps art a sprite still holds or still shows', async () => {
    const packer = new GroupPacker(4);
    const svc = newService(packer);
    const held = svc.ship('held');
    const shownH = svc.ship('shown');
    await settle(svc);
    svc.setSector('vega-reach');
    // Held by a handle: the whole old group stays.
    svc.collect(new Set([held]));
    expect(packer.used).toBe(2);
    // Only displayed by a sprite (its new handle is still baking): still kept.
    svc.collect(new Set(), new Set<object>([shownH.ship!]));
    expect(packer.used).toBe(2);
    // Nothing holds or shows it: freed.
    svc.collect(new Set(), new Set());
    expect(packer.used).toBe(0);
  });

  it('never frees the current sector or the shared effect textures', async () => {
    const packer = new GroupPacker(4);
    const svc = newService(packer);
    svc.fx('glow', undefined, undefined, false);
    svc.ship('here');
    await settle(svc);
    const before = packer.used;
    svc.collect(new Set());
    expect(packer.used).toBe(before); // current sector + fx stay
    svc.setSector('vega-reach');
    svc.collect(new Set());
    expect(packer.used).toBe(before - 1); // only the old ship went
  });

  it('a new visit with the same sun: still-used art moves to fresh pages, then the old pages go', async () => {
    const packer = new GroupPacker(4);
    const svc = newService(packer);
    const mine = svc.ship('mine');
    for (const id of ['x', 'y', 'z']) svc.ship(id);
    await settle(svc);
    expect(packer.used).toBe(4); // full

    svc.newVisit(); // same sector lighting, new visit
    // The pilot's ship is still drawn: its art is re-packed into the new visit.
    svc.collect(new Set([mine]), new Set<object>([mine.ship!]));
    expect(mine.stale).toBe(true);
    expect(packer.used).toBe(4); // nothing freed yet (it is still shown)
    // Budget full, so the replacement can't fit until the old pages go: the
    // sprite still shows the old copy meanwhile.
    await settle(svc);
    // The others aren't drawn any more; once only the old copy of "mine" is
    // shown, its group stays; when the sprite drops it, everything old goes.
    svc.collect(new Set(), new Set());
    expect(packer.used).toBe(0);
    const again = svc.ship('mine');
    await settle(svc);
    expect(again.state).toBe('ready');
  });

  it('art that failed for space is asked for again after pages are freed', async () => {
    const packer = new GroupPacker(2);
    const svc = newService(packer);
    svc.ship('a'); svc.ship('b');
    await settle(svc);
    svc.newVisit();
    const late = svc.ship('c');
    await settle(svc);
    expect(late.state).toBe('failed');
    svc.collect(new Set([late]));
    expect(late.stale).toBe(true); // the sprite's helper re-acquires it
    const retry = svc.ship('c');
    await settle(svc);
    expect(retry.state).toBe('ready');
  });

  it("a re-packed copy that can't fit leaves the original in place (no art lost)", async () => {
    const packer = new GroupPacker(2);
    const svc = newService(packer);
    const a = svc.ship('a');
    const b = svc.ship('b');
    await settle(svc);
    svc.newVisit();
    svc.collect(new Set([a, b]), new Set<object>([a.ship!, b.ship!])); // full: re-home both
    expect(a.stale).toBe(true);
    await settle(svc); // the copies don't fit
    expect(a.stale).toBe(false);
    expect(svc.ship('a')).toBe(a); // the original serves again, still ready
    expect(a.state).toBe('ready');
    expect(packer.used).toBe(2);
  });

  it("with room to spare, the pilot's ship moves to the new visit and the old sector is freed", async () => {
    // Phone run 2026-11-07: 14 pages, 0 freed, asteroids bare. The pilot's
    // own ship (still drawn) pinned Sol Prime's pages for the whole trip.
    const packer = new GroupPacker(14);
    const svc = newService(packer);
    const mine = svc.ship('mine');
    for (const id of ['base1', 'base2', 'base3', 'drone']) svc.ship(id);
    await settle(svc);
    expect(packer.used).toBe(5);
    svc.newVisit(); // flew to another sector
    svc.collect(new Set([mine]), new Set<object>([mine.ship!]));
    expect(mine.next).toBeDefined(); // moving, though the budget isn't tight
    await settle(svc);
    const moved = mine.next!;
    expect(moved.state).toBe('ready');
    // The sprite now draws the moved copy: Sol Prime's pages go.
    svc.collect(new Set([moved]), new Set<object>([moved.ship!]));
    expect(packer.used).toBe(1);
  });

});
