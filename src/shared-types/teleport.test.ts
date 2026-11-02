import { describe, expect, it } from 'vitest';
import { ALIEN_GATE_INTERVAL_MS, PAD_SPECS, TELEPORTER_KINDS, alienGateOffsetMs, nextAlienGateJumpMs, onPad, padHalfExtent, padIrisSpanLocal, padPostCenters, padPushDir } from './teleport.js';

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
