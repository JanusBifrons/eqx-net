/**
 * Owner report 2026-11-21: a socket cable must meet each socket flush, not at
 * an angle. The drawn polyline (the cached `LinkCable`, Pixi space, y down)
 * starts exactly on socket A and ends exactly on socket B, and its first and
 * last segments run along those sockets' outward normals: for building ends,
 * connector ends (short tail) and a mirrored building (build mirror 4A).
 */
import { describe, expect, it } from 'vitest';
import { LinkCableCache, type LinkCable } from './connectorCables.js';
import { structureSockets, structureSocketToWorld } from '../../../shared-types/structureKinds.js';
import type { SwarmRenderState } from '../../../core/contracts/IRenderer.js';

function pose(kind: string, x: number, y: number, angle: number): SwarmRenderState {
  return {
    x, y, vx: 0, vy: 0, angle, angvel: 0, prevX: x, prevY: y, prevAngle: angle,
    prevArrivalMs: 0, latestArrivalMs: 0, poseRing: [], ringHead: 0, radius: 40, kind: 2,
    shipKind: kind, sleeping: true, lastUpdateTick: 0,
  };
}

const w = { x: 0, y: 0, nx: 0, ny: 0 };
/** Socket `i` of `e` in game space (y up). */
function socket(e: SwarmRenderState, i: number, mirror: boolean): { x: number; y: number; nx: number; ny: number } {
  structureSocketToWorld(structureSockets(e.shipKind)[i]!, e.x, e.y, e.angle, w, mirror);
  return { ...w };
}

/** The socket of `e` whose normal points most toward `to` (a plausible pick). */
function facing(e: SwarmRenderState, to: SwarmRenderState, mirror: boolean): number {
  let best = -1, bestDot = -Infinity;
  const n = structureSockets(e.shipKind).length;
  for (let i = 0; i < n; i++) {
    const s = socket(e, i, mirror);
    const dx = to.x - s.x, dy = to.y - s.y, l = Math.hypot(dx, dy);
    const d = (s.nx * dx + s.ny * dy) / l;
    if (d > bestDot) { bestDot = d; best = i; }
  }
  return best;
}

/** Sine of the angle between segment (x0,y0)->(x1,y1) and direction (nx, ny). */
function sinOff(x0: number, y0: number, x1: number, y1: number, nx: number, ny: number): number {
  const dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy);
  return l > 0 ? Math.abs(dx * ny - dy * nx) / l : 1;
}

/** Tolerance: under ~1.5 degrees off the socket normal. */
const SIN_TOL = Math.sin((1.5 * Math.PI) / 180);

function expectFlush(c: LinkCable, a: { x: number; y: number; nx: number; ny: number }, b: { x: number; y: number; nx: number; ny: number }): void {
  const p = c.poly, last = (c.n - 1) * 2;
  // Endpoints on the socket points (Pixi y = -game y).
  expect(p[0]).toBeCloseTo(a.x, 6); expect(p[1]).toBeCloseTo(-a.y, 6);
  expect(p[last]).toBeCloseTo(b.x, 6); expect(p[last + 1]).toBeCloseTo(-b.y, 6);
  // First segment leaves A along A's normal (outward), last enters B against B's.
  expect(sinOff(p[0]!, p[1]!, p[2]!, p[3]!, a.nx, -a.ny)).toBeLessThan(SIN_TOL);
  expect((p[2]! - p[0]!) * a.nx + (p[3]! - p[1]!) * -a.ny).toBeGreaterThan(0);
  expect(sinOff(p[last - 2]!, p[last - 1]!, p[last]!, p[last + 1]!, b.nx, -b.ny)).toBeLessThan(SIN_TOL);
  expect((p[last - 2]! - p[last]!) * b.nx + (p[last - 1]! - p[last + 1]!) * -b.ny).toBeGreaterThan(0);
}

const CASES: Array<{ name: string; a: [string, number, number, number]; b: [string, number, number, number]; ma?: boolean; mb?: boolean }> = [
  { name: 'building to building, at an angle', a: ['solar_panel', 0, 0, 0.3], b: ['solar_panel', 380, 150, -0.5] },
  { name: 'building to connector', a: ['solar_panel', 0, 0, 0], b: ['connector', 320, 210, 0] },
  { name: 'connector to connector, far apart', a: ['connector', 0, 0, 0.2], b: ['connector', 520, -260, 0] },
  { name: 'connector to building (short tail end first)', a: ['connector', -100, 40, 0], b: ['solar_panel', 260, 300, 1.1] },
  { name: 'a mirrored building', a: ['refinery', 0, 0, 0.4], b: ['connector', 420, 120, 0], ma: true },
];

describe('socket cables meet the socket flush (owner report 2026-11-21)', () => {
  for (const k of CASES) {
    it(k.name, () => {
      const A = pose(...k.a), B = pose(...k.b);
      const ma = k.ma === true, mb = k.mb === true;
      const sa = facing(A, B, ma), sb = facing(B, A, mb);
      const cache = new LinkCableCache();
      const c = cache.get(1, A, sa, B, sb, ma, mb);
      expect(c.socketed).toBe(true);
      expectFlush(c, socket(A, sa, ma), socket(B, sb, mb));
    });
  }

  it('a mirror change re-lays the cable', () => {
    const A = pose('refinery', 0, 0, 0.4), B = pose('connector', 420, 120, 0);
    const cache = new LinkCableCache();
    const sa = facing(A, B, true), sb = facing(B, A, false);
    cache.get(1, A, sa, B, sb, false, false);
    const n = cache.flattens;
    cache.get(1, A, sa, B, sb, true, false);
    expect(cache.flattens).toBe(n + 1);
  });
});
