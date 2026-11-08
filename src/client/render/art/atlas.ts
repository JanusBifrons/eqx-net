/**
 * Machined art — a skyline-packed texture atlas (see skyline.ts). Every baked frame goes into a
 * few large pages, so all sprites of a look share one texture source and
 * batch into one draw call per layer.
 *
 * Works in the render worker as well as on the main thread: pages are
 * `OffscreenCanvas` where available (the worker has no `document`), the same
 * pattern as `BeamSpritePool`.
 *
 * GPU memory is what a page COSTS, not what is placed on it: a page is
 * allocated whole (plus a third again for mipmaps), so `gpuBytes` counts page
 * capacity. Phones use smaller pages (2048²) than desktop (4096²).
 */
import { BufferImageSource, Rectangle, Texture } from 'pixi.js';
import type { Frame } from './shade.js';
import { Skyline } from './skyline.js';

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface Page {
  /** Which group the page belongs to (see `setGroup`). */
  group: number;
  /** Canvas pages (ordinary art); `null` on a data page. */
  canvas: AnyCanvas | null;
  ctx: AnyCtx | null;
  /** Data pages (GPU-lit maps): raw RGBA, uploaded as-is. */
  buf: Uint8Array | null;
  tex: Texture | null;
  /** Where the next frames can go (skyline packing). */
  sky: Skyline;
  dirty: boolean;
}

export interface AtlasOpts {
  /** Page side, texels. Default 4096. */
  pageSize?: number;
  /** Most pages this atlas may allocate (the GPU-memory budget). Default: no cap. */
  maxPages?: number;
  /**
   * Data pages: frames are copied byte for byte and uploaded without alpha
   * premultiplication. For GPU-lit maps (litMaps.ts), whose every channel is
   * data: a canvas premultiplies, which wipes the colour of any texel whose
   * alpha is 0 (cavity 0, material 0) and destroys the maps.
   */
  data?: boolean;
  /** A page budget shared with other atlases (overrides `maxPages`), so the
   *  ordinary and the lit atlas together stay within the device's memory. */
  budget?: PageBudget;
}

/** Pages in use across atlases, against one cap. */
export class PageBudget {
  used = 0;
  constructor(readonly max: number) {}
}

function makeCanvas(size: number): { canvas: AnyCanvas; ctx: AnyCtx } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(size, size);
    return { canvas, ctx: canvas.getContext('2d')! };
  }
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return { canvas, ctx: canvas.getContext('2d')! };
}

export class Atlas {
  private pages: Page[] = [];
  private pending: Array<{ page: Page; frame: Rectangle; out: Texture[]; idx: number }> = [];
  /** Bytes of texel data placed (not page capacity). */
  bytes = 0;
  readonly pageSize: number;
  readonly maxPages: number;
  private readonly data: boolean;
  private readonly budget: PageBudget;

  /** Mipmapped pages need a wider gutter, or small mips bleed between frames. */
  private readonly PAD: number;
  constructor(private readonly nearest: boolean, opts: AtlasOpts = {}) {
    this.PAD = nearest ? 1 : 8;
    this.pageSize = opts.pageSize ?? 4096;
    this.budget = opts.budget ?? new PageBudget(opts.maxPages ?? Infinity);
    this.maxPages = this.budget.max;
    this.data = opts.data === true;
  }

  private newPage(): Page {
    const sky = new Skyline(this.pageSize, this.PAD);
    let p: Page;
    if (this.data) {
      p = { group: this.group, canvas: null, ctx: null, buf: new Uint8Array(this.pageSize * this.pageSize * 4), tex: null, sky, dirty: true };
    } else {
      const { canvas, ctx } = makeCanvas(this.pageSize);
      p = { group: this.group, canvas, ctx, buf: null, tex: null, sky, dirty: true };
    }
    this.pages.push(p);
    this.budget.used++;
    return p;
  }

