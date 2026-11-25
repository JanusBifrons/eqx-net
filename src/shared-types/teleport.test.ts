import { describe, expect, it } from 'vitest';
import {
  ALIEN_GATE_INTERVAL_MS, PAD_SPECS, TELEPORTER_KINDS, alienGateOffsetMs, isPadChamberKind, nextAlienGateJumpMs, onPad, padDoorwayHalf,
  padHalfExtent, padIrisSpanLocal, padPostCenters, padPostSides, padPushDir,
} from './teleport.js';
import { SHIP_KINDS_LIST } from './shipKinds/catalogueOrder.js';
import { tuningFor } from './shipScale/lookup.js';
import { sizeClassOf } from './shipScale/tuning.js';

describe('pad geometry (v4 T2)', () => {
  it('posts sit inside the footprint, in perimeter order', () => {
    for (const k of TELEPORTER_KINDS) {
      const pts = padPostCenters(k);
      expect(pts).toHaveLength(PAD_SPECS[k].posts);
      const h = padHalfExtent(k);
      for (const [x, y] of pts) {
        expect(Math.abs(x) + PAD_SPECS[k].post / 2).toBeLessThanOrEqual(h);
        expect(Math.abs(y) + PAD_SPECS[k].post / 2).toBeLessThanOrEqual(h);
      }
      // Each post's neighbour shares a side of the square (perimeter order).
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i]!;
        const [bx, by] = pts[(i + 1) % pts.length]!;
        expect(ax === bx || ay === by, `${k} posts ${i}→${i + 1}`).toBe(true);
      }
    }
  });

  it('iris spans close every gap between posts, edge to edge', () => {
    const s = { ax: 0, ay: 0, bx: 0, by: 0 };
    for (const k of TELEPORTER_KINDS) {
      const half = PAD_SPECS[k].post / 2;
      for (let i = 0; i < PAD_SPECS[k].posts; i++) {
        padIrisSpanLocal(k, i, s);
        const [ax, ay] = padPostCenters(k)[i]!;
        expect(Math.hypot(s.ax - ax, s.ay - ay)).toBeCloseTo(half);
        expect(Math.hypot(s.bx - s.ax, s.by - s.ay)).toBeGreaterThan(0);
      }
    }
  });

  it('a ship on the open pad is on it; one by a post is not', () => {
    expect(onPad('teleporter', 0, 0, 100, -200)).toBe(true);
    expect(onPad('teleporter', 0, 0, 0, PAD_SPECS.teleporter.padRadius + 1)).toBe(false);
  });
});

describe('padPushDir (the closing iris)', () => {
  const out = { x: 0, y: 0 };
  const half = 320;
  it('pushes a straddler on the pad side inward and one outside outward', () => {
    expect(padPushDir(0, 0, half, 300, 10, 30, out)).toBe(true);
    expect(out).toEqual({ x: -1, y: 0 });
    expect(padPushDir(0, 0, half, 340, 10, 30, out)).toBe(true);
    expect(out).toEqual({ x: 1, y: 0 });
    expect(padPushDir(0, 0, half, 10, -310, 30, out)).toBe(true);
    expect(out).toEqual({ x: 0, y: 1 });
  });

  it('leaves ships well inside or well outside alone', () => {
    expect(padPushDir(0, 0, half, 0, 0, 30, out)).toBe(false);
    expect(padPushDir(0, 0, half, 1000, 0, 30, out)).toBe(false);
  });

  it('a bigger hull straddles over a wider band', () => {
    expect(padPushDir(0, 0, half, 150, 0, 30, out)).toBe(false);
    expect(padPushDir(0, 0, half, 150, 0, 213, out)).toBe(true);
  });
});

