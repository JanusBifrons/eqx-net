/**
 * Regression lock — a beam lights what it hits, in the lit scene's Pixi space.
 *
 * Film review (2026-11-15, beam-slice v3): while the heavy beam burned the
 * heavy cruiser, the whole wreck slab between a crack and the cut turned a
 * hard rose/violet wash that vanished the frame the beam stopped, and the
 * lower piece the beam actually hit got none.
 *
 * Cause: the beam lights went to the lit scene in GAME space (y up) while the
 * scene and every other light (shells, missiles, blasts) are in PIXI space
 * (y down: pixiY = -gameY). The lights sat at the beam's Y mirror. The victim
 * spawned on the sector's x axis (y = 0) and was cut ~280 u below it, so the
 * hit light (reach 120 u × glowScale 3 = 360 u) sat ~560 u up the hull on the
 * slab above, out of reach of the piece it hit.
 */
import { describe, it, expect } from 'vitest';
import {
  addBeamLights, beamLightBudget, HEAVY_BEAM_DEEP_COLOR, HEAVY_BEAM_LINE_LIGHT, HEAVY_BEAM_MAX_LIGHTS, HEAVY_BEAM_MAX_LIGHTS_LOW,
  HEAVY_BEAM_STYLE, type BeamLightSink,
} from './beamStyles.js';

interface L { x: number; y: number; z: number; color: number; intensity: number; reach: number }
function sink(): BeamLightSink & { lights: L[] } {
  const lights: L[] = [];
  return { lights, addLight(x, y, z, color, intensity, reach) { lights.push({ x, y, z, color, intensity, reach }); } };
}

describe('beam lights (lit scene, Pixi space)', () => {
  // A heavy beam from a battlecruiser at game (0, -250) hits a cruiser's hull
  // at game (8000, -280): 280 u below the x axis, as filmed.
  const beam = { fromX: 0, fromY: -250, toX: 8000, toY: -280, style: HEAVY_BEAM_STYLE };

  it('the hit light sits on the hit point in Pixi space (y flipped), not its Y mirror', () => {
    const s = sink();
    addBeamLights(s, beam);
    const hitLight = s.lights[0]!;
    expect(hitLight.x).toBe(8000);
    expect(hitLight.y).toBe(280); // pixiY = -gameY
    // The hit piece is inside the light's reach (it was 560 u off, past 360).
    expect(Math.hypot(hitLight.x - beam.toX, hitLight.y - -beam.toY)).toBe(0);
  });

  it("a fighter beam's length light sits on the beam midpoint in Pixi space", () => {
    const s = sink();
    addBeamLights(s, { ...beam, style: null });
    expect(s.lights[1]!.x).toBe(4000);
    expect(s.lights[1]!.y).toBe(265);
  });

  it('a heavy beam lights in its own colour, glowScale wider; a fighter beam in the default', () => {
    const s = sink();
    addBeamLights(s, beam);
    addBeamLights(s, { ...beam, style: null });
    expect(s.lights[0]!.color).toBe(HEAVY_BEAM_LINE_LIGHT.color);
    expect(s.lights[0]!.reach).toBe(s.lights[1]!.reach); // the hit light reaches as far as the line
    const f = s.lights[HEAVY_BEAM_MAX_LIGHTS]!;
    expect(f.color).toBe(0xff6a9a);
    expect(f.reach).toBe(120);
  });
});

/**
 * Owner 2026-11-15: "could use lighting so it gives a purple glow on ships
 * nearby, it's a light source." It lit only its hit and one soft light at its
 * middle. The heavy beam now lights its WHOLE length in deep violet: lights
 * spaced muzzle to hit, overlapping, within the per-beam light budget.
 */
describe('heavy beam: a violet light along its whole length', () => {
  const beam = { fromX: 0, fromY: 0, toX: 3000, toY: 0, style: HEAVY_BEAM_STYLE };
  const violet = (c: number): boolean => {
    const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
    return b > r && r > g && (b - g) / b > 0.7;
  };

  it('lights run evenly from the muzzle to the hit, overlapping, so no stretch of the beam is dark', () => {
    const s = sink();
    addBeamLights(s, beam);
    const line = s.lights.slice(1);
    expect(line.length).toBeGreaterThanOrEqual(3);
    const xs = line.map((l) => l.x).sort((a, b) => a - b);
    const gap = xs[1]! - xs[0]!;
    for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeCloseTo(gap, 6);
    expect(xs[0]!).toBe(0); // one at the muzzle: the shooter's own hull glows
    expect(3000 - xs[xs.length - 1]!).toBeCloseTo(gap, 6); // the hit light closes the last gap
    for (const l of line) {
      expect(l.y).toBeCloseTo(0, 9); // on the line (Pixi space)
      expect(l.reach, 'overlaps its neighbour').toBeGreaterThan(gap * 0.5);
      // A hull ~400 u off the beam is still well inside a light's reach.
      expect(l.reach).toBeGreaterThan(400);
    }
  });

  it('every light is deep violet and strong enough to tint a hull', () => {
    const s = sink();
    addBeamLights(s, beam);
    expect(HEAVY_BEAM_LINE_LIGHT.color).toBe(HEAVY_BEAM_DEEP_COLOR);
    for (const l of s.lights) {
      expect(violet(l.color)).toBe(true);
      expect(l.intensity).toBeGreaterThanOrEqual(1.2); // a missile light is 1.2
    }
  });

  it('a 20 km beam still covers its whole length within the light budget', () => {
    const s = sink();
    addBeamLights(s, { ...beam, toX: 20_000 });
    expect(s.lights.length).toBe(HEAVY_BEAM_MAX_LIGHTS);
    const line = s.lights.slice(1);
    const gap = 20_000 / line.length;
    for (const l of line) expect(l.reach).toBeGreaterThan(gap * 0.5);
  });

  it('respects the tier budget: fewer lights when hulls take only 4', () => {
    expect(beamLightBudget(8)).toBe(HEAVY_BEAM_MAX_LIGHTS);
    expect(beamLightBudget(4)).toBe(HEAVY_BEAM_MAX_LIGHTS_LOW);
    expect(HEAVY_BEAM_MAX_LIGHTS).toBeLessThanOrEqual(8);
    const s = sink();
    addBeamLights(s, { ...beam, toX: 20_000 }, beamLightBudget(4));
    expect(s.lights.length).toBe(HEAVY_BEAM_MAX_LIGHTS_LOW);
  });

  it('a short beam adds few lights (one per spacing)', () => {
    const s = sink();
    addBeamLights(s, { ...beam, toX: 500 });
    expect(s.lights.length).toBe(2); // hit + one line light
  });
});
