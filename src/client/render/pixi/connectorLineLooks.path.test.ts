/**
 * "Bundle on the curve": the cable line look walks a polyline by arc length.
 * Locks: the straight look is byte-identical to the pre-curve drawer (exact
 * verb + stroke stream snapshot), a 2-point path draws exactly the straight
 * look, and on a curved path the cradles sit at even arc-length stations,
 * square to the local tangent.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  cableLookWidth, cableStudInset, drawCablePathBody, drawCablePathGlow, drawLineLookBody, drawLineLookFlow, LINE_LOOK_FULL,
  type CablePath, type LinePath,
} from './connectorLineLooks.js';
import { connectorVisualInto, type CometSegment, type ConnectorVisual } from './connectorVisual.js';

/** Records every path verb and stroke exactly (full float precision). */
class Rec {
  readonly log: string[] = [];
  moveTo(x: number, y: number): this { this.log.push(`M${x},${y}`); return this; }
  lineTo(x: number, y: number): this { this.log.push(`L${x},${y}`); return this; }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): this { this.log.push(`Q${cx},${cy},${x},${y}`); return this; }
  stroke(s: { color: number; alpha: number; width: number }): this { this.log.push(`S${s.color},${s.alpha},${s.width}`); return this; }
  get g(): LinePath { return this as unknown as LinePath; }
  text(): string { return this.log.join(' '); }
}

function flowing(): ConnectorVisual {
  return connectorVisualInto({ color: 0, alpha: 0, width: 0, glowAlpha: 0, glowWidth: 0 }, 1e12, 1e12, 1, 0, 'minerals');
}
const comet = (): CometSegment => ({ x0: 0, y0: 0, x1: 0, y1: 0 }) as CometSegment;

const EDGES: Array<[number, number, number, number, number, number, number]> = [
  // ax, ay, bx, by, scale, ra, rb
  [-400, 0, 0, 0, 0.5, 46, 46],
  [12.5, -40.25, 371.75, 233.5, 1, 30, 52],
  [0, 0, -260, -610, 0.05, 46, 20],
  [5, 5, 45, 25, 0.5, 46, 46],
  [100, 300, 100, -300, 2, 0, 0],
];

describe('straight cable look is unchanged by the polyline walk', () => {
  it('body and flow verb streams match the pre-curve drawer exactly', () => {
    const out: string[] = [];
    for (const [ax, ay, bx, by, scale, ra, rb] of EDGES) {
      for (const opts of [LINE_LOOK_FULL, { size: 0.6, cradles: false, lit: true }]) {
        const r = new Rec();
        drawLineLookBody(r.g, 'cable', ax, ay, bx, by, scale, ra, rb, opts);
        drawLineLookFlow(r.g, 'cable', flowing(), comet(), true, ax, ay, bx, by, scale, ra, rb, opts);
        drawLineLookFlow(r.g, 'cable', flowing(), comet(), false, ax, ay, bx, by, scale, ra, rb, opts);
        out.push(`${r.log.length} ${createHash('sha256').update(r.text()).digest('hex').slice(0, 24)}`);
      }
    }
    expect(out).toMatchSnapshot();
  });
});

/** A 2-point path a -> b. */
function line(ax: number, ay: number, bx: number, by: number): CablePath {
  return { poly: Float64Array.of(ax, ay, bx, by), cum: Float64Array.of(0, Math.hypot(bx - ax, by - ay)), n: 2, len: Math.hypot(bx - ax, by - ay) };
}

/** A 13-point quarter circle of radius `r` about the origin (Pixi space). */
function arc(r: number): CablePath {
  const n = 13;
  const poly = new Float64Array(n * 2), cum = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (Math.PI / 2) * (i / (n - 1));
    poly[i * 2] = r * Math.cos(a); poly[i * 2 + 1] = r * Math.sin(a);
    if (i > 0) cum[i] = cum[i - 1]! + Math.hypot(poly[i * 2]! - poly[i * 2 - 2]!, poly[i * 2 + 1]! - poly[i * 2 - 1]!);
  }
  return { poly, cum, n, len: cum[n - 1]! };
}

/** Records strokes as (width, sub-paths of [x0, y0, x1, y1, ...]). */
class Shapes {
  readonly strokes: Array<{ width: number; subs: number[][] }> = [];
  private subs: number[][] = [];
  moveTo(x: number, y: number): this { this.subs.push([x, y]); return this; }
  lineTo(x: number, y: number): this { this.subs[this.subs.length - 1]!.push(x, y); return this; }
  quadraticCurveTo(_cx: number, _cy: number, x: number, y: number): this { return this.lineTo(x, y); }
  stroke(s: { width: number }): this { this.strokes.push({ width: s.width, subs: this.subs }); this.subs = []; return this; }
  get g(): LinePath { return this as unknown as LinePath; }
  /** The across-bars of the stroke `width` wide (one per station). */
  bars(width: number): number[][] {
    const s = this.strokes.filter((x) => Math.abs(x.width - width) < 1e-9);
    expect(s).toHaveLength(1);
    return s[0]!.subs;
  }
}

