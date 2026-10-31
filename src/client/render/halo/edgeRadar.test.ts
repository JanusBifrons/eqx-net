/**
 * Edge-track radar geometry (plan sparkling-wondering-rose). Locks the rules in
 * docs/architecture/off-screen-indicators.md §3 — each `it` names the rule.
 */
import { describe, expect, it } from 'vitest';
import {
  circleTouchesViewport,
  deOverlapAlongTrack,
  distanceT,
  placeOnTrack,
  pointViewportDistance,
  rampNearFar,
  rangeFade,
  buildBlockedIntervals,
  resolveBlocked,
  trackParam,
  trackPerimeter,
  trackPoint,
  type TrackRect,
} from './edgeRadar.js';

const W = 800;
const H = 600;
const TRACK: TrackRect = { left: 20, top: 20, right: 780, bottom: 580 };

describe('visibility — no icon for anything with any part on screen', () => {
  it('a contact whose centre is off-screen but whose body overlaps the edge counts as visible', () => {
    // centre 10 px past the right edge, radius 15 px → still touching.
    expect(circleTouchesViewport(W + 10, 300, 15, W, H, 0)).toBe(true);
  });
  it('a contact fully outside is not visible', () => {
    expect(circleTouchesViewport(W + 30, 300, 15, W, H, 0)).toBe(false);
  });
  it('hysteresis: a contact that WAS visible needs the extra margin before it counts as off-screen', () => {
    expect(circleTouchesViewport(W + 25, 300, 15, W, H, 16)).toBe(true);
    expect(circleTouchesViewport(W + 40, 300, 15, W, H, 16)).toBe(false);
  });
  it('point-to-viewport distance is 0 inside and Euclidean at a corner', () => {
    expect(pointViewportDistance(400, 300, W, H)).toBe(0);
    expect(pointViewportDistance(W + 3, H + 4, W, H)).toBe(5);
  });
});

