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
import { addBeamLights, HEAVY_BEAM_STYLE, type BeamLightSink } from './beamStyles.js';

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

  it('the length light sits on the beam midpoint in Pixi space', () => {
    const s = sink();
    addBeamLights(s, beam);
    expect(s.lights[1]!.x).toBe(4000);
    expect(s.lights[1]!.y).toBe(265);
  });

  it('a heavy beam lights in its own colour, glowScale wider; a fighter beam in the default', () => {
    const s = sink();
    addBeamLights(s, beam);
    addBeamLights(s, { ...beam, style: null });
    expect(s.lights[0]!.color).toBe(HEAVY_BEAM_STYLE.tint);
    expect(s.lights[0]!.reach).toBe(360);
    expect(s.lights[2]!.color).toBe(0xff6a9a);
    expect(s.lights[2]!.reach).toBe(120);
  });
});
