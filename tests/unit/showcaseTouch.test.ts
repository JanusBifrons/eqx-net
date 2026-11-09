/**
 * Showcase input scripting + phone framing — the pure parts.
 * touchPath (gesture curves), shotFilter (`--shot 'hud-*'`), compositor
 * device layout / rate control and recorder viewport options.
 */
import { describe, expect, it } from 'vitest';
import { arc, clampTo, easeInOut, easeOut, line, linear, polar, sample, samples, still, wiggle } from '../../showcase/touchPath.js';
import { expandShotPatterns } from '../../showcase/shotFilter.js';
import { deviceLayout, x264Args } from '../../showcase/compositor.js';
import { contextOptionsFor, screencastSize, PHONE_LANDSCAPE } from '../../showcase/recorder.js';

const close = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps;

describe('touchPath', () => {
  it('easings start at 0, end at 1, stay monotonic and clamp outside [0,1]', () => {
    for (const e of [linear, easeInOut, easeOut]) {
      expect(e(0)).toBe(0);
      expect(close(e(1), 1)).toBe(true);
      expect(e(-1)).toBe(0);
      expect(close(e(2), 1)).toBe(true);
      let prev = -1;
      for (let i = 0; i <= 50; i++) {
        const v = e(i / 50);
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
    expect(close(easeInOut(0.5), 0.5)).toBe(true);
  });

  it('a drag interpolates from → to and its samples are evenly timed at 60 Hz', () => {
    const pts = samples(line({ x: 0, y: 0 }, { x: 100, y: -50 }), 500, linear);
    expect(pts.length).toBe(31); // 30 steps + the end
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 100, y: -50 });
    // Linear: equal steps.
    const d0 = Math.hypot(pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y);
    const d1 = Math.hypot(pts[16]!.x - pts[15]!.x, pts[16]!.y - pts[15]!.y);
    expect(close(d0, d1, 1e-9)).toBe(true);
  });

  it('eased drags start and settle gently (smaller steps at the ends than mid-way)', () => {
    const pts = samples(line({ x: 0, y: 0 }, { x: 300, y: 0 }), 600, easeInOut);
    const step = (i: number): number => pts[i + 1]!.x - pts[i]!.x;
    const mid = Math.floor(pts.length / 2);
    expect(step(0)).toBeLessThan(step(mid));
    expect(step(pts.length - 2)).toBeLessThan(step(mid));
    // Never overshoots.
    for (const p of pts) expect(p.x).toBeLessThanOrEqual(300 + 1e-9);
  });

  it('arcs keep the radius and sweep the given angles (screen space, −π/2 = up)', () => {
    const c = arc(100, 200, 50, -Math.PI / 2, 0);
    expect(c(0).x).toBeCloseTo(100);
    expect(c(0).y).toBeCloseTo(150);
    expect(c(1).x).toBeCloseTo(150);
    expect(c(1).y).toBeCloseTo(200);
    for (let i = 0; i <= 10; i++) {
      const p = c(i / 10);
      expect(Math.hypot(p.x - 100, p.y - 200)).toBeCloseTo(50);
    }
  });

  it('wiggle sways perpendicular to travel and lands back on the base path at both ends', () => {
    const base = line({ x: 0, y: 0 }, { x: 0, y: -100 });
    const w = wiggle(base, 10, 2);
    expect(w(0)).toEqual(base(0));
    expect(w(1).x).toBeCloseTo(0);
    expect(w(1).y).toBeCloseTo(-100);
    let maxSway = 0;
    for (let i = 0; i <= 100; i++) {
      const u = i / 100;
      expect(w(u).y).toBeCloseTo(base(u).y); // vertical travel: sway is purely horizontal
      maxSway = Math.max(maxSway, Math.abs(w(u).x));
    }
    expect(maxSway).toBeGreaterThan(5);
    expect(maxSway).toBeLessThanOrEqual(10 + 1e-9);
    // A stationary base sways along x.
    const s = wiggle(still({ x: 5, y: 5 }), 4, 1);
    expect(s(0.25).y).toBe(5);
    expect(Math.abs(s(0.25).x - 5)).toBeGreaterThan(1);
  });

  it('sample clamps progress; polar and clampTo place points', () => {
    const l = line({ x: 0, y: 0 }, { x: 10, y: 0 });
    expect(sample(l, linear, 2)).toEqual({ x: 10, y: 0 });
    expect(sample(l, linear, -1)).toEqual({ x: 0, y: 0 });
    const p = polar({ x: 0, y: 0 }, 10, -Math.PI / 2);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(-10);
    expect(clampTo({ x: -5, y: 500 }, { x: 0, y: 0, width: 100, height: 100 }, 10)).toEqual({ x: 10, y: 90 });
  });
});

