/**
 * Per-effect default tuning. Populated incrementally by M3–M8 as each
 * effect lands; M1 ships the empty placeholders so the sandbox slider
 * panels (M10) and the per-effect Copy-JSON workflow have a single source
 * of truth to read from + write to.
 *
 * Plan: `~/.claude/plans/i-d-like-you-to-wiggly-puppy.md` §"Sandbox extension".
 */

import { SHIELD_RADIUS_PAD } from '../../../shared-types/shipKinds';

/** Tuned in M3 — Warp re-enable. */
export const DEFAULT_WARP_TONING = {
  spoolCount: 2, // was 4 pre-disable
  spoolAmplitude: 12, // was 24
  spoolBrightness: 1.06, // was 1.15
  climaxAmplitude: 70, // was 120
  bloomStrengthMax: 1.5, // was 4
  flashAlphaMax: 0.55, // was 0.9
} as const;

/** Tuned in M4 — Ship destruction. */
export const DEFAULT_DESTRUCTION_PARAMS = {
  particles: 35,
  lifetimeMs: 1200,
  shockwaveDurationMs: 250,
  scatter: 1.0,
} as const;

/** Tuned in M5 — Engine particles. Overhauled by the engine-fx pass
 *  (plan `majestic-pie`): per-kind nozzle anchoring + speed-scaled emission +
 *  velocity-coherent streaming + additive hot-core colour-over-life. */
export const DEFAULT_ENGINE_PARAMS = {
  thrustEmitRateHz: 60,
  thrustLifetimeMs: 350,
  thrustSpread: 0.25,
  boostEmitRateHz: 90,
  boostLifetimeMs: 500,
  boostSpread: 0.18,
  /** Nozzle-mouth width (game units, before per-kind `plumeScale`). Particles
   *  spawn across this width perpendicular to the thrust axis so the plume
   *  reads as an exhaust mouth, not a single point. */
  thrustNozzleWidth: 10,
  boostNozzleWidth: 8,
} as const;

/** Tuned in M6 — Laser glow. */
export const DEFAULT_LASER_GLOW_PARAMS = {
  outerStrength: 2,
  innerStrength: 1,
  quality: 0.2,
  colour: 0x00eeff,
  remoteColour: 0xff6600,
} as const;

/** Tuned in M7 — Impact sparks. */
export const DEFAULT_IMPACT_PARAMS = {
  particles: 10,
  lifetimeMs: 320,
  scatter: 1.2,
  shieldTint: 0x88ddff,
  hullTint: 0xff8844,
} as const;

/** Tuned in M8 — Shield aura.
 *
 *  `ringPad` is imported from `shared-types/shipKinds` so the visible
 *  shield aura, the physics ball collider (`World.spawnShip` /
 *  `setHullExposed`), and the server hit-test bounding circle
 *  (`SectorRoom.playerHitscanDist` / `playerProjectileSweep`) all use
 *  the SAME value. Without sharing, the three sites would inevitably
 *  drift apart on tuning passes. */
export const DEFAULT_SHIELD_PARAMS = {
  ringPad: SHIELD_RADIUS_PAD,
  baseAlpha: 0.18,
  breatheAmplitude: 0.08,
  breathePeriodMs: 1400,
  hitPulseAlpha: 0.55,
  hitPulseRiseMs: 80,
  hitPulseDecayMs: 250,
  glowOuterStrength: 1.5,
  glowInnerStrength: 0.8,
} as const;
