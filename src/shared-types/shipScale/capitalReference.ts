/**
 * Capital ships grounded in WW2 surface combatants (R&D, plan
 * eager-sauteeing-curry). The research is `docs/research/ww2-surface-combatants.md`;
 * this file is its data and the mapping into game numbers.
 *
 * What is copied from the real ships is the RATIOS between classes:
 *  - length and beam;
 *  - displacement (mass);
 *  - power-to-weight (acceleration);
 *  - turning circle;
 *  - near-flat top speed;
 *  - main-gun calibre (mount size).
 *
 * Absolute size, speed and timing come from a few anchors (`CapitalAnchors`),
 * so the whole class tunes together. `solveCapitalPhysics` turns a class's
 * targets into the catalogue's physics fields using the fixed-step damping
 * integration (`v ← (v + J/m) / (1 + d/60)` per tick).
 *
 * Pure data and math.
 */
import { shipAngularInertia } from './tuning.js';

export type CapitalClassId = 'destroyer' | 'light-cruiser' | 'heavy-cruiser' | 'battlecruiser' | 'battleship';
export type CapitalMountSize = 'S' | 'M' | 'L' | 'XL';

export interface Ww2Reference {
  example: string;
  lengthM: number;
  beamM: number;
  /** Full-load displacement, metric tonnes. */
  fullTonnes: number;
  shp: number;
  knots: number;
  /** Main-gun calibre, inches. */
  mainCalibreIn: number;
  mainGuns: number;
  mainTurrets: number;
  /** Tactical diameter in metres where documented (Fletcher, Iowa). */
  tacticalDiameterM?: number;
}

/** US ships, one per class: a consistent design school for the ratios. */
export const WW2_REFERENCE: Readonly<Record<CapitalClassId, Ww2Reference>> = {
  destroyer: { example: 'Fletcher', lengthM: 114.7, beamM: 12.1, fullTonnes: 2924, shp: 60_000, knots: 36.5, mainCalibreIn: 5, mainGuns: 5, mainTurrets: 5, tacticalDiameterM: 869 },
  'light-cruiser': { example: 'Cleveland', lengthM: 186, beamM: 20.2, fullTonnes: 14_131, shp: 100_000, knots: 32.5, mainCalibreIn: 6, mainGuns: 12, mainTurrets: 4 },
  'heavy-cruiser': { example: 'Baltimore', lengthM: 205.3, beamM: 21.6, fullTonnes: 17_000, shp: 120_000, knots: 33, mainCalibreIn: 8, mainGuns: 9, mainTurrets: 3 },
  battlecruiser: { example: 'Alaska', lengthM: 246.4, beamM: 27.8, fullTonnes: 34_253, shp: 150_000, knots: 32.5, mainCalibreIn: 12, mainGuns: 9, mainTurrets: 3 },
  battleship: { example: 'Iowa', lengthM: 270.4, beamM: 33, fullTonnes: 57_540, shp: 212_000, knots: 33, mainCalibreIn: 16, mainGuns: 9, mainTurrets: 3, tacticalDiameterM: 744 },
};

export const CAPITAL_CLASS_IDS: readonly CapitalClassId[] = ['destroyer', 'light-cruiser', 'heavy-cruiser', 'battlecruiser', 'battleship'];

/** Ratios to the destroyer (the research doc's table). */
export interface CapitalRatios {
  length: number;
  beam: number;
  mass: number;
  /** Power-to-weight relative to the destroyer (acceleration). */
  powerToWeight: number;
  speed: number;
  /** Tactical diameter in metres, interpolated by length between the two
   *  documented ships (Fletcher 869 m, Iowa 744 m). */
  tacticalDiameterM: number;
}

export function capitalRatios(id: CapitalClassId): CapitalRatios {
  const d = WW2_REFERENCE.destroyer, s = WW2_REFERENCE[id], b = WW2_REFERENCE.battleship;
  const pw = (r: Ww2Reference): number => r.shp / r.fullTonnes;
  const t = (s.lengthM - d.lengthM) / (b.lengthM - d.lengthM);
  return {
    length: s.lengthM / d.lengthM,
    beam: s.beamM / d.beamM,
    mass: s.fullTonnes / d.fullTonnes,
    powerToWeight: pw(s) / pw(d),
    speed: s.knots / d.knots,
    tacticalDiameterM: d.tacticalDiameterM! + (b.tacticalDiameterM! - d.tacticalDiameterM!) * t,
  };
}

/** Main battery calibre → mount size (5" S, 6–8" M, 12" L, 16"+ XL). */
export function mountSizeForCalibre(inches: number): CapitalMountSize {
  if (inches <= 5) return 'S';
  if (inches <= 8) return 'M';
  if (inches <= 12) return 'L';
  return 'XL';
}

/** The tunable anchors: a destroyer in game terms. Everything else follows
 *  the ratios. */
export interface CapitalAnchors {
  /** Destroyer length, world units. */
  destroyerLength: number;
  /** Destroyer top speed, world units / s. */
  destroyerSpeed: number;
  /** Seconds for a destroyer to reach 90% of top speed from rest. */
  destroyerAccelSeconds: number;
  /** Seconds for a destroyer to reach its full turn rate. */
  destroyerTurnResponseSeconds: number;
  /** Destroyer physics mass (collisions, ramming). */
  destroyerMass: number;
}

