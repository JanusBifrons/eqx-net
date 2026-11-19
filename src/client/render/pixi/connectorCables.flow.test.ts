/**
 * Structure restyle 0d slice 9 — the socket cable's flow: a comet train by
 * arc length in the flow direction, in game time, and the receiving
 * socket's collar flash. Plus a count budget for the per-frame draw work of
 * one animated link (counts gate, never wall-clock).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COLLAR_FLASH_MS, FLOW_RESTART_GAP_MS, MAX_CABLE_COMETS, collarFlash, drawSocketCableFlow, fillStraight,
  flowTrainInto, leadCometArc, makeLinkCable, type FlowTrain, type LinkCable,
} from './connectorCables.js';
import { CABLE_CURVE_SEGMENTS } from '../../../core/structures/cableCurve.js';
import { connectorVisualInto, type ConnectorVisual } from './connectorVisual.js';
import type { LinePath } from './connectorLineLooks.js';

/** Records path verbs and strokes like a Pixi Graphics. */
class FakePath {
  readonly paths: Array<{ pts: number[]; color: number; alpha: number }> = [];
  verbs = 0;
  private pts: number[] = [];
  moveTo(x: number, y: number): this { this.pts.push(NaN, NaN, x, y); this.verbs++; return this; }
  lineTo(x: number, y: number): this { this.pts.push(x, y); this.verbs++; return this; }
  stroke(s: { color: number; alpha: number }): this { this.paths.push({ pts: this.pts, color: s.color, alpha: s.alpha }); this.pts = []; return this; }
  clear(): void { this.paths.length = 0; this.verbs = 0; }
  get g(): LinePath { return this as unknown as LinePath; }
}

/** The sub-paths (moveTo-separated point lists) of one stroke. */
function subPaths(pts: number[]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < pts.length; i += 2) {
    if (Number.isNaN(pts[i]!)) out.push([]);
    else out[out.length - 1]!.push(pts[i]!, pts[i + 1]!);
  }
  return out;
}

/** An L-shaped cable (Pixi space): (0,0) -> (100,0) -> (100,100). */
function lCable(socketed: boolean): LinkCable {
  const c = makeLinkCable();
  c.poly[0] = 0; c.poly[1] = 0; c.poly[2] = 100; c.poly[3] = 0; c.poly[4] = 100; c.poly[5] = 100;
  c.cum[0] = 0; c.cum[1] = 100; c.cum[2] = 200;
  c.n = 3; c.len = 200; c.socketed = socketed;
  return c;
}

const PULSE = 0xffe08a;
function flowing(): ConnectorVisual {
  // An edge lit long ago and still flowing: no beat (steady floor alphas).
  return connectorVisualInto({ color: 0, alpha: 0, width: 0, glowAlpha: 0, glowWidth: 0 }, 1e12, 1e12, 1, 0, 'minerals');
}
const cometStrokes = (f: FakePath) => f.paths.filter((p) => p.color === PULSE);

afterEach(() => vi.restoreAllMocks());

