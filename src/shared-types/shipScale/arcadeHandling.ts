/**
 * Arcade ("Micro Machines") handling + toughness layer (2026-11-13).
 *
 * Owner direction, verbatim: "I don't mind adjustments to the health, shields
 * and acceleration and handling to make it more like micro machines and make
 * fights a bit longer. Also don't forget the afterburner to gain speed fast..."
 * and the standing rule "Ships turning, acceleration, weapons, everything is
 * related to the ship, regardless of pilot." So this tunes SHIP KINDS: every
 * consumer (player `applyShipInput`, client prediction, the drone AI's
 * `ai.thrust` + `maxAngvel` turn) reads the result off the catalogue record.
 *
 * Applied by `defineShipKind` AFTER the size scale, as a per-handling-class
 * multiplier table instead of hand-editing every record:
 *
 *   - `damping` × linearDamping — the time constant. At the 2× default a
 *     fighter went from τ ≈ 4.7 s (≈5 s to reach cruise) to τ ≈ 0.26 s.
 *   - thrustImpulse and `ai.thrust` are re-solved so the CRUISE TERMINAL
 *     SPEED IS UNCHANGED (v* = F / (1 − e^(−d/60)) at the fixed 60 Hz step),
 *     so weapon leads, AI standoffs and the `maxSpeed` cap keep their meaning.
 *     The afterburner (`boostMultiplier`, unchanged) now reaches its boosted
 *     terminal in well under a second instead of never.
 *   - `turn` × maxAngvel — fighters swing the nose round 180° in ~0.75 s.
 *   - `grip` × lateralGrip — a lower grip keeps a visible slide when turning
 *     at speed (the high damping already eats lateral velocity).
 *   - `tough` × maxHealth / shieldMax / shieldRegenRate — fights last
 *     ~1.6–1.75× longer; regen TIME to full is held (rate scales with the max).
 *
 * Exempt (unchanged): engineering test rigs, immobile / passive kinds (no
 * afterburner: the robot nexus, loot pods) and capitals, which are authored
 * by their own WW2-grounded solver (`capitalReference.ts`).
 *
 * Measured before/after: `src/core/physics/ShipHandling.arcade.test.ts`
 * (`EQX_HANDLING_REPORT=1`), story in docs/architecture/ship-physics-handling.md
 * "Arcade (Micro Machines) tuning, 2026-11-13".
 */
import type { ShipKind } from '../shipKinds/types.js';

export type HandlingClass = 'light' | 'medium' | 'heavy' | 'capital' | 'exempt';

export interface ArcadeTuning {
  /** × linearDamping (time constant; thrust re-solved to keep cruise). */
  damping: number;
  /** × maxAngvel. */
  turn: number;
  /** × lateralGrip. */
  grip: number;
  /** × maxHealth, shieldMax and shieldRegenRate. */
  tough: number;
}

export const ARCADE_HANDLING: Readonly<Record<HandlingClass, ArcadeTuning>> = {
  light: { damping: 16, turn: 4.2, grip: 1, tough: 1.6 },
  medium: { damping: 18, turn: 4.2, grip: 1, tough: 1.75 },
  heavy: { damping: 18, turn: 4.2, grip: 1, tough: 1.75 },
  capital: { damping: 1, turn: 1, grip: 1, tough: 1 },
  exempt: { damping: 1, turn: 1, grip: 1, tough: 1 },
};

/** Light ≤ 120 authored hull, medium ≤ 220, heavy above. Read off the
 *  AUTHORED record (the class must not move when `tough` raises the hull). */
export function classifyHandling(raw: Pick<ShipKind, 'maxHealth' | 'boostMultiplier' | 'engineeringOnly' | 'sizeClass' | 'turnTorque'>): HandlingClass {
  if (raw.engineeringOnly) return 'exempt';
  if (raw.sizeClass === 'capital' || raw.turnTorque !== undefined) return 'capital';
  if (raw.boostMultiplier <= 1) return 'exempt';
  if (raw.maxHealth <= 120) return 'light';
  if (raw.maxHealth <= 220) return 'medium';
  return 'heavy';
}

const CLASS_OF = new Map<string, HandlingClass>();

/** A catalogue kind's handling class (recorded by `applyArcadeHandling`). */
export function handlingClassOf(kind: Pick<ShipKind, 'id'>): HandlingClass {
  return CLASS_OF.get(kind.id) ?? 'exempt';
}

/**
 * Apply the arcade layer to a (scaled) catalogue kind. `raw` is the authored
 * record, which picks the class. Pure; exempt kinds come back unchanged.
 */
export function applyArcadeHandling(kind: ShipKind, raw: ShipKind): ShipKind {
  const cls = classifyHandling(raw);
  CLASS_OF.set(kind.id, cls);
  const t = ARCADE_HANDLING[cls];
  if (t.damping === 1 && t.turn === 1 && t.grip === 1 && t.tough === 1) return kind;
  // Same cruise terminal. Rapier scales velocity by 1 / (1 + d·dt) each step,
  // so a per-tick impulse a settles at v* = a / (d·dt): thrust scales with
  // damping exactly. The drone AI's `ai.thrust` uses the same body damping.
  const k = t.damping;
  const maxHealth = Math.round(kind.maxHealth * t.tough);
  const shieldMax = Math.round(kind.shieldMax * t.tough);
  return {
    ...kind,
    linearDamping: kind.linearDamping * k,
    thrustImpulse: kind.thrustImpulse * k,
    ai: { ...kind.ai, thrust: kind.ai.thrust * k },
    maxAngvel: kind.maxAngvel * t.turn,
    lateralGrip: kind.lateralGrip * t.grip,
    maxHealth,
    shieldMax,
    // Regen TIME to full held: the rate follows the max.
    shieldRegenRate: kind.shieldMax > 0 ? kind.shieldRegenRate * (shieldMax / kind.shieldMax) : kind.shieldRegenRate,
  };
}
