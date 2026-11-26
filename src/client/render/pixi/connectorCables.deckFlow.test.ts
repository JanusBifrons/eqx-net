/**
 * Base platforms slice 13 — power-flow pulses on a deck link ride its hex-seam
 * cable. The comet train (`drawSocketCableFlow`) walks the link's cached
 * polyline by arc length at the material's world speed, so a deck link (whose
 * cached polyline is the seam path, slice 12) carries its comets along the
 * seams at the same world speed as any other cable: a longer seam path takes
 * longer to cross, it does not stretch the comets faster.
 */
import { describe, expect, it } from 'vitest';
import { LinkCableCache, drawSocketCableFlow, fillStraight, makeLinkCable, type LinkCable } from './connectorCables.js';
import { connectorVisualInto, type ConnectorVisual } from './connectorVisual.js';
import { cablePulseWidth, type LinePath } from './connectorLineLooks.js';
import { CABLE_CURVE_SEGMENTS, CABLE_NO_SOCKET } from '../../../core/structures/cableCurve.js';
import { deckSeamPathInto } from '../../../core/structures/deckCablePath.js';
import type { GridNode } from '../../../core/structures/Grid.js';
import type { SwarmRenderState } from '../../../core/contracts/IRenderer.js';
import { HEX_DIRS } from '../../../core/hex/hex.js';
import { deckHexCentreInto, plateCentreWorldInto } from '../../../core/hex/plates.js';
import { blankGridNode } from '../../structures/mirrorToGridNode.js';

class FakePath {
  readonly paths: Array<{ pts: number[]; width: number }> = [];
  private pts: number[] = [];
  moveTo(x: number, y: number): this { this.pts.push(NaN, NaN, x, y); return this; }
  lineTo(x: number, y: number): this { this.pts.push(x, y); return this; }
  stroke(s: { width: number }): this { this.paths.push({ pts: this.pts, width: s.width }); this.pts = []; return this; }
  circle(): this { return this; }
  fill(): this { this.pts = []; return this; }
  get g(): LinePath { return this as unknown as LinePath; }
}

/** The comet stroke's sub-paths (each one comet), or none. */
function comets(f: FakePath, scale: number): number[][] {
  const s = f.paths.find((p) => p.width === cablePulseWidth(scale));
  const out: number[][] = [];
  if (!s) return out;
  for (let i = 0; i < s.pts.length; i += 2) {
    if (Number.isNaN(s.pts[i]!)) out.push([]);
    else out[out.length - 1]!.push(s.pts[i]!, s.pts[i + 1]!);
  }
  return out;
}

function node(kind: string, x: number, y: number, isConnector: boolean): GridNode {
  const n = blankGridNode();
  n.kind = kind; n.x = x; n.y = y; n.rot = 0; n.isConnector = isConnector;
  return n;
}
const pose = (n: GridNode): SwarmRenderState => ({ x: n.x, y: n.y, angle: 0, radius: 40, shipKind: n.kind }) as unknown as SwarmRenderState;
const blank = (): ConnectorVisual => ({ color: 0, alpha: 0, width: 0, glowAlpha: 0, glowWidth: 0 });
const power = (): ConnectorVisual => connectorVisualInto(blank(), 1e12, 1e12, 1, 0, 'power');

/** Distance from (x, y) to segment (ax, ay)-(bx, by). */
function segDist(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
  return Math.hypot(x - ax - dx * t, y - ay - dy * t);
}

/** Distance from (x, y) to the polyline `pts` (x0, y0, x1, y1, …). */
function polyDist(x: number, y: number, pts: ArrayLike<number>, n: number): number {
  let best = Infinity;
  for (let i = 1; i < n; i++) best = Math.min(best, segDist(x, y, pts[i * 2 - 2]!, pts[i * 2 - 1]!, pts[i * 2]!, pts[i * 2 + 1]!));
  return best;
}

/** Arc length along cable `c` of a point lying on it. */
function arcOf(c: LinkCable, x: number, y: number): number {
  let best = Infinity, arc = 0;
  for (let i = 1; i < c.n; i++) {
    const ax = c.poly[i * 2 - 2]!, ay = c.poly[i * 2 - 1]!, bx = c.poly[i * 2]!, by = c.poly[i * 2 + 1]!;
    const d = segDist(x, y, ax, ay, bx, by);
    if (d < best) { best = d; arc = c.cum[i - 1]! + Math.hypot(x - ax, y - ay); }
  }
  return arc;
}

