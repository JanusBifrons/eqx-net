/**
 * Beam draw-band derivation (campaign 5.2 — anti-patterns review A9
 * fragility / Part D #10).
 *
 * The client's visible beam bands are DERIVED from the weapon catalogue def —
 * never from a parallel client constant. History: the "laser renders
 * infinitely" family took three iterations partly because the client visual
 * band and the server damage band were two hand-synchronised constants; P3.13
 * moved the draw math onto `wdef.range` / `wdef.falloff.maxRangeMul`, but the
 * derivation lived inline in `ColyseusClient.updateLiveBeam` where no unit
 * test could lock it. This module is that seam: the SINGLE place the bands
 * come from, unit-locked so a catalogue tuning moves the drawn band and a
 * re-introduced parallel constant fails the lock.
 *
 * Bands (matching the server's linear "optimal + beyond" falloff):
 *   - OPTIMAL = `wdef.range` — full damage out to here; == the aim guide.
 *   - MAX     = `range × falloff.maxRangeMul` — where the ray (and damage
 *               fringe) ends; absent/≤1 falloff ⇒ MAX == OPTIMAL.
 *   - The no-hit SOLID core is `optimal × VISUAL_BEAM_SOLID_FRAC` (a purely
 *     visual style knob with NO server counterpart — the fade from there to
 *     MAX never feeds damage).
 *
 * All functions are scalar-in/scalar-out and alloc-free — they run per mount
 * per frame inside `updateLiveBeam` (invariant #14).
 */
import type { WeaponDef } from '../../core/combat/WeaponCatalogue.js';
import { HITSCAN_RANGE } from '../../core/combat/Weapons.js';

/** Fraction of the OPTIMAL range the no-hit beam stays fully solid before the
 *  long visual fade to nothing at MAX range. Visual-only (never damage). */
export const VISUAL_BEAM_SOLID_FRAC = 0.4;

/** The full-strength band — `wdef.range` for hitscan (== the aim guide);
 *  the legacy `HITSCAN_RANGE` fallback for non-hitscan defs. */
export function beamOptimalDist(wdef: WeaponDef): number {
  return wdef.mode === 'hitscan' ? wdef.range : HITSCAN_RANGE;
}

/** How far the beam reaches — `range × falloff.maxRangeMul` when the def
 *  carries a beyond-optimal fringe, else the optimal range. The SAME numbers
 *  the server's damage falloff reads, so the visible taper == the damage band
 *  by construction. */
export function beamMaxDist(wdef: WeaponDef): number {
  const optimal = beamOptimalDist(wdef);
  if (wdef.mode === 'hitscan' && wdef.falloff?.maxRangeMul && wdef.falloff.maxRangeMul > 1) {
    return wdef.range * wdef.falloff.maxRangeMul;
  }
  return optimal;
}

/** Solid-core length for a NO-HIT beam (a hit beam is solid to the target —
 *  the caller passes `drawDist` so the core never exceeds the drawn length). */
export function beamNoHitSolidDist(optimalDist: number, drawDist: number): number {
  return Math.min(optimalDist * VISUAL_BEAM_SOLID_FRAC, drawDist);
}