describe('shot filter', () => {
  const ids = ['flight', 'hud-a-desktop', 'hud-b-desktop', 'hud-a-phone-portrait', 'mobile'];

  it('expands * wildcards, keeps registry order, de-duplicates', () => {
    expect(expandShotPatterns(['hud-*'], ids)).toEqual(['hud-a-desktop', 'hud-b-desktop', 'hud-a-phone-portrait']);
    expect(expandShotPatterns(['mobile', 'hud-a-*', 'flight', 'hud-a-desktop'], ids)).toEqual([
      'flight',
      'hud-a-desktop',
      'hud-a-phone-portrait',
      'mobile',
    ]);
    expect(expandShotPatterns(['*-desktop'], ids)).toEqual(['hud-a-desktop', 'hud-b-desktop']);
  });

  it('treats regex characters literally and rejects patterns that match nothing', () => {
    expect(() => expandShotPatterns(['hud.a*'], ids)).toThrow(/unknown shot/);
    expect(() => expandShotPatterns(['nope'], ids)).toThrow(/nope/);
  });
});

describe('phone framing + encode', () => {
  it('desktop fills the frame; phones get a centred screen rect with even geometry inside 1920×1080', () => {
    expect(deviceLayout('desktop', 16 / 9)).toBeNull();
    for (const [vp, aspect] of [
      ['phone', 393 / 727],
      ['phone-landscape', PHONE_LANDSCAPE.width / PHONE_LANDSCAPE.height],
    ] as const) {
      const l = deviceLayout(vp, aspect)!;
      const s = l.screen;
      for (const n of [s.x, s.y, s.w, s.h]) expect(n % 2).toBe(0);
      expect(s.x - l.bezel).toBeGreaterThan(0);
      expect(s.y - l.bezel).toBeGreaterThan(0);
      expect(s.x + s.w + l.bezel).toBeLessThan(1920);
      expect(s.y + s.h + l.bezel).toBeLessThan(1080);
      expect(Math.abs(s.w / s.h - aspect)).toBeLessThan(0.01); // no stretching
      expect(Math.abs(s.x + s.w / 2 - 960)).toBeLessThanOrEqual(2); // centred
    }
    const land = deviceLayout('phone-landscape', 844 / 390)!;
    expect(land.orientation).toBe('landscape');
    expect(land.screen.y - land.bezel).toBeGreaterThanOrEqual(130); // room for the top caption
  });

  it('a bitrate cap adds a VBV ceiling; the default stays quality-only', () => {
    expect(x264Args()).not.toContain('-maxrate');
    const capped = x264Args(4000);
    expect(capped[capped.indexOf('-maxrate') + 1]).toBe('4000k');
    expect(capped[capped.indexOf('-bufsize') + 1]).toBe('8000k');
    expect(capped).toContain('libx264');
    expect(capped).toContain('yuv420p');
  });

  it('phone-landscape is a touch phone at 844×390 and captures at device resolution', () => {
    const o = contextOptionsFor('phone-landscape', { width: 1280, height: 720 });
    expect(o.viewport).toEqual({ width: 844, height: 390 });
    expect(o.isMobile).toBe(true);
    expect(o.hasTouch).toBe(true);
    expect(o.deviceScaleFactor).toBe(2);
    expect(screencastSize('phone-landscape', { width: 1280, height: 720 })).toEqual({ maxWidth: 1688, maxHeight: 780 });
    expect(contextOptionsFor('desktop', { width: 1280, height: 720 })).toEqual({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    expect(contextOptionsFor('phone', { width: 1280, height: 720 }).hasTouch).toBe(true);
  });
});
