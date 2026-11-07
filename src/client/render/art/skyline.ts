/**
 * Skyline packing for one atlas page.
 *
 * The page keeps its "skyline": the top edge of everything placed so far, as
 * a list of flat segments. Each frame goes where its top ends lowest (then
 * leftmost), so short frames fill the gaps beside tall ones. The old shelf
 * layout (rows as tall as their tallest frame) wasted almost half of every
 * page (phone run 2026-11-07: 33 M texels placed in 59 M of pages).
 *
 * `pad` is the gutter kept round every frame (mipmapped pages need a wide one,
 * or small mips bleed between neighbours).
 */
export class Skyline {
  private xs: number[];
  private ys: number[];
  private ws: number[];

  constructor(private readonly size: number, private readonly pad: number, src?: Skyline) {
    if (src) { this.xs = src.xs.slice(); this.ys = src.ys.slice(); this.ws = src.ws.slice(); }
    else { this.xs = [pad]; this.ys = [pad]; this.ws = [size - pad]; }
  }

  /** A copy, to test fits without placing anything. */
  clone(): Skyline { return new Skyline(this.size, this.pad, this); }

  /** Place a w×h frame; its top-left corner, or null when it doesn't fit. */
  place(w: number, h: number): { x: number; y: number } | null {
    const W = w + this.pad, H = h + this.pad;
    const { xs, ys, ws } = this;
    let best = -1, bestY = 0, bestTop = Infinity, bestX = Infinity;
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i]!;
      if (x + W > this.size) break; // segments run left to right
      let y = 0, covered = 0;
      for (let j = i; j < xs.length && covered < W; j++) { if (ys[j]! > y) y = ys[j]!; covered += ws[j]!; }
      if (covered < W || y + H > this.size) continue;
      if (y + H < bestTop || (y + H === bestTop && x < bestX)) { best = i; bestY = y; bestTop = y + H; bestX = x; }
    }
    if (best < 0) return null;
    const x = xs[best]!;
    // The new flat top over [x, x + W); trim what it covers.
    xs.splice(best, 0, x); ys.splice(best, 0, bestY + H); ws.splice(best, 0, W);
    const end = x + W;
    let j = best + 1;
    while (j < xs.length && xs[j]! < end) {
      const cut = end - xs[j]!;
      if (cut >= ws[j]!) { xs.splice(j, 1); ys.splice(j, 1); ws.splice(j, 1); continue; }
      xs[j] = xs[j]! + cut; ws[j] = ws[j]! - cut;
      break;
    }
    // Merge neighbours at the same height.
    for (let k = 0; k < xs.length - 1;) {
      if (ys[k] === ys[k + 1]) { ws[k] = ws[k]! + ws[k + 1]!; xs.splice(k + 1, 1); ys.splice(k + 1, 1); ws.splice(k + 1, 1); }
      else k++;
    }
    return { x, y: bestY };
  }
}