describe('alien gate timetable (v4 A)', () => {
  it('both ends of a pair agree on the offset; different pairs differ', () => {
    expect(alienGateOffsetMs('sol-prime', 'vega-reach')).toBe(alienGateOffsetMs('vega-reach', 'sol-prime'));
    expect(alienGateOffsetMs('sol-prime', 'vega-reach')).not.toBe(alienGateOffsetMs('sol-prime', 'cygnus-arm'));
    expect(alienGateOffsetMs('a', 'b')).toBeLessThan(ALIEN_GATE_INTERVAL_MS);
  });

  it('the next jump is strictly after now, within one interval, on the offset', () => {
    const off = 12_345;
    for (const now of [0, 12_345, 12_346, 59_999, 1_000_000, 1_793_656_000_000]) {
      const next = nextAlienGateJumpMs(now, off);
      expect(next).toBeGreaterThan(now);
      expect(next - now).toBeLessThanOrEqual(ALIEN_GATE_INTERVAL_MS);
      expect(((next - off) % ALIEN_GATE_INTERVAL_MS + ALIEN_GATE_INTERVAL_MS) % ALIEN_GATE_INTERVAL_MS).toBe(0);
    }
  });

  it('a test speed-up shortens the interval', () => {
    expect(nextAlienGateJumpMs(0, 0, 600)).toBe(600);
    expect(nextAlienGateJumpMs(600, 0, 600)).toBe(1200);
  });
});