/** Arc length and unit tangent of the point on `p` nearest (x, y). */
function locate(p: CablePath, x: number, y: number): { s: number; tx: number; ty: number; dist: number } {
  let best = { s: 0, tx: 1, ty: 0, dist: Infinity };
  for (let j = 1; j < p.n; j++) {
    const ax = p.poly[j * 2 - 2]!, ay = p.poly[j * 2 - 1]!;
    const d = p.cum[j]! - p.cum[j - 1]!;
    const tx = (p.poly[j * 2]! - ax) / d, ty = (p.poly[j * 2 + 1]! - ay) / d;
    const u = Math.max(0, Math.min(d, (x - ax) * tx + (y - ay) * ty));
    const dist = Math.hypot(ax + tx * u - x, ay + ty * u - y);
    if (dist < best.dist) best = { s: p.cum[j - 1]! + u, tx, ty, dist };
  }
  return best;
}

describe('bundle on the curve (cable look along a polyline)', () => {
  it('a 2-point path draws exactly the straight look (body and flow glow)', () => {
    for (const [ax, ay, bx, by, scale, ra, rb] of EDGES) {
      const len = Math.hypot(bx - ax, by - ay);
      const e0 = Math.min(ra * 0.9, len * 0.3), e1 = Math.min(rb * 0.9, len * 0.3);
      const straight = new Rec(), path = new Rec();
      drawLineLookBody(straight.g, 'cable', ax, ay, bx, by, scale, ra, rb);
      drawCablePathBody(path.g, line(ax, ay, bx, by), scale, e0, e1, false);
      expect(path.text()).toBe(straight.text());
      const sf = new Rec(), pf = new Rec();
      drawLineLookFlow(sf.g, 'cable', flowing(), comet(), true, ax, ay, bx, by, scale, ra, rb);
      drawCablePathGlow(pf.g, line(ax, ay, bx, by), flowing(), scale, e0, e1, false);
      expect(pf.log.length).toBeGreaterThan(0);
      expect(sf.log.slice(0, pf.log.length)).toEqual(pf.log);
    }
  });

  it('on a curve the frames sit at even arc-length stations, square to the local tangent', () => {
    const p = arc(600);
    const f = new Shapes();
    const w = cableLookWidth(1);
    const e = cableStudInset(1, p.len);
    drawCablePathBody(f.g, p, 1, e, e, true);
    // Clamp plates: one across-bar per cradle, centred on the path.
    const clamps = f.bars(w * 0.42).map((b) => {
      const mx = (b[0]! + b[2]!) / 2, my = (b[1]! + b[3]!) / 2;
      const at = locate(p, mx, my);
      expect(at.dist).toBeLessThan(1e-6);
      // Across the cable: square to the curve's tangent where it sits (the
      // arc's true tangent there, not just the polyline leg's).
      const bl = Math.hypot(b[2]! - b[0]!, b[3]! - b[1]!);
      const phi = Math.atan2(my, mx);
      expect(Math.abs(((b[2]! - b[0]!) * -Math.sin(phi) + (b[3]! - b[1]!) * Math.cos(phi)) / bl)).toBeLessThan(0.01);
      return at.s;
    });
    expect(clamps.length).toBeGreaterThanOrEqual(3);
    const gap = clamps[1]! - clamps[0]!;
    for (let i = 1; i < clamps.length; i++) expect(clamps[i]! - clamps[i - 1]!).toBeCloseTo(gap, 6);
    // Even spacing over the stud-to-stud run: first and last cradles one
    // pitch in from the end collars.
    const collars = f.bars(w * 0.78).map((b) => locate(p, (b[0]! + b[2]!) / 2, (b[1]! + b[3]!) / 2));
    expect(collars).toHaveLength(2);
    expect(collars[0]!.s).toBeCloseTo(e, 6);
    expect(collars[1]!.s).toBeCloseTo(p.len - e, 6);
    expect(clamps[0]! - collars[0]!.s).toBeCloseTo(gap, 6);
    expect(collars[1]!.s - clamps[clamps.length - 1]!).toBeCloseTo(gap, 6);
    // The end collars sit square to the curve's first leg (the stud normal).
    const c0 = f.bars(w * 0.78)[0]!;
    const ux = p.poly[2]! - p.poly[0]!, uy = p.poly[3]! - p.poly[1]!;
    const cl = Math.hypot(c0[2]! - c0[0]!, c0[3]! - c0[1]!) * Math.hypot(ux, uy);
    expect(Math.abs((c0[2]! - c0[0]!) * ux + (c0[3]! - c0[1]!) * uy) / cl).toBeLessThan(0.05);
  });

  it('the bundle strands follow the curve (offset runs keep their spacing)', () => {
    const p = arc(600);
    const f = new Shapes();
    const w = cableLookWidth(1);
    drawCablePathBody(f.g, p, 1, 6, 6, true);
    // The three strand sheaths (width = half the look): each stays within
    // its offset band of the centreline all along.
    const sheaths = f.strokes.filter((s) => Math.abs(s.width - w * 0.5) < 1e-9);
    expect(sheaths).toHaveLength(3);
    for (const s of sheaths) {
      const pts = s.subs[0]!;
      for (let i = 0; i < pts.length; i += 2) expect(locate(p, pts[i]!, pts[i + 1]!).dist).toBeLessThan(w * 0.55 + w * 0.55 * 0.45 + 1e-6);
    }
  });

  it('a stud-to-stud run too short for cradles still gets both end collars', () => {
    const f = new Shapes();
    const w = cableLookWidth(1);
    drawCablePathBody(f.g, line(0, 0, 40, 0), 1, cableStudInset(1, 40), cableStudInset(1, 40), true);
    expect(f.bars(w * 0.78)).toHaveLength(2);
    expect(f.strokes.some((s) => Math.abs(s.width - w * 0.42) < 1e-9)).toBe(false); // no cradles
  });
});
