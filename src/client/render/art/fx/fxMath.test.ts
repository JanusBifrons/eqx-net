/**
 * Effects per-frame maths (plan iridescent-seeking-rainbow v2): pure helpers
 * shared by the FX lab and, after sign-off, the game.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { backdropXf, CONTACT_MAX_POWER, emberTint, envelope, flipFrame, lerpRgb, SHIELD_CONTACTS, ShieldContacts, ShieldHits, SHIELD_HITS, TrailRing, zoomWindow } from './fxMath.js';

describe('flipFrame', () => {
  it('maps age to a frame inside [0, frames) and -1 outside the play', () => {
    expect(flipFrame(-0.01, 1, 16)).toBe(-1);
    expect(flipFrame(0, 1, 16)).toBe(0);
    expect(flipFrame(0.999, 1, 16)).toBe(15);
    expect(flipFrame(1, 1, 16)).toBe(-1);
    fc.assert(fc.property(fc.double({ min: 0, max: 0.9999, noNaN: true }), fc.integer({ min: 1, max: 64 }), (a, n) => {
      const f = flipFrame(a, 1, n);
      return f >= 0 && f < n;
    }));
  });
});

describe('envelope', () => {
  it('rises to 1 and falls to 0 at the end of life', () => {
    expect(envelope(0, 0.1, 1)).toBe(0);
    expect(envelope(0.1, 0.1, 1)).toBeCloseTo(1);
    expect(envelope(1, 0.1, 1)).toBe(0);
    expect(envelope(0.6, 0.1, 1)).toBeLessThan(envelope(0.3, 0.1, 1));
  });
});

describe('colour', () => {
  it('lerpRgb hits both ends and clamps', () => {
    expect(lerpRgb(0x102030, 0xffffff, 0)).toBe(0x102030);
    expect(lerpRgb(0x102030, 0xffffff, 1)).toBe(0xffffff);
    expect(lerpRgb(0x000000, 0xffffff, 2)).toBe(0xffffff);
  });
  it('embers cool from near white to dark red', () => {
    expect((emberTint(1) >> 8) & 255).toBeGreaterThan(200);
    expect((emberTint(0) >> 8) & 255).toBeLessThan(30);
  });
});

describe('backdropXf', () => {
  it('keeps the camera point (scaled by parallax) under the screen centre', () => {
    fc.assert(fc.property(
      fc.double({ min: -5000, max: 5000, noNaN: true }), fc.double({ min: -5000, max: 5000, noNaN: true }),
      fc.double({ min: 0.15, max: 3, noNaN: true }), fc.double({ min: 0, max: 1.5, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }),
      (cx, cy, z, par, pow) => {
        const o = backdropXf(cx, cy, z, par, pow, 1280, 720, { scale: 0, x: 0, y: 0 });
        return Math.abs(o.x + cx * par * o.scale - 640) < 1e-6 && Math.abs(o.y + cy * par * o.scale - 360) < 1e-6;
      }));
  });
  it('a distant layer barely scales when you zoom (depth)', () => {
    expect(backdropXf(0, 0, 3, 1, 1, 100, 100, { scale: 0, x: 0, y: 0 }).scale).toBeCloseTo(3);
    expect(backdropXf(0, 0, 3, 0.02, 0.1, 100, 100, { scale: 0, x: 0, y: 0 }).scale).toBeLessThan(1.2);
  });
});

describe('zoomWindow', () => {
  it('is 0 below the window and 1 inside it', () => {
    expect(zoomWindow(0.1, 0.22, 0.45, Infinity, Infinity)).toBe(0);
    expect(zoomWindow(1, 0.22, 0.45, Infinity, Infinity)).toBe(1);
    expect(zoomWindow(0.3, 0.22, 0.45, Infinity, Infinity)).toBeGreaterThan(0);
    expect(zoomWindow(5, 0, 0.1, 1, 2)).toBe(0);
  });
});

describe('ShieldHits', () => {
  it('keeps the newest four hits and reports idle when they expire', () => {
    const h = new ShieldHits();
    for (let i = 0; i < 6; i++) h.add(i, i * 0.1);
    expect(Array.from(h.ang).sort()).toEqual([2, 3, 4, 5]);
    expect(h.activity(0.55, 0.5)).toBeGreaterThan(0);
    expect(h.activity(5, 0.5)).toBe(0);
    expect(SHIELD_HITS).toBe(4);
  });
});

describe('TrailRing', () => {
  it('reads newest first and repeats the oldest while filling', () => {
    const r = new TrailRing(4);
    r.reset(0, 0);
    r.push(1, 10); r.push(2, 20);
    expect(r.readX(0)).toBe(2);
    expect(r.readX(1)).toBe(1);
    expect(r.readX(3)).toBe(1);
    for (let i = 3; i <= 9; i++) r.push(i, i * 10);
    expect(r.readX(0)).toBe(9);
    expect(r.readY(3)).toBe(60);
    expect(r.count()).toBe(4);
  });
});

describe('ShieldContacts (beams on a shield)', () => {
  const frame = (c: ShieldContacts, beams: Array<[number, number]>, dt = 1 / 60): void => {
    c.begin();
    for (const [k, a] of beams) c.offer(k, a);
    c.end(dt);
  };

  it('one beam holds one steady contact (no flicker) and fades out when it stops', () => {
    const c = new ShieldContacts();
    const levels: number[] = [];
    for (let f = 0; f < 60; f++) { frame(c, [[7, 1]]); levels.push(c.intensity(0)); }
    expect(c.count()).toBe(1);
    // Rises once, then stays at full: never dips (the round-1 flicker).
    for (let i = 1; i < levels.length; i++) expect(levels[i]!).toBeGreaterThanOrEqual(levels[i - 1]!);
    expect(levels[levels.length - 1]).toBeCloseTo(1);
    for (let f = 0; f < 30; f++) frame(c, []);
    expect(c.count()).toBe(0);
  });

  it('two and three beams from different sides each get their own contact', () => {
    const c = new ShieldContacts();
    for (let f = 0; f < 20; f++) frame(c, [[1, 0], [2, 2]]);
    expect(c.count()).toBe(2);
    for (let f = 0; f < 20; f++) frame(c, [[1, 0], [2, 2], [3, -2]]);
    expect(c.count()).toBe(3);
  });

  it('beams landing close together share one brighter patch', () => {
    const c = new ShieldContacts();
    for (let f = 0; f < 20; f++) frame(c, [[1, 0.5], [2, 0.6]]);
    expect(c.count()).toBe(1);
    let max = 0;
    for (let i = 0; i < SHIELD_CONTACTS; i++) max = Math.max(max, c.intensity(i));
    expect(max).toBeGreaterThan(1);
    expect(max).toBeLessThanOrEqual(CONTACT_MAX_POWER);
  });

  it('more beams than slots merge into the nearest instead of evicting', () => {
    const c = new ShieldContacts();
    const beams: Array<[number, number]> = [[1, 0], [2, 1.6], [3, 3.1], [4, -1.6], [5, 0.8]];
    for (let f = 0; f < 20; f++) frame(c, beams);
    expect(c.count()).toBe(SHIELD_CONTACTS);
    // Every contact stays fully lit while all five beams play.
    for (let i = 0; i < SHIELD_CONTACTS; i++) expect(c.intensity(i)).toBeGreaterThanOrEqual(1);
  });

  it('a moving beam drags its contact round the shield', () => {
    const c = new ShieldContacts();
    for (let f = 0; f < 60; f++) frame(c, [[9, f * 0.01]]);
    expect(c.count()).toBe(1);
    let slot = 0;
    for (let i = 0; i < SHIELD_CONTACTS; i++) if (c.key[i] === 9) slot = i;
    expect(c.ang[slot]!).toBeGreaterThan(0.5);
  });
});