describe('flow comet train (0d slice 9)', () => {
  it('the first comet travels the material speed by arc length; the train is capped on a long cable', () => {
    const t: FlowTrain = { speed: 0, spacing: 0, d: 0 };
    flowTrainInto(t, 400, 500, 'minerals');
    expect(t.d).toBeCloseTo(t.speed * 0.5);
    expect(leadCometArc(t, 400)).toBeCloseTo(t.d);
    // Power races ore.
    const p: FlowTrain = { speed: 0, spacing: 0, d: 0 };
    expect(flowTrainInto(p, 400, 500, 'power').d).toBeGreaterThan(t.d);
    // Past the end the lead is the next comet behind, still on the cable.
    flowTrainInto(t, 400, 10_000, 'minerals');
    const lead = leadCometArc(t, 400);
    expect(lead).toBeGreaterThan(400 - t.spacing);
    expect(lead).toBeLessThanOrEqual(400);
    flowTrainInto(t, 4000, 0, 'minerals');
    expect(t.spacing).toBeGreaterThanOrEqual(4000 / MAX_CABLE_COMETS);
  });

  it('draws the comet along the polyline at its arc length, from the source end', () => {
    const f = new FakePath();
    const c = lCable(false);
    const v = flowing();
    const speed = flowTrainInto({ speed: 0, spacing: 0, d: 0 }, 200, 1000, 'minerals').speed;
    drawSocketCableFlow(f.g, c, v, true, 1, 5000, 'minerals'); // flow starts
    f.clear();
    const ms = (150 / speed) * 1000; // first comet 150 u along: on the second leg
    drawSocketCableFlow(f.g, c, v, true, 1, 5000 + ms, 'minerals');
    const [comet] = subPaths(cometStrokes(f)[0]!.pts);
    // Half length 12 at scale 1: arc 138..162 = (100, 38)..(100, 62).
    expect(comet![0]).toBeCloseTo(100); expect(comet![1]).toBeCloseTo(38);
    expect(comet![comet!.length - 2]).toBeCloseTo(100); expect(comet![comet!.length - 1]).toBeCloseTo(62);
    // Flow the other way (source at the last point): arc 150 from (100,100) = (50, 0).
    const r = new FakePath();
    const c2 = lCable(false);
    drawSocketCableFlow(r.g, c2, v, false, 1, 5000, 'minerals');
    r.clear();
    drawSocketCableFlow(r.g, c2, v, false, 1, 5000 + ms, 'minerals');
    const [back] = subPaths(cometStrokes(r)[0]!.pts);
    const xs = [back![0]!, back![back!.length - 2]!].sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(38); expect(xs[1]).toBeCloseTo(62);
    expect(back![1]).toBeCloseTo(0);
  });

  it('runs on the game time it is given, never real time; a gap restarts the train', () => {
    const now = vi.spyOn(performance, 'now');
    const v = flowing();
    const run = (times: number[]): number[] => {
      const f = new FakePath();
      const c = makeLinkCable();
      fillStraight(c, 0, 0, 600, 0);
      for (const t of times) { f.clear(); drawSocketCableFlow(f.g, c, v, true, 1, t, 'construction'); }
      return subPaths(cometStrokes(f)[0]!.pts)[0]!;
    };
    const a = run([100, 400, 700]);
    now.mockReturnValue(9e9);
    const b = run([100, 400, 700]);
    expect(b).toEqual(a);
    expect(now).not.toHaveBeenCalled();
    // Same elapsed game time from a later start = same comet.
    expect(run([20_100, 20_400, 20_700])).toEqual(a);
    // A pause in flow longer than the restart gap sends a fresh comet from the source.
    const fresh = run([100, 400, 400 + FLOW_RESTART_GAP_MS + 1]);
    expect(fresh[0]).toBe(0);
  });
});