  /**
   * Pages are grouped (the art service uses one group per sector's sun, and
   * group 0 for effect textures that every sector shares). New frames go into
   * the current group's pages only, so a group's pages can be freed whole once
   * nothing draws its art (`freeGroup`).
   */
  private group = 0;
  setGroup(group: number): void { this.group = group; }

  /** Free every page (and stand-alone texture) of a group; its budget returns.
   *  The caller guarantees nothing draws them any more. */
  freeGroup(group: number): number {
    let freed = 0;
    for (let i = this.pages.length - 1; i >= 0; i--) {
      const p = this.pages[i]!;
      if (p.group !== group) continue;
      p.tex?.destroy(true);
      this.pages.splice(i, 1);
      this.budget.used--;
      freed++;
    }
    for (let i = this.singles.length - 1; i >= 0; i--) {
      if (this.singles[i]!.group !== group) continue;
      this.singles[i]!.tex.destroy(true);
      this.singles.splice(i, 1);
    }
    for (let i = this.pending.length - 1; i >= 0; i--) if (this.pending[i]!.page.group === group) this.pending.splice(i, 1);
    this.freedPages += freed;
    return freed;
  }
  /** Diagnostic: pages freed so far. */
  freedPages = 0;

  /** True when every frame fits without exceeding the page budget. Any page
   *  of the current group can take a frame (first fit), then new pages. */
  canFit(frames: readonly Frame[], reservePages = 0): boolean {
    const S = this.pageSize, P = this.PAD;
    const sims: Skyline[] = [];
    for (const p of this.pages) if (p.group === this.group) sims.push(p.sky.clone());
    let pages = this.budget.used;
    const maxPages = this.maxPages - reservePages;
    for (const f of frames) {
      if (f.w + P * 2 > S || f.h + P * 2 > S) return false;
      let ok = false;
      for (const k of sims) if (k.place(f.w, f.h)) { ok = true; break; }
      if (ok) continue;
      if (pages >= maxPages) return false;
      pages++;
      const k = new Skyline(S, P);
      k.place(f.w, f.h);
      sims.push(k);
    }
    return true;
  }

  /** Place a frame; its Texture lands in `out[idx]` after `commit()`.
   *  Returns false (and places nothing) when it doesn't fit the budget. */
  add(fr: Frame, out: Texture[], idx: number): boolean {
    const S = this.pageSize, P = this.PAD;
    if (fr.w + P * 2 > S || fr.h + P * 2 > S) return false;
    let p: Page | null = null;
    let at: { x: number; y: number } | null = null;
    for (const q of this.pages) {
      if (q.group !== this.group) continue;
      at = q.sky.place(fr.w, fr.h);
      if (at) { p = q; break; }
    }
    if (!p) {
      if (this.budget.used >= this.maxPages) return false;
      p = this.newPage();
      at = p.sky.place(fr.w, fr.h);
      if (!at) return false;
    }
    if (p.buf) {
      const S4 = S * 4, row = fr.w * 4;
      for (let y = 0; y < fr.h; y++) p.buf.set(fr.data.subarray(y * row, y * row + row), (at!.y + y) * S4 + at!.x * 4);
    } else {
      p.ctx!.putImageData(new ImageData(fr.data as unknown as Uint8ClampedArray<ArrayBuffer>, fr.w, fr.h), at!.x, at!.y);
    }
    this.pending.push({ page: p, frame: new Rectangle(at!.x, at!.y, fr.w, fr.h), out, idx });
    p.dirty = true;
    this.bytes += fr.w * fr.h * 4;
    return true;
  }