/** The raw seam path a -> b in Pixi space (y flipped). */
function seamPixi(a: GridNode, b: GridNode): { pts: Float64Array; n: number } {
  const pts = new Float64Array(128);
  const n = deckSeamPathInto(a.x, a.y, b.x, b.y, pts, 64);
  for (let i = 0; i < n; i++) pts[i * 2 + 1] = -pts[i * 2 + 1]!;
  return { pts, n };
}

/** The lead comet's head arc (source at the first point) at `elapsedMs` of flow. */
function leadHeadArc(c: LinkCable, elapsedMs: number): number {
  c.flowSeen = -Infinity;
  const f = new FakePath();
  drawSocketCableFlow(f.g, c, power(), true, 1, 1000, 'power'); // starts the run at 1000
  f.paths.length = 0;
  drawSocketCableFlow(f.g, c, power(), true, 1, 1000 + elapsedMs, 'power');
  const cs = comets(f, 1);
  expect(cs.length).toBeGreaterThan(0);
  const lead = cs[0]!;
  return arcOf(c, lead[lead.length - 2]!, lead[lead.length - 1]!);
}

// An on-plate link (connector -> a building one hex out) and a neighbour-plate
// link (anchor -> anchor): a short seam and a long multi-turn one.
const d = HEX_DIRS[2]!;
const hp = deckHexCentreInto(d.q, d.r, { x: 0, y: 0 });
const pc = plateCentreWorldInto(1, -1, { x: 0, y: 0 });
const LINKS: Array<[string, GridNode, GridNode]> = [
  ['on-plate', node('solar', hp.x, hp.y, false), node('connector', 0, 0, true)],
  ['neighbour-plate', node('connector', 0, 0, true), node('connector', pc.x, pc.y, true)],
];

describe('deck link flow pulses ride the seam path (base platforms slice 13)', () => {
  for (const [name, a, b] of LINKS) {
    for (const sourceIsLo of [true, false]) {
      it(`${name}: every comet point lies on the seam (source ${sourceIsLo ? 'first' : 'last'})`, () => {
        const cache = new LinkCableCache();
        cache.deck = true;
        const c = cache.get(1, pose(a), CABLE_NO_SOCKET, pose(b), CABLE_NO_SOCKET);
        expect(c.n).toBe(CABLE_CURVE_SEGMENTS + 1);
        const seam = seamPixi(a, b);
        expect(seam.n).toBeGreaterThan(2); // a real seam path, not the straight line
        const f = new FakePath();
        let seen = 0;
        for (let t = 0; t < 8000; t += 37) {
          f.paths.length = 0;
          drawSocketCableFlow(f.g, c, power(), sourceIsLo, 1, 1000 + t, 'power');
          for (const sp of comets(f, 1)) {
            for (let i = 0; i < sp.length; i += 2) {
              expect(polyDist(sp[i]!, sp[i + 1]!, seam.pts, seam.n)).toBeLessThan(1);
              seen++;
            }
          }
        }
        expect(seen).toBeGreaterThan(50);
      });
    }

    it(`${name}: comets move at the same world speed as on a straight cable`, () => {
      const cache = new LinkCableCache();
      cache.deck = true;
      const c = cache.get(1, pose(a), CABLE_NO_SOCKET, pose(b), CABLE_NO_SOCKET);
      const straight = makeLinkCable();
      fillStraight(straight, a.x, -a.y, b.x, -b.y);
      expect(c.len).toBeGreaterThan(straight.len); // the seam is the longer way round
      // Two frames while the lead comet is still on its way (head short of the end).
      const t1 = 40, t2 = 140;
      expect((440 * t2) / 1000 + 12).toBeLessThan(straight.len);
      const deckStep = leadHeadArc(c, t2) - leadHeadArc(c, t1);
      const straightStep = leadHeadArc(straight, t2) - leadHeadArc(straight, t1);
      expect(deckStep).toBeCloseTo((440 * (t2 - t1)) / 1000, 6); // power: 440 u/s
      expect(deckStep).toBeCloseTo(straightStep, 6);
    });
  }

  it('the same link off a deck keeps its ordinary (non-seam) cable', () => {
    const [, a, b] = LINKS[0]!;
    const cache = new LinkCableCache();
    const c = cache.get(1, pose(a), CABLE_NO_SOCKET, pose(b), CABLE_NO_SOCKET);
    const seam = seamPixi(a, b);
    let off = 0;
    for (let i = 0; i < c.n; i++) off = Math.max(off, polyDist(c.poly[i * 2]!, c.poly[i * 2 + 1]!, seam.pts, seam.n));
    expect(off).toBeGreaterThan(1);
  });
});