describe('distance → size + opacity (never position)', () => {
  it('t is 0 just off-screen, 1 at/after the far distance, monotonic between', () => {
    expect(distanceT(0, 500, 4000)).toBe(0);
    expect(distanceT(4000, 500, 4000)).toBe(1);
    expect(distanceT(9000, 500, 4000)).toBe(1);
    const a = distanceT(300, 500, 4000);
    const b = distanceT(1200, 500, 4000);
    const c = distanceT(2500, 500, 4000);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
  it('is log-compressed: the near band resolves more t per unit than the far band', () => {
    const nearStep = distanceT(500, 500, 4000) - distanceT(0, 500, 4000);
    const farStep = distanceT(4000, 500, 4000) - distanceT(3500, 500, 4000);
    expect(nearStep).toBeGreaterThan(farStep * 3);
  });
  it('ramp interpolates near→far and gamma shapes it', () => {
    expect(rampNearFar(0, 12, 7, 1)).toBe(12);
    expect(rampNearFar(1, 12, 7, 1)).toBe(7);
    expect(rampNearFar(0.5, 12, 7, 2)).toBeGreaterThan(rampNearFar(0.5, 12, 7, 1));
  });
  it('fades out over the last band of range instead of popping', () => {
    expect(rangeFade(5000, 10_000, 0.15)).toBe(1);
    expect(rangeFade(9250, 10_000, 0.15)).toBeCloseTo(0.5, 5);
    expect(rangeFade(10_000, 10_000, 0.15)).toBe(0);
    expect(rangeFade(12_000, 10_000, 0.15)).toBe(0);
  });
});

describe('placement — on the inset track, direction-preserving, never near the centre', () => {
  const out = { x: 0, y: 0 };
  it('a contact due right lands on the right edge of the track at centre height', () => {
    placeOnTrack(5000, 300, W, H, TRACK, out);
    expect(out.x).toBeCloseTo(780, 5);
    expect(out.y).toBeCloseTo(300, 5);
  });
  it('a contact up-left lands on the track along the same bearing from centre', () => {
    placeOnTrack(-1000, -1000, W, H, TRACK, out);
    const bearingIn = Math.atan2(-1000 - 300, -1000 - 400);
    const bearingOut = Math.atan2(out.y - 300, out.x - 400);
    expect(bearingOut).toBeCloseTo(bearingIn, 6);
    expect(out.x === 20 || out.y === 20).toBe(true);
  });
  it('every placement is within the inset band — never in the play area', () => {
    for (let a = 0; a < Math.PI * 2; a += 0.1) {
      placeOnTrack(400 + Math.cos(a) * 3000, 300 + Math.sin(a) * 3000, W, H, TRACK, out);
      const onEdge =
        Math.abs(out.x - TRACK.left) < 1e-6 || Math.abs(out.x - TRACK.right) < 1e-6 ||
        Math.abs(out.y - TRACK.top) < 1e-6 || Math.abs(out.y - TRACK.bottom) < 1e-6;
      expect(onEdge).toBe(true);
    }
  });
});

describe('track perimeter parameterisation', () => {
  it('trackPoint ∘ trackParam round-trips on every edge', () => {
    const pt = { x: 0, y: 0 };
    const per = trackPerimeter(TRACK);
    for (let p = 0; p < per; p += 37) {
      trackPoint(p, TRACK, pt);
      expect(trackParam(pt.x, pt.y, TRACK)).toBeCloseTo(p, 4);
    }
  });
});

describe('HUD avoidance — blocked track intervals', () => {
  const insideAny = (pt: { x: number; y: number }, rects: Array<{ x: number; y: number; w: number; h: number }>, pad: number): boolean =>
    rects.some((r) => pt.x >= r.x - pad && pt.x <= r.x + r.w + pad && pt.y >= r.y - pad && pt.y <= r.y + r.h + pad);

  it('an icon under a bottom-right HUD cluster moves out of it', () => {
    const pt = { x: 0, y: 0 };
    const hud = [{ x: 600, y: 480, w: 200, h: 120 }];
    const blocked = new Float64Array(64);
    const n = buildBlockedIntervals(TRACK, hud, 6, blocked);
    const p = resolveBlocked(trackParam(780, 540, TRACK), blocked, n, trackPerimeter(TRACK));
    trackPoint(p, TRACK, pt);
    expect(insideAny(pt, hud, 5.9)).toBe(false);
  });

  it('an icon clear of every exclusion is untouched', () => {
    const blocked = new Float64Array(64);
    const n = buildBlockedIntervals(TRACK, [{ x: 600, y: 480, w: 200, h: 120 }], 6, blocked);
    const p0 = trackParam(400, 20, TRACK);
    expect(resolveBlocked(p0, blocked, n, trackPerimeter(TRACK))).toBe(p0);
  });

  it('STACKED HUD boxes (phone top-left: sector card above the shield bars) — the icon ends outside BOTH', () => {
    // Exact geometry measured on a Pixel 5 (393×727, edge inset 14): the old
    // per-rect slide ping-ponged between these two touching boxes and left
    // the icon on top of the sector-info text (user: "couldn't see the radar").
    const track: TrackRect = { left: 14, top: 14, right: 379, bottom: 713 };
    const hud = [{ x: 16, y: 16, w: 131, h: 72 }, { x: 16, y: 96, w: 91, h: 27 }];
    const pad = 10 * 1.25 * 0.5 + 6;
    const blocked = new Float64Array(64);
    const n = buildBlockedIntervals(track, hud, pad, blocked);
    const per = trackPerimeter(track);
    const pt = { x: 0, y: 0 };
    for (const [x, y] of [[14, 86], [14, 30], [14, 100], [60, 14], [140, 14]] as const) {
      trackPoint(resolveBlocked(trackParam(x, y, track), blocked, n, per), track, pt);
      expect(insideAny(pt, hud, pad - 0.1), `(${x},${y}) → (${pt.x.toFixed(1)},${pt.y.toFixed(1)})`).toBe(false);
    }
  });
});

describe('de-overlap along the edge', () => {
  it('pushes coincident icons apart to the minimum spacing, preserving order', () => {
    const p = new Float64Array([100, 100, 105, 300]);
    const order = new Int32Array(4);
    deOverlapAlongTrack(p, 4, 12, order);
    const sorted = [...p].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(12 - 1e-9);
    expect(p[3]).toBe(300); // far one untouched
  });
  it('treats the track as a loop: icons either side of the top-left seam do not touch', () => {
    const per = trackPerimeter(TRACK);
    const p = new Float64Array([0.5, per - 0.5]);
    const order = new Int32Array(2);
    deOverlapAlongTrack(p, 2, 4, order, new Float64Array([12, 12]), per);
    const seamGap = p[0]! + per - p[1]!;
    expect(seamGap).toBeGreaterThanOrEqual(12 + 2 - 1e-9);
  });
  it('never lets two icons touch, even when their sizes exceed the spacing preference', () => {
    const p = new Float64Array([100, 101]);
    const order = new Int32Array(2);
    deOverlapAlongTrack(p, 2, 4, order, new Float64Array([14, 12]));
    expect(Math.abs(p[1]! - p[0]!)).toBeGreaterThanOrEqual((14 + 12) / 2 + 2 - 1e-9);
  });
});
