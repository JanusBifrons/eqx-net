import { describe, it, expect } from 'vitest';
import { projectArrow, clamp, lerp, type HaloProjectionParams } from './HaloRadar';

const baseParams: HaloProjectionParams = {
  innerRadius: 100,
  outerRadius: 300,
  distMin: 200,
  distMax: 1000,
  scaleNear: 1.5,
  scaleFar: 0.5,
  visiblePadding: 0,
  // Bounds expressed in Pixi space (y-flipped). The local ship is at world
  // origin so its Pixi position is (0, 0); the visible square spans ±50 on
  // both axes — POIs further than 50 from origin are off-screen.
  visibleLeft: -50,
  visibleRight: 50,
  visibleTop: -50,
  visibleBottom: 50,
};

describe('HaloRadar projectArrow', () => {
  it('hides arrow when POI is on-screen', () => {
    const proj = projectArrow({ x: 0, y: 0 }, { x: 10, y: 10 }, baseParams);
    expect(proj.hidden).toBe(true);
  });

  it('hides arrow when POI sits exactly on the player (degenerate)', () => {
    const proj = projectArrow({ x: 0, y: 0 }, { x: 0, y: 0 }, baseParams);
    expect(proj.hidden).toBe(true);
  });

  it('places near-distance arrow at innerRadius and scaleNear', () => {
    // Place POI exactly at distMin world units east of player. Off-screen
    // (visible square only ±50, distMin = 200).
    const proj = projectArrow({ x: 0, y: 0 }, { x: 200, y: 0 }, baseParams);
    expect(proj.hidden).toBe(false);
    expect(proj.x).toBeCloseTo(100); // innerRadius east of player
    expect(proj.y).toBeCloseTo(0);
    expect(proj.scale).toBeCloseTo(1.5);
    expect(proj.rotation).toBeCloseTo(0);
  });

  it('places far-distance arrow at outerRadius and scaleFar', () => {
    // POI at or beyond distMax — clamps to t=1.
    const proj = projectArrow({ x: 0, y: 0 }, { x: 5000, y: 0 }, baseParams);
    expect(proj.hidden).toBe(false);
    expect(proj.x).toBeCloseTo(300); // outerRadius east of player
    expect(proj.y).toBeCloseTo(0);
    expect(proj.scale).toBeCloseTo(0.5);
  });

  it('places mid-distance arrow at lerped radius and scale', () => {
    // dist = 600, t = (600-200)/(1000-200) = 0.5
    // r = lerp(100, 300, 0.5) = 200
    // scale = lerp(1.5, 0.5, 0.5) = 1.0
    const proj = projectArrow({ x: 0, y: 0 }, { x: 600, y: 0 }, baseParams);
    expect(proj.hidden).toBe(false);
    expect(proj.x).toBeCloseTo(200);
    expect(proj.scale).toBeCloseTo(1.0);
  });

  it('flips world Y to Pixi Y for north-bearing POI', () => {
    // World north = +y; Pixi y for player at (0,0) is 0; arrow should sit at
    // Pixi y = -r (above the player on screen).
    const proj = projectArrow({ x: 0, y: 0 }, { x: 0, y: 600 }, baseParams);
    expect(proj.hidden).toBe(false);
    expect(proj.x).toBeCloseTo(0);
    expect(proj.y).toBeCloseTo(-200); // -(0 + sin(pi/2) * 200)
    // World theta = +pi/2; Pixi rotation = -pi/2.
    expect(proj.rotation).toBeCloseTo(-Math.PI / 2);
  });

  it('produces opposite-sign rotation for north vs south POIs', () => {
    const north = projectArrow({ x: 0, y: 0 }, { x: 0, y: 600 }, baseParams);
    const south = projectArrow({ x: 0, y: 0 }, { x: 0, y: -600 }, baseParams);
    expect(north.rotation).toBeCloseTo(-Math.PI / 2);
    expect(south.rotation).toBeCloseTo(Math.PI / 2);
  });

  it('respects visibility padding', () => {
    // POI at world (60, 0) — Pixi (60, 0). Outside visibleRight = 50.
    // Without padding it's off-screen. With padding 20 it's inside (50+20=70 > 60).
    const offScreen = projectArrow({ x: 0, y: 0 }, { x: 60, y: 0 }, baseParams);
    expect(offScreen.hidden).toBe(false);

    const padded = projectArrow(
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { ...baseParams, visiblePadding: 20 },
    );
    expect(padded.hidden).toBe(true);
  });

  it('clamps t below distMin to 0 (innerRadius)', () => {
    // POI at world (60, 0) — only just off-screen (visible square ±50, padding 0).
    // dist = 60, below distMin = 200, so t clamps to 0 → arrow at innerRadius.
    const proj = projectArrow({ x: 0, y: 0 }, { x: 60, y: 0 }, baseParams);
    expect(proj.hidden).toBe(false);
    expect(proj.x).toBeCloseTo(100);
    expect(proj.scale).toBeCloseTo(1.5);
  });

  it('orbits the player position, not the world origin', () => {
    // Player at (1000, 500); POI 600 east.
    const proj = projectArrow({ x: 1000, y: 500 }, { x: 1600, y: 500 }, {
      ...baseParams,
      // Visible bounds reset around the player's Pixi position (1000, -500).
      visibleLeft: 950,
      visibleRight: 1050,
      visibleTop: -550,
      visibleBottom: -450,
    });
    expect(proj.hidden).toBe(false);
    expect(proj.x).toBeCloseTo(1200); // 1000 + 200 (mid-radius)
    expect(proj.y).toBeCloseTo(-500); // Pixi y = -world y
  });
});

describe('HaloRadar math primitives', () => {
  it('clamp respects the bounds', () => {
    expect(clamp(0.5, 0, 1)).toBe(0.5);
    expect(clamp(-1, 0, 1)).toBe(0);
    expect(clamp(2, 0, 1)).toBe(1);
  });

  it('lerp interpolates linearly', () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(0, 10, 0.5)).toBe(5);
  });
});