  /** Upload dirty pages and resolve every pending frame to a Texture. */
  commit(): void {
    for (const p of this.pages) {
      if (!p.dirty) continue;
      if (!p.tex && p.buf) {
        p.tex = new Texture({ source: new BufferImageSource({
          resource: p.buf, width: this.pageSize, height: this.pageSize,
          alphaMode: 'no-premultiply-alpha', scaleMode: 'linear', autoGenerateMipmaps: true,
        }) });
      } else if (!p.tex) {
        p.tex = Texture.from(p.canvas as HTMLCanvasElement);
        p.tex.source.scaleMode = this.nearest ? 'nearest' : 'linear';
        if (!this.nearest) { p.tex.source.autoGenerateMipmaps = true; }
      } else {
        p.tex.source.update();
      }
      this.uploads++;
      this.uploadTexels += this.pageSize * this.pageSize;
      p.dirty = false;
    }
    for (const q of this.pending) q.out[q.idx] = new Texture({ source: q.page.tex!.source, frame: q.frame });
    this.pending.length = 0;
  }

  private readonly singles: Array<{ tex: Texture; bytes: number; group: number }> = [];

  /**
   * A texture of its own, outside the pages: for textures that wrap (drawn as
   * a TilingSprite), which an atlas slot can't do. Counted in `gpuBytes`.
   */
  standalone(fr: Frame, repeat: boolean, mip: boolean): Texture {
    if (this.data) {
      // Lit maps: raw bytes, no premultiplication (capital tiles, own ship).
      const tex = new Texture({ source: new BufferImageSource({
        resource: new Uint8Array(fr.data.buffer, fr.data.byteOffset, fr.data.byteLength).slice(), width: fr.w, height: fr.h,
        alphaMode: 'no-premultiply-alpha', scaleMode: 'linear', autoGenerateMipmaps: mip,
        ...(repeat ? { addressMode: 'repeat' as const } : {}),
      }) });
      const bytes = fr.w * fr.h * 4;
      this.singles.push({ tex, bytes: mip ? Math.round((bytes * 4) / 3) : bytes, group: this.group });
      return tex;
    }
    const { canvas, ctx } = makeCanvas(Math.max(fr.w, fr.h));
    if (canvas.width !== fr.w || canvas.height !== fr.h) { canvas.width = fr.w; canvas.height = fr.h; }
    ctx.putImageData(new ImageData(fr.data as unknown as Uint8ClampedArray<ArrayBuffer>, fr.w, fr.h), 0, 0);
    const tex = Texture.from(canvas as HTMLCanvasElement);
    tex.source.scaleMode = 'linear';
    if (repeat) tex.source.addressMode = 'repeat';
    if (mip) tex.source.autoGenerateMipmaps = true;
    const bytes = fr.w * fr.h * 4;
    this.singles.push({ tex, bytes: mip ? Math.round((bytes * 4) / 3) : bytes, group: this.group });
    return tex;
  }

  get pageCount(): number { return this.pages.length; }
  get maxPageCount(): number { return this.maxPages; }
  /** Diagnostic: page (re)uploads so far, and the texels they sent. */
  uploads = 0;
  uploadTexels = 0;

  /** GPU memory the pages cost: whole pages, RGBA, plus a third for mipmaps. */
  get gpuBytes(): number {
    let singles = 0;
    for (const s of this.singles) singles += s.bytes;
    return atlasGpuBytes(this.pages.length, this.pageSize, !this.nearest) + singles;
  }

  /** The raw bytes of a data page (tests). */
  pageData(i: number): Uint8Array | null { return this.pages[i]?.buf ?? null; }

  destroy(): void {
    this.budget.used -= this.pages.length;
    for (const p of this.pages) p.tex?.destroy(true);
    for (const s of this.singles) s.tex.destroy(true);
    this.singles.length = 0;
    this.pages.length = 0;
    this.pending.length = 0;
    this.bytes = 0;
  }
}

/** GPU bytes for `pages` square pages of side `size` (RGBA8, optional mips). */
export function atlasGpuBytes(pages: number, size: number, mipmaps: boolean): number {
  const base = pages * size * size * 4;
  return mipmaps ? Math.round((base * 4) / 3) : base;
}
