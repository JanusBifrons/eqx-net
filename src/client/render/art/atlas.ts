/**
 * Machined art — a shelf-packed texture atlas. Every baked frame goes into a
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
import { Rectangle, Texture } from 'pixi.js';
import type { Frame } from './shade.js';

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface Page {
  canvas: AnyCanvas;
  ctx: AnyCtx;
  tex: Texture | null;
  x: number;
  y: number;
  rowH: number;
  dirty: boolean;
}

export interface AtlasOpts {
  /** Page side, texels. Default 4096. */
  pageSize?: number;
  /** Most pages this atlas may allocate (the GPU-memory budget). Default: no cap. */
  maxPages?: number;
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

  /** Mipmapped pages need a wider gutter, or small mips bleed between frames. */
  private readonly PAD: number;
  constructor(private readonly nearest: boolean, opts: AtlasOpts = {}) {
    this.PAD = nearest ? 1 : 8;
    this.pageSize = opts.pageSize ?? 4096;
    this.maxPages = opts.maxPages ?? Infinity;
  }

  private newPage(): Page {
    const { canvas, ctx } = makeCanvas(this.pageSize);
    const p: Page = { canvas, ctx, tex: null, x: this.PAD, y: this.PAD, rowH: 0, dirty: true };
    this.pages.push(p);
    return p;
  }

  /** Where a frame of this size would go: the current page, a new page, or
   *  nowhere (too big, or the page budget is spent). */
  private slotFor(w: number, h: number): { page: Page | null; newPage: boolean; wrap: boolean } | null {
    const S = this.pageSize, P = this.PAD;
    if (w + P * 2 > S || h + P * 2 > S) return null;
    const p = this.pages[this.pages.length - 1];
    if (p) {
      if (p.x + w + P <= S && p.y + h + P <= S) return { page: p, newPage: false, wrap: false };
      if (p.y + p.rowH + P + h + P <= S && P + w + P <= S) return { page: p, newPage: false, wrap: true };
    }
    if (this.pages.length >= this.maxPages) return null;
    return { page: null, newPage: true, wrap: false };
  }

  /** True when every frame fits without exceeding the page budget. */
  canFit(frames: readonly Frame[]): boolean {
    // Simulate the shelf placement without touching the pages.
    const S = this.pageSize, P = this.PAD;
    let pages = this.pages.length;
    const last = this.pages[this.pages.length - 1];
    let x = last ? last.x : S, y = last ? last.y : S, rowH = last ? last.rowH : 0;
    for (const f of frames) {
      if (f.w + P * 2 > S || f.h + P * 2 > S) return false;
      if (x + f.w + P > S) { x = P; y += rowH + P; rowH = 0; }
      if (y + f.h + P > S) {
        if (pages >= this.maxPages) return false;
        pages++; x = P; y = P; rowH = 0;
      }
      x += f.w + P; rowH = Math.max(rowH, f.h);
    }
    return true;
  }

  /** Place a frame; its Texture lands in `out[idx]` after `commit()`.
   *  Returns false (and places nothing) when it doesn't fit the budget. */
  add(fr: Frame, out: Texture[], idx: number): boolean {
    const slot = this.slotFor(fr.w, fr.h);
    if (!slot) return false;
    let p: Page;
    if (slot.newPage) p = this.newPage();
    else {
      p = slot.page!;
      if (slot.wrap) { p.x = this.PAD; p.y += p.rowH + this.PAD; p.rowH = 0; }
    }
    const img = new ImageData(fr.data as unknown as Uint8ClampedArray<ArrayBuffer>, fr.w, fr.h);
    p.ctx.putImageData(img, p.x, p.y);
    this.pending.push({ page: p, frame: new Rectangle(p.x, p.y, fr.w, fr.h), out, idx });
    p.x += fr.w + this.PAD;
    p.rowH = Math.max(p.rowH, fr.h);
    p.dirty = true;
    this.bytes += fr.w * fr.h * 4;
    return true;
  }

  /** Upload dirty pages and resolve every pending frame to a Texture. */
  commit(): void {
    for (const p of this.pages) {
      if (!p.dirty) continue;
      if (!p.tex) {
        p.tex = Texture.from(p.canvas as HTMLCanvasElement);
        p.tex.source.scaleMode = this.nearest ? 'nearest' : 'linear';
        if (!this.nearest) { p.tex.source.autoGenerateMipmaps = true; }
      } else {
        p.tex.source.update();
      }
      p.dirty = false;
    }
    for (const q of this.pending) q.out[q.idx] = new Texture({ source: q.page.tex!.source, frame: q.frame });
    this.pending.length = 0;
  }

  get pageCount(): number { return this.pages.length; }

  /** GPU memory the pages cost: whole pages, RGBA, plus a third for mipmaps. */
  get gpuBytes(): number {
    return atlasGpuBytes(this.pages.length, this.pageSize, !this.nearest);
  }

  destroy(): void {
    for (const p of this.pages) p.tex?.destroy(true);
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