/**
 * The size mappings. Ratios between classes are the
 * same in both; only the anchors differ.
 *  - A, aircraft (rejected 2026-11-05): fighters treated as ~10 m aircraft
 *    (5 u/m) made a battleship ~28 fighters long. Kept only for comparison.
 *  - B, speedboat (the pick, 2026-11-05: "I expected the existing ships to be
 *    the size of speed boats in comparison"): today's 2× fighter (52 u) is a
 *    WW2 PT boat (24.4 m), so 2.13 u/m: destroyer 244 u (4.7 fighters),
 *    battleship 576 u (11 fighters).
 *  - C, 10× speedboat (round 3, 2026-11-05: "they feel at least 10x too
 *    small in comparison to the fighter"): destroyer 2,440 u, battleship
 *    5,760 u (~110 fighters). Slower to respond and 10× the mass.
 */
export const CAPITAL_MAPPINGS: Readonly<Record<'A' | 'B' | 'C', CapitalAnchors>> = {
  A: { destroyerLength: 575, destroyerSpeed: 60, destroyerAccelSeconds: 6, destroyerTurnResponseSeconds: 1, destroyerMass: 40 },
  B: { destroyerLength: 244, destroyerSpeed: 180, destroyerAccelSeconds: 4, destroyerTurnResponseSeconds: 0.75, destroyerMass: 40 },
  C: { destroyerLength: 2440, destroyerSpeed: 180, destroyerAccelSeconds: 8, destroyerTurnResponseSeconds: 2, destroyerMass: 400 },
};

/** A class's grounded targets in game units. */
export interface CapitalTargets {
  id: CapitalClassId;
  length: number;
  beam: number;
  mass: number;
  topSpeed: number;
  /** Seconds from rest to 90% of top speed. */
  accelSeconds: number;
  /** Turning circle diameter at top speed, world units. */
  turnDiameter: number;
  /** Seconds to reach the full turn rate from straight-ahead. */
  turnResponseSeconds: number;
  mainMountSize: CapitalMountSize;
}

export function capitalTargets(id: CapitalClassId, a: CapitalAnchors): CapitalTargets {
  const r = capitalRatios(id);
  const unitsPerMetre = a.destroyerLength / WW2_REFERENCE.destroyer.lengthM;
  return {
    id,
    length: a.destroyerLength * r.length,
    beam: a.destroyerLength * r.length * (WW2_REFERENCE[id].beamM / WW2_REFERENCE[id].lengthM),
    mass: a.destroyerMass * r.mass,
    topSpeed: a.destroyerSpeed * r.speed,
    // Same top speed, less power per tonne ⇒ proportionally longer to get there.
    accelSeconds: a.destroyerAccelSeconds / r.powerToWeight,
    turnDiameter: r.tacticalDiameterM * unitsPerMetre,
    // Rotational inertia grows with mass × length²; rudder authority with
    // length. Response time ∝ √(mass ratio) is the model's assumption.
    turnResponseSeconds: a.destroyerTurnResponseSeconds * Math.sqrt(r.mass),
    mainMountSize: mountSizeForCalibre(WW2_REFERENCE[id].mainCalibreIn),
  };
}

/** The catalogue physics fields for a set of targets. */
export interface CapitalPhysics {
  mass: number;
  linearDamping: number;
  thrustImpulse: number;
  /** Just above the terminal speed, so damping (not the clamp) sets it. */
  maxSpeed: number;
  /** Collider radius (half the length: the hull's circumscribing circle). */
  radius: number;
  /** Torque turning: inertia + angular damping give the response time and
   *  the top turn rate (top speed / turning radius). */
  angularDamping: number;
  turnTorque: number;
  /** Just above the terminal turn rate. */
  maxAngvel: number;
}

const TICK_HZ = 60;

/** Damping that reaches 90% of terminal in `seconds` at the fixed step:
 *  (1 + d/60)^-n = 0.1. */
function dampingFor(seconds: number): number {
  return TICK_HZ * (Math.pow(10, 1 / (seconds * TICK_HZ)) - 1);
}

export function solveCapitalPhysics(t: CapitalTargets): CapitalPhysics {
  const radius = t.length / 2;
  const d = dampingFor(t.accelSeconds);
  // Terminal speed: v∞ = (J/m) / (d/60).
  const thrustImpulse = t.topSpeed * t.mass * (d / TICK_HZ);
  const turnRate = t.topSpeed / (t.turnDiameter / 2);
  const da = dampingFor(t.turnResponseSeconds);
  // Terminal turn rate: ω∞ = (τ/I) / (da/60).
  const turnTorque = turnRate * shipAngularInertia(t.mass, radius) * (da / TICK_HZ);
  return {
    mass: t.mass, radius,
    linearDamping: d, thrustImpulse, maxSpeed: t.topSpeed * 1.02,
    angularDamping: da, turnTorque, maxAngvel: turnRate * 1.02,
  };
}

/** Speed after `seconds` of full thrust from rest, using the same per-tick
 *  integration as the physics step (for tests and the R&D page). */
export function speedAfter(p: CapitalPhysics, seconds: number): number {
  let v = 0;
  const ticks = Math.round(seconds * TICK_HZ);
  for (let i = 0; i < ticks; i++) v = Math.min(p.maxSpeed, (v + p.thrustImpulse / p.mass) / (1 + p.linearDamping / TICK_HZ));
  return v;
}
