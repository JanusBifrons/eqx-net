/** Teleporter redesign A3 — the Ancients' gate's seal: its outer ring closes
 *  into a solid loop of chords while SEALED; no posts, nothing else solid. */
import { describe, expect, it } from 'vitest';
import {
  ALIEN_GATE_OUTER_RING_RADIUS, ALIEN_GATE_OUTER_RING_WIDTH, ALIEN_GATE_SEAL_APOTHEM, ALIEN_GATE_SEAL_RADIUS, ALIEN_GATE_SEAL_SPANS,
} from './alienGateSeal.js';
import { PAD_SPECS, onPad, padIrisSpanCount, padIrisSpanLocal, padPushDir, padPushHalf } from './teleport.js';

const span = (i: number) => {
  const s = { ax: 0, ay: 0, bx: 0, by: 0 };
  padIrisSpanLocal('alien_gate', i, s);
  return s;
};

describe('alien gate seal (redesign A3)', () => {
  it('sits on the outer ring\'s outer edge', () => {
    expect(ALIEN_GATE_SEAL_RADIUS).toBe(ALIEN_GATE_OUTER_RING_RADIUS + ALIEN_GATE_OUTER_RING_WIDTH / 2);
    expect(padIrisSpanCount('alien_gate')).toBe(ALIEN_GATE_SEAL_SPANS);
    for (let i = 0; i < ALIEN_GATE_SEAL_SPANS; i++) {
      const s = span(i);
      expect(Math.hypot(s.ax, s.ay)).toBeCloseTo(ALIEN_GATE_SEAL_RADIUS, 9);
      expect(Math.hypot(s.bx, s.by)).toBeCloseTo(ALIEN_GATE_SEAL_RADIUS, 9);
      // Each chord's middle sags at most a few units inside the ring's edge.
      const sag = ALIEN_GATE_SEAL_RADIUS - Math.hypot((s.ax + s.bx) / 2, (s.ay + s.by) / 2);
      expect(sag).toBeGreaterThan(0);
      expect(sag).toBeLessThan(5);
      expect(sag).toBeCloseTo(ALIEN_GATE_SEAL_RADIUS - ALIEN_GATE_SEAL_APOTHEM, 9);
    }
  });

  it('is a closed loop: each span ends exactly where the next starts, the last at the first', () => {
    for (let i = 0; i < ALIEN_GATE_SEAL_SPANS; i++) {
      const a = span(i), b = span((i + 1) % ALIEN_GATE_SEAL_SPANS);
      expect([a.bx, a.by]).toEqual([b.ax, b.ay]);
    }
    // Goes once round, counter-clockwise (no span doubles back).
    let turn = 0;
    for (let i = 0; i < ALIEN_GATE_SEAL_SPANS; i++) {
      const s = span(i);
      turn += Math.atan2(s.ax * s.by - s.ay * s.bx, s.ax * s.bx + s.ay * s.by);
    }
    expect(turn).toBeCloseTo(2 * Math.PI, 9);
  });

  it('a quarter turn maps the seal onto itself (the server spans ignore rotation)', () => {
    expect(ALIEN_GATE_SEAL_SPANS % 4).toBe(0);
    const q = ALIEN_GATE_SEAL_SPANS / 4;
    for (let i = 0; i < ALIEN_GATE_SEAL_SPANS; i++) {
      const s = span(i), t = span(i + q);
      expect(t.ax).toBeCloseTo(-s.ay, 9);
      expect(t.ay).toBeCloseTo(s.ax, 9);
    }
  });

  it('the chamber pads have no iris and keep their towers', () => {
    for (const k of ['teleporter', 'teleporter_large', 'pocket_pad'] as const) {
      expect(padIrisSpanCount(k)).toBe(0);
      expect(PAD_SPECS[k].posts).toBeGreaterThanOrEqual(4);
      expect(() => padIrisSpanLocal(k, 0, { ax: 0, ay: 0, bx: 0, by: 0 })).toThrow();
    }
  });

  it('everyone inside the seal rides; nobody outside it', () => {
    const r = ALIEN_GATE_SEAL_APOTHEM;
    for (let k = 0; k < 16; k++) {
      const a = (k * Math.PI) / 8;
      expect(onPad('alien_gate', 100, 200, 100 + (r - 1) * Math.cos(a), 200 + (r - 1) * Math.sin(a))).toBe(true);
      expect(onPad('alien_gate', 100, 200, 100 + (r + 1) * Math.cos(a), 200 + (r + 1) * Math.sin(a))).toBe(false);
    }
    // The old square pad's corner is outside the seal: it no longer rides.
    expect(onPad('alien_gate', 0, 0, 630, 630)).toBe(false);
  });

  it('the closing push runs along the radius at the seal', () => {
    const half = padPushHalf('alien_gate');
    expect(half).toBe(ALIEN_GATE_SEAL_APOTHEM);
    expect(padPushHalf('teleporter')).toBe(PAD_SPECS.teleporter.padRadius);
    const out = { x: 0, y: 0 };
    const d = half - 10, e = half + 10, c = Math.SQRT1_2;
    expect(padPushDir(0, 0, half, d * c, d * c, 30, out, undefined, true)).toBe(true);
    expect(out.x).toBeCloseTo(-c, 9);
    expect(out.y).toBeCloseTo(-c, 9);
    expect(padPushDir(0, 0, half, e * c, e * c, 30, out, undefined, true)).toBe(true);
    expect(out.x).toBeCloseTo(c, 9);
    expect(out.y).toBeCloseTo(c, 9);
    expect(padPushDir(0, 0, half, 0, 0, 30, out, undefined, true)).toBe(false);
    expect(padPushDir(0, 0, half, 0, half + 200, 30, out, undefined, true)).toBe(false);
  });
});