describe('socket collar flash (0d slice 9)', () => {
  it('fires when a comet reaches the receiving socket and decays over COLLAR_FLASH_MS', () => {
    const t: FlowTrain = { speed: 0, spacing: 0, d: 0 };
    const speed = flowTrainInto(t, 200, 0, 'repair').speed;
    const arrive = (200 / speed) * 1000;
    expect(collarFlash(flowTrainInto(t, 200, arrive - 1, 'repair'), 200)).toBe(0);
    const f0 = collarFlash(flowTrainInto(t, 200, arrive + 1, 'repair'), 200);
    const f1 = collarFlash(flowTrainInto(t, 200, arrive + COLLAR_FLASH_MS / 2, 'repair'), 200);
    expect(f0).toBeGreaterThan(0.95);
    expect(f1).toBeGreaterThan(0); expect(f1).toBeLessThan(f0);
    expect(collarFlash(flowTrainInto(t, 200, arrive + COLLAR_FLASH_MS + 1, 'repair'), 200)).toBe(0);
    // The next comet arrives one spacing later and flashes again.
    expect(collarFlash(flowTrainInto(t, 200, arrive + (t.spacing / speed) * 1000 + 1, 'repair'), 200)).toBeGreaterThan(0.95);
  });

  it('draws the flash at the receiving collar only, socketed cables only', () => {
    const v = flowing();
    const speed = flowTrainInto({ speed: 0, spacing: 0, d: 0 }, 200, 0, 'minerals').speed;
    const arrive = (200 / speed) * 1000;
    const draw = (socketed: boolean, sourceIsLo: boolean, at: number): FakePath => {
      const f = new FakePath();
      const c = lCable(socketed);
      for (let t = 0; t < at; t += 200) drawSocketCableFlow(f.g, c, v, sourceIsLo, 1, t, 'minerals');
      f.clear();
      drawSocketCableFlow(f.g, c, v, sourceIsLo, 1, at, 'minerals');
      return f;
    };
    const lit = draw(true, true, arrive + 10);
    const flash = lit.paths.filter((p) => p.color === v.color && p.alpha > 0.4 && subPaths(p.pts)[0]!.length === 4);
    expect(flash).toHaveLength(1);
    // At the receiving (last) point, (100, 100).
    expect(flash[0]!.pts[2]).toBeCloseTo(100); expect(flash[0]!.pts[3]).toBeCloseTo(100);
    const rev = draw(true, false, arrive + 10);
    const rflash = rev.paths.filter((p) => p.color === v.color && p.alpha > 0.4 && subPaths(p.pts)[0]!.length === 4);
    expect(rflash[0]!.pts[2]).toBeCloseTo(0); expect(rflash[0]!.pts[3]).toBeCloseTo(0);
    // Before any arrival, after the flash, and on a fence link: no flash.
    const strokes = (f: FakePath) => f.paths.length;
    expect(strokes(draw(true, true, arrive - 50))).toBe(strokes(draw(true, true, arrive + COLLAR_FLASH_MS + 20)));
    expect(strokes(draw(false, true, arrive + 10))).toBe(strokes(lit) - 2);
  });
});

describe('per-frame draw work of one animated cable (counts, not time)', () => {
  /** Strokes: bleed, core, one for every comet, two for the flash. */
  const MAX_STROKES = 5;
  it('stays within the stroke and path-verb budget at every zoom and phase', () => {
    const c = makeLinkCable();
    // A full-length 13-point curve: a wide arc.
    const n = CABLE_CURVE_SEGMENTS + 1;
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * i) / (n - 1);
      c.poly[i * 2] = 300 - 300 * Math.cos(a); c.poly[i * 2 + 1] = -200 * Math.sin(a);
    }
    c.n = n; c.socketed = true;
    c.cum[0] = 0;
    for (let i = 1; i < n; i++) c.cum[i] = c.cum[i - 1]! + Math.hypot(c.poly[i * 2]! - c.poly[i * 2 - 2]!, c.poly[i * 2 + 1]! - c.poly[i * 2 - 1]!);
    c.len = c.cum[n - 1]!;
    const v = flowing();
    const f = new FakePath();
    let maxVerbs = 0, maxStrokes = 0;
    for (const scale of [0.15, 0.45, 1, 2]) {
      for (let t = 0; t < 8000; t += 37) {
        f.clear();
        drawSocketCableFlow(f.g, c, v, true, scale, t, 'power');
        maxVerbs = Math.max(maxVerbs, f.verbs);
        maxStrokes = Math.max(maxStrokes, f.paths.length);
      }
    }
    expect(maxStrokes).toBeLessThanOrEqual(MAX_STROKES);
    // Bleed + core run the polyline (2 x n verbs); comets and flash on top.
    expect(maxVerbs).toBeLessThanOrEqual(2 * n + (MAX_CABLE_COMETS + 1) * 8 + 4);
  });
});