describe('teleporter chamber (redesign T1)', () => {
  const CHAMBERS = ['teleporter', 'teleporter_large', 'pocket_pad'] as const;
  const out = { x: 0, y: 0 };

  it('the three built/transit pads are chambers; the Ancients\' gate is not', () => {
    for (const k of CHAMBERS) expect(isPadChamberKind(k)).toBe(true);
    expect(isPadChamberKind('alien_gate')).toBe(false);
    expect(TELEPORTER_KINDS.filter(isPadChamberKind)).toEqual(['teleporter', 'teleporter_large', 'pocket_pad']);
  });

  it('footprints are unchanged (800 / 2120 / 800)', () => {
    expect(2 * padHalfExtent('teleporter')).toBe(800);
    expect(2 * padHalfExtent('pocket_pad')).toBe(800);
    expect(2 * padHalfExtent('teleporter_large')).toBe(2120);
  });

  it('doorway: half the pad side, wider than every non-capital hull with its shield; no capital fits a pad', () => {
    expect(2 * padDoorwayHalf('teleporter')).toBe(320);
    expect(2 * padDoorwayHalf('teleporter_large')).toBe(900);
    const widest = Math.min(...CHAMBERS.map((k) => 2 * padDoorwayHalf(k)));
    for (const k of SHIP_KINDS_LIST) {
      if (k.engineeringOnly) continue;
      const across = 2 * (k.radius + tuningFor(k.id).shieldPad);
      if (sizeClassOf(k) === 'capital') {
        expect(across, `${k.id} would fit the large pad`).toBeGreaterThan(2 * PAD_SPECS.teleporter_large.padRadius);
      } else {
        expect(across, `${k.id} through the doorway`).toBeLessThan(widest);
      }
    }
  });

  it('every tower stands clear of both doorways (never on a ±y end between the corners)', () => {
    for (const k of CHAMBERS) {
      const h = padHalfExtent(k) - PAD_SPECS[k].post / 2;
      const door = padDoorwayHalf(k);
      const pts = padPostCenters(k);
      expect(pts).toHaveLength(PAD_SPECS[k].posts);
      for (const [x, y] of pts) {
        if (Math.abs(y) === h) expect(Math.abs(x), `${k} tower on a doorway end`).toBe(h); // corners only
        expect(Math.abs(x) - PAD_SPECS[k].post / 2, `${k} tower in a doorway`).toBeGreaterThanOrEqual(door);
      }
    }
  });

  it('large teleporter: 8 towers, the 4 corners and 2 down each side wall', () => {
    const h = 980, k3 = 980 / 3;
    const pts = padPostCenters('teleporter_large').map(([x, y]) => [x, Math.round(y * 1000) / 1000]);
    const r = (v: number): number => Math.round(v * 1000) / 1000;
    expect(pts).toEqual([[-h, -h], [h, -h], [h, r(-k3)], [h, r(k3)], [h, h], [-h, h], [-h, r(k3)], [-h, r(-k3)]]);
    expect(padPostSides('teleporter_large')).toEqual([0, 1, 1, 1, 2, 3, 3, 3]);
    // The small pads keep their four corners, unchanged.
    expect(padPostCenters('teleporter')).toEqual([[-360, -360], [360, -360], [360, 360], [-360, 360]]);
    expect(padPostSides('teleporter')).toEqual([0, 1, 2, 3]);
  });

  it('Ancients\' gate: its ring of 12 posts is unchanged', () => {
    const h = 690, st = (2 * h) / 3;
    const want: Array<[number, number]> = [];
    for (let i = 0; i < 3; i++) want.push([-h + i * st, -h]);
    for (let i = 0; i < 3; i++) want.push([h, -h + i * st]);
    for (let i = 0; i < 3; i++) want.push([h - i * st, h]);
    for (let i = 0; i < 3; i++) want.push([-h, h - i * st]);
    expect(padPostCenters('alien_gate')).toEqual(want);
    expect(padPostSides('alien_gate')).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]);
  });

  it('onPad turns with the chamber (0, 90, 180 degrees); the Ancients\' gate ignores the angle', () => {
    for (const a of [0, Math.PI / 2, Math.PI]) {
      expect(onPad('teleporter', 100, 50, 100, 50 + 300, a)).toBe(true);
      expect(onPad('teleporter', 100, 50, 100 + 330, 50, a)).toBe(false);
    }
    // A 45° turn: a point just past the square's edge along the axis is on the turned square's diagonal.
    expect(onPad('teleporter', 0, 0, 330, 0, 0)).toBe(false);
    expect(onPad('teleporter', 0, 0, 330, 0, Math.PI / 4)).toBe(true);
    expect(onPad('alien_gate', 0, 0, 700, 0, Math.PI / 4)).toBe(false);
  });

  it('push runs along the doorway axis only, turned with the chamber, never into a wall', () => {
    const half = PAD_SPECS.teleporter.padRadius;
    for (const [a, ax, ay] of [[0, 0, 1], [Math.PI / 2, -1, 0], [Math.PI, 0, -1]] as const) {
      // Local point (lx, ly) to world.
      const w = (lx: number, ly: number): [number, number] => [lx * Math.cos(a) - ly * Math.sin(a), lx * Math.sin(a) + ly * Math.cos(a)];
      // On the pad just inside the +y doorway: pushed in (toward -local y).
      expect(padPushDir(0, 0, half, ...w(0, half - 10), 30, out, a)).toBe(true);
      expect(out.x).toBeCloseTo(-ax, 9); expect(out.y).toBeCloseTo(-ay, 9);
      // Just outside it: pushed out (+local y).
      expect(padPushDir(0, 0, half, ...w(40, half + 10), 30, out, a)).toBe(true);
      expect(out.x).toBeCloseTo(ax, 9); expect(out.y).toBeCloseTo(ay, 9);
      // By a side wall (local ±x edge): no sideways push into the wall.
      expect(padPushDir(0, 0, half, ...w(half - 10, 0), 30, out, a)).toBe(false);
      expect(padPushDir(0, 0, half, ...w(-(half + 10), 0), 30, out, a)).toBe(false);
      // Beside the chamber, level with a doorway: left alone.
      expect(padPushDir(0, 0, half, ...w(half + 200, half), 30, out, a)).toBe(false);
    }
    // Property: whatever it pushes, it pushes along the doorway axis.
    for (let i = 0; i < 400; i++) {
      const x = ((i * 37) % 800) - 400, y = ((i * 91) % 800) - 400;
      if (padPushDir(0, 0, half, x, y, 40, out, 0)) expect(Math.abs(out.x)).toBe(0);
    }
  });

  it('with no doorAngle the push is the old open-pad push (the Ancients\' gate)', () => {
    expect(padPushDir(0, 0, 640, 620, 10, 30, out)).toBe(true);
    expect(out).toEqual({ x: -1, y: 0 });
  });
});
