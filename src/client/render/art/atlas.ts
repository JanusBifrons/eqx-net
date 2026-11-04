/**
 * Machined art — a shelf-packed texture atlas. Every baked frame of every kind goes
 * into a few large pages, so all sprites of a style share one texture source
 * and batch into one draw call per layer.
 */
import { Rectangle, Texture } from 'pixi.js';
import type { Frame } from './shade.js';

const PAGE = 4096;

interface Page {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tex: Texture | null;
  x: number;
  y: number;
  rowH: number;
  dirty: boolean;
}

export class Atlas {
  private pages: Page[] = [];
  private pending: Array<{ page: Page; frame: Rectangle; out: Texture[]; idx: number }> = [];
  /** Bytes of texel data placed (not page capacity). */
  bytes = 0;

  /** Mipmapped pages need a wider gutter, or small mips bleed between frames. */
  private readonly PAD: number;
  constructor(private readonly nearest: boolean) { this.PAD = nearest ? 1 : 8; }

  private newPage(): Page {
    const canvas = document.createElement('canvas');
    canvas.width = PAGE;
    canvas.height = PAGE;
    const ctx = canvas.getContext('2d')!;
    const p: Page = { canvas, ctx, tex: null, x: this.PAD, y: this.PAD, rowH: 0, dirty: true };
    this.pages.push(p);
    return p;
  }

  /** Place a frame; returns a slot filled with its Texture after `commit()`. */
  add(fr: Frame, out: Texture[], idx: number): void {
    if (fr.w + this.PAD * 2 > PAGE || fr.h + this.PAD * 2 > PAGE) throw new Error(`frame ${fr.w}x${fr.h} exceeds atlas page`);
    let p = this.pages[this.pages.length - 1] ?? this.newPage();
    if (p.x + fr.w + this.PAD > PAGE) { p.x = this.PAD; p.y += p.rowH + this.PAD; p.rowH = 0; }
    if (p.y + fr.h + this.PAD > PAGE) { p = this.newPage(); }
    const img = new ImageData(fr.data as unknown as Uint8ClampedArray<ArrayBuffer>, fr.w, fr.h);
    p.ctx.putImageData(img, p.x, p.y);
    this.pending.push({ page: p, frame: new Rectangle(p.x, p.y, fr.w, fr.h), out, idx });
    p.x += fr.w + this.PAD;
    p.rowH = Math.max(p.rowH, fr.h);
    p.dirty = true;
    this.bytes += fr.w * fr.h * 4;
  }

  /** Upload dirty pages and resolve every pending frame to a Texture. */
  commit(): void {
    for (const p of this.pages) {
      if (!p.dirty) continue;
      if (!p.tex) {
        p.tex = Texture.from(p.canvas);
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

  destroy(): void {
    for (const p of this.pages) p.tex?.destroy(true);
    this.pages.length = 0;
    this.bytes = 0;
  }
}
