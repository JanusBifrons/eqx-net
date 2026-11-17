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
  HEAVY_BEAM_STYLE, BeamHitMemory, type BeamLightSink,
} from './beamStyles.js';
import type { BeamView } from './BeamSpritePool.js';

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
    const f = s.lights[HEAVY_BEAM_MAX_LIGHTS]!;
    expect(f.color).toBe(0xff6a9a);
    expect(f.reach).toBe(120);
  });
});

/** Line light `l`'s brightness on a flat deck (normal straight up) `d` u from
 *  the point under it: the lit shader's point light (`litShipShader.ts`:
 *  intensity × (1 − (dist/reach)²)², × n·L). */
function deckLight(l: L, d: number): number {
  const dist = Math.hypot(d, l.z);
  const k = dist / l.reach;
  const w = Math.max(0, Math.min(1, 1 - k * k));
  return l.intensity * w * w * (l.z / dist);
}

/**
 * Owner 2026-11-15: "could use lighting so it gives a purple glow on ships
 * nearby, it's a light source." It lit only its hit and one soft light at its
 * middle. The heavy beam now lights its length in deep violet: lights at fixed
 * distances from the muzzle (the shooter) and one at the hit (the target),
 * within the per-beam light budget.
 */
describe('heavy beam: a violet light source at the muzzle, along the beam and at the hit', () => {
  const beam = { fromX: 0, fromY: 0, toX: 3000, toY: 0, style: HEAVY_BEAM_STYLE };
  const violet = (c: number): boolean => {
    const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
    return b > r && r > g && (b - g) / b > 0.7;
  };

  it('line lights start at the muzzle, evenly spaced and overlapping, so the shooter glows', () => {
    const s = sink();
    addBeamLights(s, { ...beam, toX: 8000 });
    const line = s.lights.slice(1);
    expect(line.length).toBeGreaterThanOrEqual(3);
    const xs = line.map((l) => l.x).sort((a, b) => a - b);
    const gap = xs[1]! - xs[0]!;
    for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeCloseTo(gap, 6);
    expect(xs[0]!).toBe(0); // one at the muzzle: the shooter's own hull glows
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

  // Hostile film review 2026-11-15 (beam take 6): on the kill frame the
  // follow-through beam runs on past the dead target to full range (20 km),
  // and the SHOOTER's whole hull went flat violet up to its bow. The line
  // lights were spaced as shares of the beam's length, so a longer beam moved
  // them and widened their reach (a 4.4 km muzzle light). They now sit at
  // fixed distances from the muzzle with a fixed reach: lengthening the beam
  // moves only the hit light, never the light on the shooter.
  it('the shooter-side lights are identical for an 8 km and a 20 km beam on the same line', () => {
    for (const budget of [beamLightBudget(8), beamLightBudget(4)]) {
      const a = sink(), b = sink();
      addBeamLights(a, { ...beam, fromX: 100, fromY: -250, toX: 8100, toY: -250 }, budget);
      addBeamLights(b, { ...beam, fromX: 100, fromY: -250, toX: 20_100, toY: -250 }, budget);
      // Index 0 is the hit light; the rest are the line lights.
      expect(b.lights.slice(1), `budget ${budget}`).toEqual(a.lights.slice(1));
      expect(b.lights[0]!.x).toBe(20_100);
      expect(b.lights[0]!.intensity).toBe(a.lights[0]!.intensity);
      expect(b.lights[0]!.reach).toBe(a.lights[0]!.reach);
    }
  });

  it('line lights reach no further on a longer beam, and none washes over the hit point', () => {
    for (const len of [3000, 8000, 20_000]) {
      const s = sink();
      addBeamLights(s, { ...beam, toX: len });
      for (const l of s.lights.slice(1)) {
        expect(l.reach, `${len} u`).toBeLessThanOrEqual(1200);
        if (l.x > 0) expect(len - l.x, `${len} u: light at ${l.x} clear of the hit`).toBeGreaterThanOrEqual(l.reach);
      }
    }
  });

  // Same review: the target read as a flat lilac wash over ~60 % of a cruiser,
  // its far side as bright as the side the beam hit. The hit light is a spot:
  // bright at the hit, clearly fading across the hull, gone within ~700 u.
  it('the hit light falls off clearly from the hit point (lit from one point, not a wash)', () => {
    for (const len of [3000, 8000, 20_000]) {
      const s = sink();
      addBeamLights(s, { ...beam, toX: len });
      const hit = s.lights[0]!;
      const at0 = deckLight(hit, 0);
      expect(at0, 'bright at the hit').toBeGreaterThanOrEqual(3);
      let prev = at0;
      for (let d = 50; d <= 1000; d += 50) {
        const v = deckLight(hit, d);
        expect(v, `${d} u`).toBeLessThanOrEqual(prev);
        prev = v;
      }
      expect(deckLight(hit, 200) / at0, 'half-ish 200 u off').toBeLessThan(0.65);
      expect(deckLight(hit, 400) / at0, 'faint 400 u off').toBeLessThan(0.25);
      expect(deckLight(hit, 800), 'nothing 800 u off').toBe(0);
    }
  });

  it('respects the tier budget: fewer lights when hulls take only 4', () => {
    expect(beamLightBudget(8)).toBe(HEAVY_BEAM_MAX_LIGHTS);
    expect(beamLightBudget(4)).toBe(HEAVY_BEAM_MAX_LIGHTS_LOW);
    expect(HEAVY_BEAM_MAX_LIGHTS).toBeLessThanOrEqual(8);
    const s = sink();
    addBeamLights(s, { ...beam, toX: 20_000 }, beamLightBudget(4));
    expect(s.lights.length).toBe(HEAVY_BEAM_MAX_LIGHTS_LOW);
    const t = sink();
    addBeamLights(t, { ...beam, toX: 20_000 });
    expect(t.lights.length).toBe(HEAVY_BEAM_MAX_LIGHTS);
  });

  it('a short beam adds few lights: the hit and the muzzle', () => {
    const s = sink();
    addBeamLights(s, { ...beam, toX: 500 });
    expect(s.lights.length).toBe(2);
    expect(s.lights[1]!.x).toBe(0);
  });
});

/**
 * Hostile film review 2026-11-15 (beam take 7): on the frame after the kill
 * the heavy cruiser's violet light went out (hull back to plain grey) while the
 * follow-through beam burned on through the wreck at full strength for ~1.1 s.
 * The follow-through pulses run through the burned gap, so they have no hit (`laser.hit`
 * false, end at max range): no hit spot, and the line lights from the muzzle
 * (at most 4–6 × 900 u) never reach an 8 km target. The beam still crosses the
 * wreck, so the cut stays lit where it crosses (`BeamHitMemory`), until the
 * beam stops.
 */
describe('heavy beam follow-through: the cut stays lit while the beam burns through it', () => {
  // Kill pulse: muzzle (0, -250) to the hit at (8000, -280). Follow-through:
  // the same line on to its 20 km range, no hit.
  const kill = { fromX: 0, fromY: -250, toX: 8000, toY: -280 };
  const through = { fromX: 0, fromY: -250, toX: 20_000, toY: -250 + (-30 * 20_000) / 8000 };
  function view(l: typeof kill): BeamView {
    return { ...l, style: HEAVY_BEAM_STYLE };
  }

  it('a no-hit pulse after a hit on the same line keeps the hit spot at the hit point; shooter lights unchanged', () => {
    const mem = new BeamHitMemory();
    const v = view(kill);
    mem.track('swarm-7', 'hb0', true, v);
    const atKill = sink();
    addBeamLights(atKill, v);
    mem.endFrame();
    for (let frame = 0; frame < 45; frame++) {
      Object.assign(v, through);
      mem.track('swarm-7', 'hb0', false, v);
      const s = sink();
      addBeamLights(s, v);
      const spot = s.lights[0]!;
      expect(spot.x, `frame ${frame}`).toBeCloseTo(8000, 0);
      expect(spot.y, `frame ${frame}`).toBeCloseTo(280, 0); // Pixi space
      // The hit spot's own falloff (tight, not a line light).
      expect(spot.intensity).toBe(atKill.lights[0]!.intensity);
      expect(spot.reach).toBe(atKill.lights[0]!.reach);
      expect(spot.z).toBe(atKill.lights[0]!.z);
      // The shooter-side lights are the fixed-distance ones, as on any beam.
      const plain = sink();
      addBeamLights(plain, { ...through, style: HEAVY_BEAM_STYLE });
      expect(s.lights.slice(1)).toEqual(plain.lights.slice(1));
      expect(s.lights.length).toBe(plain.lights.length); // within the budget
      mem.endFrame();
    }
  });

  it('goes out with the beam: after a frame without the beam, a later no-hit pulse does not light the old hit', () => {
    const mem = new BeamHitMemory();
    const v = view(kill);
    mem.track('swarm-7', 'hb0', true, v);
    mem.endFrame();
    mem.endFrame(); // the beam stopped: no track this frame
    Object.assign(v, through);
    mem.track('swarm-7', 'hb0', false, v);
    const s = sink();
    addBeamLights(s, v);
    expect(s.lights[0]!.x).toBe(20_000);
  });

  it('a miss on another line (the turret swung off) does not light the old hit', () => {
    const mem = new BeamHitMemory();
    const v = view(kill);
    mem.track('swarm-7', 'hb0', true, v);
    mem.endFrame();
    Object.assign(v, { fromX: 0, fromY: -250, toX: 0, toY: 19_750 });
    mem.track('swarm-7', 'hb0', false, v);
    const s = sink();
    addBeamLights(s, v);
    expect(s.lights[0]!.x).toBe(0);
    expect(s.lights[0]!.y).toBe(-19_750);
  });

  it("another mount's or shooter's hit lights nothing on this beam", () => {
    const mem = new BeamHitMemory();
    const other = view(kill);
    mem.track('swarm-7', 'hb1', true, other);
    mem.track('swarm-9', 'hb0', true, view(kill));
    mem.endFrame();
    const v = view(through);
    mem.track('swarm-7', 'hb0', false, v);
    const s = sink();
    addBeamLights(s, v);
    expect(s.lights[0]!.x).toBe(20_000);
  });
});
