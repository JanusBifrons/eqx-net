/**
 * Force fields — one list of areas that push dynamic bodies each fixed step
 * (`PhysicsWorld.setForceField` / `removeForceField`). The server worker and
 * the client's prediction world run the same list, so a pushed ship never
 * judders (#15). Guide: docs/architecture/physics-worker.md "Force fields".
 *
 * Each kind declares whether it is **mass-scaled**:
 * - `massScaled: true` — the field sets an ACCELERATION; the per-step impulse
 *   is `mass × accel × dt`, so every body moves the same whatever its mass
 *   (a teleporter pad's closing push).
 * - `massScaled: false` — the field sets a FORCE; the per-step impulse is
 *   `force × dt`, so a heavy body barely moves ("mass still matters": a
 *   future tractor beam).
 *
 * Only the `pad` kind exists today; tractor beams and gravity wells join the
 * union as new kinds.
 */

/** v4 T2 — a teleporter pad's closing-iris push: every dynamic body
 *  straddling the pad edge (square, half-size `half`, centred on cx, cy) is
 *  nudged fully in or fully out (`padPushDir`) while `active`. */
export interface PadForceField {
  kind: 'pad';
  cx: number;
  cy: number;
  half: number;
  active: boolean;
}

export type ForceField = PadForceField;
export type ForceFieldKind = ForceField['kind'];

/** Per kind: does the field scale its push by the target's mass? */
export const FORCE_FIELD_MASS_SCALED: Readonly<Record<ForceFieldKind, boolean>> = {
  pad: true,
};
