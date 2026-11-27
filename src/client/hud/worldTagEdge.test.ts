import { describe, expect, it } from 'vitest';
import { EMPTY_RADAR_INSETS, type RadarInsets } from '../../shared-types/settings/radar.js';
import { formatContactKm } from '../components/contactRows.js';
import {
  WORLD_TAG_EDGE_GAP_PX, distanceTextKey, placeWorldTagOnEdge, worldTagDistance, worldTagEdgeAt, worldTagWorldPoint,
} from './worldTagEdge.js';

const W = 800;
const H = 400;
const G = WORLD_TAG_EDGE_GAP_PX;

describe('placeWorldTagOnEdge', () => {
  it('rides the track inset by the tag half size, toward the anchor, arrow pointing at it', () => {
    expect(placeWorldTagOnEdge(-1000, 200, W, H, 50, 20, EMPTY_RADAR_INSETS)).toBe(true);
    expect(worldTagEdgeAt.x).toBe(50 + G);
    expect(worldTagEdgeAt.y).toBe(200);
    expect(worldTagEdgeAt.angle).toBeCloseTo(Math.PI); // pointing left
    placeWorldTagOnEdge(400, 5000, W, H, 50, 20, EMPTY_RADAR_INSETS);
    expect(worldTagEdgeAt.y).toBe(H - 20 - G);
    expect(worldTagEdgeAt.angle).toBeCloseTo(Math.PI / 2); // pointing down (screen y down)
  });

  it('keeps the bearing from the screen centre; the arrow aims at the anchor from the tag', () => {
    placeWorldTagOnEdge(1400, -300, W, H, 50, 20, EMPTY_RADAR_INSETS);
    // Ray from (400, 200) toward (1400, -300): slope -0.5, meets the top track first? top at y = 26 ⇒ x = 748 > right 744 ⇒ right edge.
    expect(worldTagEdgeAt.x).toBe(W - 50 - G);
    expect(worldTagEdgeAt.y).toBeCloseTo(200 - 0.5 * (744 - 400));
    expect(worldTagEdgeAt.angle).toBeCloseTo(Math.atan2(-300 - worldTagEdgeAt.y, 1400 - worldTagEdgeAt.x));
  });

  it('slides out of a HUD exclusion rect grown by the tag size', () => {
    // A widget on the right edge around y 150..250 (e.g. the fire cluster).
    const hud: RadarInsets = { ...EMPTY_RADAR_INSETS, exclusions: [{ x: 700, y: 150, w: 100, h: 100 }] };
    placeWorldTagOnEdge(2000, 200, W, H, 50, 20, hud);
    expect(worldTagEdgeAt.x).toBe(W - 50 - G);
    // Grown by the half height (20) + the gap: free above 150-26 or below 250+26.
    const clear = worldTagEdgeAt.y <= 150 - 20 - G + 0.1 || worldTagEdgeAt.y >= 250 + 20 + G - 0.1;
    expect(clear).toBe(true);
  });

  it('respects the right rail / top bar insets', () => {
    const hud: RadarInsets = { ...EMPTY_RADAR_INSETS, right: 60, top: 30 };
    placeWorldTagOnEdge(2000, 200, W, H, 50, 20, hud);
    expect(worldTagEdgeAt.x).toBe(W - 60 - 50 - G);
    placeWorldTagOnEdge(400, -2000, W, H, 50, 20, hud);
    expect(worldTagEdgeAt.y).toBe(30 + 20 + G);
  });

  it('no anchor or no room ⇒ false', () => {
    expect(placeWorldTagOnEdge(NaN, 0, W, H, 50, 20, EMPTY_RADAR_INSETS)).toBe(false);
    expect(placeWorldTagOnEdge(-100, 0, 0, 0, 50, 20, EMPTY_RADAR_INSETS)).toBe(false);
    expect(placeWorldTagOnEdge(-100, 0, 90, 400, 50, 20, EMPTY_RADAR_INSETS)).toBe(false);
  });
});

describe('worldTagDistance / worldTagWorldPoint', () => {
  it('converts screen px to world units by viewHalf along the larger side', () => {
    // viewHalf 800 over a 400 px half width ⇒ 2 units per px.
    expect(worldTagDistance(400 + 300, 200 + 400, W, H, 800)).toBeCloseTo(1000);
    expect(Number.isNaN(worldTagDistance(0, 0, W, H, 0))).toBe(true);
    const out = { x: 0, y: 0 };
    expect(worldTagWorldPoint(500, 100, W, H, 10, 20, 800, out)).toBe(true);
    expect(out).toEqual({ x: 10 + 200, y: 20 + 200 }); // screen up = game +y
    expect(worldTagWorldPoint(500, 100, W, H, 10, 20, 0, out)).toBe(false);
  });

  it('distanceTextKey changes exactly when formatContactKm text can', () => {
    for (const [a, b] of [[447, 452], [3240, 3260], [38_700, 39_200]] as const) {
      expect(distanceTextKey(a) === distanceTextKey(b)).toBe(formatContactKm(a) === formatContactKm(b));
    }
    expect(distanceTextKey(441)).not.toBe(distanceTextKey(447));
    expect(distanceTextKey(NaN)).toBe(-1);
  });
});
