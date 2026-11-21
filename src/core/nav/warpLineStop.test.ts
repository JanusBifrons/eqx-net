import { describe, it, expect } from 'vitest';
import { CoarseFieldMap } from './coarseField.js';
import {
  newWarpLineStop, warpLineClear, warpLineStop, WARP_FIELD_TOLERANCE,
  type WarpStructureFootprint, type WarpStructureSource,
} from './warpLineStop.js';
import { SLICED, cutFieldPad, slicedFieldLanes, type ChunkOpts, type FieldClearing } from '../terrain/fieldLayout.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

const battleship = getShipKind('battleship').radius;
const fighter = getShipKind('fighter').radius;
const seed = 'look';
const opts = (clearings?: FieldClearing[]): ChunkOpts => ({
  seed, battleshipLength: battleship * 2, fighterLength: fighter * 2, ...(clearings ? { clearings } : {}),
});
const R = SLICED.radius, S = R + cutFieldPad();
const margin = 300;

/** Array-backed structure source, as a server registry would wrap. */
class Boxes implements WarpStructureSource {
  constructor(private readonly list: WarpStructureFootprint[]) {}
  get count(): number { return this.list.length; }
  footprint(i: number, out: WarpStructureFootprint): void { Object.assign(out, this.list[i]!); }
}
const box = (x: number, y: number, halfW: number, halfH: number, boxes?: Float32Array): WarpStructureFootprint =>
  ({ x, y, halfW, halfH, boxes });

const plain = new CoarseFieldMap();
plain.build(opts());

/** A point at half the radius with solid rock all round it out to `clearR` + 4 km. */
function solidSpot(clearR: number): { x: number; y: number } {
  for (let a = 0; a < Math.PI * 2; a += 0.05) {
    const x = Math.cos(a) * R * 0.5, y = Math.sin(a) * R * 0.5;
    let ok = true;
    for (let d = 0; d <= clearR + 4000 && ok; d += 500) {
      for (let k = 0; k < 16 && ok; k++) {
        const b = (k / 16) * Math.PI * 2;
        if (!plain.solidAt(x + Math.cos(b) * d, y + Math.sin(b) * d)) ok = false;
      }
    }
    if (ok) return { x, y };
  }
  throw new Error('no solid spot');
}

describe('CoarseFieldMap.solidAt', () => {
  it('rock body is solid; core, lanes and outside are not; roomAt is unchanged by the split', () => {
    expect(plain.solidAt(0, 0)).toBe(false); // the core
    expect(plain.solidAt(S + 10, 0)).toBe(false); // outside the rim
    const ln = slicedFieldLanes({ seed, battleshipLength: battleship * 2 })[0]!;
    const dx = ln.n.y, dy = -ln.n.x;
    expect(plain.solidAt(ln.o.x + dx * R * 0.6, ln.o.y + dy * R * 0.6)).toBe(false); // in a lane
    const p = solidSpot(0);
    expect(plain.solidAt(p.x, p.y)).toBe(true);
    // Half a street is still positive room in the body: solid is not roomAt <= 0.
    expect(plain.roomAt(p.x, p.y)).toBeGreaterThan(0);
  });
});

