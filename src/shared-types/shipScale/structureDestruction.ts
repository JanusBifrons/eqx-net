/**
 * The structure destruction profile (structure break-up), kept out of
 * `destruction.ts` for its 600-LOC ceiling. A builder, not a constant: it
 * borrows the sub-capital and no-wreck profiles, which `destruction.ts`
 * owns, so this file imports types only (no import cycle).
 */
import type { DestructionFractureOptions, DestructionProfile } from './destruction.js';

/** A destroyed structure (structure break-up; capital-destruction.md
 *  "Structures"). Never a ship's profile: a structure's wreck source
 *  (`structureWreckSource`) names it. It shatters from the kill point in
 *  wedges (`radialCracks`: a structure is squarish, so the keel-wise zone
 *  and fan cracks of a long hull left it in 2), in fixed-count mode (no
 *  damage inputs, like a rock), capped by area (`pieceSide` 30: a 64 u
 *  connector 2 pieces, a 120-160 u turret or pylon 4-5, anything from
 *  ~180 u up 6). Its pieces part, drift and settle like a ship wreck OF
 *  ITS SIZE (`structurePartScale`; each wedge at a sub-cap half's
 *  speed: `separateFromKill`; lock: server/rooms/structureWreckDrift.test.ts)
 *  and collide with each other; shots never shove them (knock 0). A piece
 *  wears and re-splits like a sub-capital's: halves into two, a quarter or
 *  less becomes salvage, a whole hull worth √area ÷ 3 (fighter 10, destroyer 200).
 *  It snaps cleanly in two at a ship's rate, else reaches its cap. */
export function structureProfile(SUBCAP: DestructionProfile, NONE: DestructionProfile): DestructionProfile {
  const STRUCTURE_FRACTURE: DestructionFractureOptions = {
    maxPieces: 6, snapChance: SUBCAP.fracture!.snapChance, fanCracks: false, farCrack: false, chunkyPieces: false,
    jag: { depth: 2, roughness: 0.12 }, pieceSide: 30, radialCracks: true,
  };
  return {
    id: 'structure',
    fracture: STRUCTURE_FRACTURE,
    resplit: { ...SUBCAP.resplit!, salvagePerSqrtArea: 1 / 3 },
    holdMs: 0,
    pushScale: SUBCAP.pushScale,
    separateScale: SUBCAP.separateScale,
    separateFromKill: true,
    crackScale: SUBCAP.crackScale,
    spinScale: SUBCAP.spinScale,
    cutPartSpeed: SUBCAP.cutPartSpeed,
    dampingScale: SUBCAP.dampingScale,
    knockScale: 0,
    knockMaxScale: 0,
    knockWakeScale: 0,
    settlePerRadius: 0.125,
    settleSpin: 0.3,
    piecesCollide: true,
    // Its pieces wear the structure's own art, burnt like a dead capital's
    // (owner: "go dark like a dead hull"; `burntTint`).
    fx: { ...NONE.fx, glowStyle: 'simple', glowSeconds: 1, cutGlowStyle: 'full', burntArt: true },
  };
}