describe('warpLineStop', () => {
  const out = newWarpLineStop();

  it('a clear line reaches its target', () => {
    warpLineStop(plain, null, -S - 5000, S + 5000, S + 5000, S + 5000, margin, out);
    expect(out).toEqual({ x: S + 5000, y: S + 5000, blocked: false, shortBy: 0 });
  });

  it('the field body blocks the line a margin short of its edge, and the stop point reads clear', () => {
    // A radial line in toward a spot with rock all round it: it meets rock at the rim.
    const p = solidSpot(0), r = Math.hypot(p.x, p.y), ux = p.x / r, uy = p.y / r;
    const fx = ux * (S + 10_000), fy = uy * (S + 10_000);
    expect(plain.solidAt(ux * (S - 50), uy * (S - 50))).toBe(true); // precondition: rock at the rim here
    warpLineStop(plain, null, fx, fy, -fx, -fy, margin, out);
    expect(out.blocked).toBe(true);
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(S + margin, -1);
    expect(out.shortBy).toBeCloseTo(Math.hypot(out.x + fx, out.y + fy), 3);
    const sx = out.x, sy = out.y;
    expect(warpLineStop(plain, null, fx, fy, sx, sy, margin, out).blocked).toBe(false);
    expect(warpLineClear(plain, null, fx, fy, sx, sy)).toBe(true);
    // Margin 0: the stop is within the bisection tolerance of the rock, and still reads clear.
    warpLineStop(plain, null, fx, fy, -fx, -fy, 0, out);
    expect(Math.hypot(out.x, out.y) - S).toBeLessThanOrEqual(WARP_FIELD_TOLERANCE + 1e-6);
    expect(warpLineClear(plain, null, fx, fy, out.x, out.y)).toBe(true);
  });

  it('a line down a lane end to end is clear', () => {
    for (const ln of slicedFieldLanes({ seed, battleshipLength: battleship * 2 })) {
      const dx = ln.n.y, dy = -ln.n.x, t = S + 5000;
      warpLineStop(plain, null, ln.o.x - dx * t, ln.o.y - dy * t, ln.o.x + dx * t, ln.o.y + dy * t, margin, out);
      expect(out.blocked).toBe(false);
    }
  });

  describe('clearings', () => {
    const clearR = 8000, c = solidSpot(clearR);
    const map = new CoarseFieldMap();
    map.build(opts([{ x: c.x, y: c.y, r: clearR }]));

    it('a start inside a clearing reaches a target in it, and is stopped at its edge going further', () => {
      expect(warpLineStop(map, null, c.x, c.y, c.x + 5000, c.y, margin, out).blocked).toBe(false);
      warpLineStop(map, null, c.x, c.y, c.x + 20_000, c.y, margin, out);
      expect(out.blocked).toBe(true);
      expect(out.x - c.x).toBeCloseTo(clearR - margin, -1);
      expect(out.shortBy).toBeCloseTo(20_000 - (out.x - c.x), 3);
      expect(warpLineClear(map, null, c.x, c.y, out.x, out.y)).toBe(true);
    });

    it('a target in a clearing beyond rock is blocked at the rock', () => {
      const r = Math.hypot(c.x, c.y), fx = (c.x / r) * (S + 10_000), fy = (c.y / r) * (S + 10_000);
      warpLineStop(map, null, fx, fy, c.x, c.y, margin, out);
      expect(out.blocked).toBe(true);
      expect(Math.hypot(out.x - c.x, out.y - c.y)).toBeGreaterThan(clearR + margin); // stopped in rock, short of the clearing
      expect(warpLineClear(map, null, fx, fy, c.x, c.y)).toBe(false);
    });
  });

  describe('structures (no field)', () => {
    it('a structure on the line stops it a margin short of its footprint; the stop reads clear', () => {
      const src = new Boxes([box(5000, 0, 200, 300), box(2000, 5000, 100, 100)]);
      warpLineStop(null, src, 0, 0, 10_000, 0, margin, out);
      expect(out.blocked).toBe(true);
      expect(out.x).toBeCloseTo(4800 - margin, 6);
      expect(out.y).toBeCloseTo(0, 6);
      expect(out.shortBy).toBeCloseTo(10_000 - (4800 - margin), 6);
      expect(warpLineStop(null, src, 0, 0, out.x, out.y, margin, out).blocked).toBe(false);
      // Margin 0 stops on the footprint's face, which still reads clear.
      warpLineStop(null, src, 0, 0, 10_000, 0, 0, out);
      expect(out.x).toBeCloseTo(4800, 6);
      expect(warpLineClear(null, src, 0, 0, out.x, out.y)).toBe(true);
    });

    it('a structure whose footprint holds the start is ignored', () => {
      const src = new Boxes([box(0, 0, 500, 500)]);
      expect(warpLineStop(null, src, 100, 0, 10_000, 0, margin, out).blocked).toBe(false);
      expect(warpLineClear(null, src, -10_000, 0, 10_000, 0)).toBe(false);
    });

    it('a gate blocks by its parts: the gap between them is open', () => {
      // Two posts at y ±400 with a gap between them on the line y = 0.
      const parts = new Float32Array([0, 400, 50, 200, 0, -400, 50, 200]);
      const src = new Boxes([box(5000, 0, 50, 600, parts)]);
      expect(warpLineClear(null, src, 0, 0, 10_000, 0)).toBe(true);
      expect(warpLineClear(null, src, 0, 400, 10_000, 400)).toBe(false);
    });

    it('no field and no structures: always clear', () => {
      expect(warpLineStop(null, null, 0, 0, 1e6, 1e6, margin, out).blocked).toBe(false);
      expect(warpLineStop(null, null, 3, 4, 3, 4, margin, out)).toEqual({ x: 3, y: 4, blocked: false, shortBy: 0 });
    });
  });

  it('a structure nearer than the field wins', () => {
    const p = solidSpot(0), r = Math.hypot(p.x, p.y), ux = p.x / r, uy = p.y / r;
    const fx = ux * (S + 10_000), fy = uy * (S + 10_000);
    const bx = ux * (S + 5000), by = uy * (S + 5000);
    const src = new Boxes([box(bx, by, 100, 100)]);
    warpLineStop(plain, src, fx, fy, 0, 0, margin, out);
    expect(out.blocked).toBe(true);
    expect(Math.hypot(out.x - fx, out.y - fy)).toBeLessThan(5000);
  });
});
