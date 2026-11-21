/**
 * Weapon-aware engagement profile (weapons/energy/AI overhaul §4): how a
 * ship fights with its bound weapon. Filled once in the brain's constructor
 * from the kind (no per-tick allocation, no wire divergence — all derived
 * from the kind). The role adjustments that follow from it stay in the brain.
 */
import type { ShipKind } from '../../../shared-types/shipKinds.js';
import { getWeapon, type WeaponMode } from '../../combat/WeaponCatalogue.js';
import { hasTurretFireControl, mountWeaponReach } from '../../combat/mountReach.js';
import { BROADSIDE_STANDOFF } from '../hostileDroneTuning.js';
import { LOCK_TUNING } from '../../../shared-types/combat/lockProfile.js';
import type { TravelFireTune } from '../modes/travelMode.js';

export interface EngagementProfile extends TravelFireTune {
  /** Mode of the drone's bound weapon (first mount). Drives the steering
   *  branch in tickCombat. */
  readonly weaponMode: WeaponMode;
  /** The bound weapon winds up a 'locked-direction' charge, through which
   *  the pilot holds its line (`view.isCharging`). Such a wind-up starts only
   *  outside the attack run's pull-off distance (`_tac.overshoot`). */
  readonly chargeHoldsLine: boolean;
  /** Distance (world units) at/under which the drone fires. Beam → very
   *  close (~225); bolt → medium (~560); missile → long (~1400). */
  readonly fireRange: number;
  /** STOP_DIST = fireRange × this. Beam bores in (0.5); bolt dogfights
   *  (0.6); missile kites far (0.9). */
  readonly stopDistFactor: number;
  /** Missile only: actively thrust AWAY when the target closes inside
   *  fireRange × this (artillery "stay away when engaging"). 0 for
   *  beam/bolt. */
  readonly backoffInsideFactor: number;
  /** Muzzle speed used for the lead-aim time-to-target (`t = dist /
   *  leadMuzzleSpeed`). The bound weapon's REAL projectile speed for
   *  bolts/missiles (so the bolt is actually aimed at the intercept
   *  point); a huge value for hitscan so `t ≈ 0` (instantaneous beams
   *  need no lead). 2026-06-03 — replaces the single hardcoded
   *  LEAD_AIM_MUZZLE_SPEED, which 2×-over-led the 1600 u/s bolt. */
  readonly leadMuzzleSpeed: number;
  /** The shot's own radius (a bolt sweeps a circle; 0 for a beam): widens the
   *  hull cone a fixed gun fires inside. */
  readonly shotRadius: number;
  /** Phase 4c (2026-05-11) — half-arc of the widest rotating mount in
   *  this kind's primary slot, used to widen the body-aim fire gate so
   *  drones with turrets fire even when the body is off-aim by less than
   *  the mount's reach. For single-mount legacy kinds (zero arc) this is
   *  0 and the gate collapses to the pre-4c body-only tolerance. */
  readonly maxTurretHalfArc: number;
  /** Capitals fight broadside: hold a stand-off at main-battery reach with the
   *  beam toward the target so fore and aft turrets bear. Their turrets fire
   *  under WeaponMountTicker fire control, never with the hull's aim. */
  readonly broadside: boolean;
}

/** The kind's engagement profile (constructor-time, once per brain). */
export function engagementProfile(kind: ShipKind): EngagementProfile {
  // Compute the half-arc of the widest rotating mount across the kind's
  // mounts. `arcMax - arcMin` is the FULL arc; halving it gives the
  // distance the mount can swing from `baseAngle` in either direction.
  // For interceptor wings (±π/6), this is π/6 ≈ 30°. For gunship rear
  // (±π/2), this is π/2 ≈ 90°. Multi-mount kinds use the maximum across
  // their mounts (e.g. gunship's rear dominates over the forward's ±π/4).
  let maxHalf = 0;
  for (const m of kind.mounts ?? []) {
    if (m.rotationSpeed <= 0) continue;
    const half = (m.arcMax - m.arcMin) / 2;
    if (half > maxHalf) maxHalf = half;
  }
  const maxTurretHalfArc = maxHalf;

  // Weapon-aware engagement profile (weapons/energy/AI overhaul §4).
  const firstWeapon = getWeapon(kind.mounts?.[0]?.weaponId ?? 'hitscan');
  const weaponMode = firstWeapon.mode;
  const chargeHoldsLine = (firstWeapon.chargeTicks ?? 0) > 0
    && (firstWeapon.chargeRelease ?? 'locked-direction') === 'locked-direction'
    && !hasTurretFireControl(kind);
  // Lead-aim muzzle speed: real projectile speed for bolts/missiles,
  // ~instant for hitscan (no lead). Drives the intercept in tickCombat.
  const leadMuzzleSpeed = firstWeapon.mode === 'hitscan' ? 1e6 : firstWeapon.speed;
  const shotRadius = firstWeapon.mode === 'hitscan' ? 0 : firstWeapon.radius;
  let fireRange: number, stopDistFactor: number, backoffInsideFactor: number;
  if (firstWeapon.mode === 'hitscan') {
    // Beam: very close range — bore in to ~90 % of the beam's reach.
    fireRange = firstWeapon.range * 0.9;
    stopDistFactor = 0.5;
    backoffInsideFactor = 0;
  } else if (firstWeapon.mode === 'projectile') {
    // Bolt: medium dogfight range ≈ half the projectile's max travel.
    fireRange = (firstWeapon.speed * firstWeapon.maxTicks / 60) * 0.5;
    stopDistFactor = 0.6;
    backoffInsideFactor = 0;
  } else {
    // Missile: long-range artillery; kite the target, fire from afar.
    fireRange = 1400;
    stopDistFactor = 0.9;
    backoffInsideFactor = 0.4;
  }
  const broadside = hasTurretFireControl(kind);
  if (broadside) {
    // Engage at the longest gun's reach (the main battery).
    let reach = 0;
    for (const m of kind.mounts ?? []) reach = Math.max(reach, mountWeaponReach(m));
    fireRange = reach;
    stopDistFactor = BROADSIDE_STANDOFF;
    backoffInsideFactor = 0;
  }
  // Nothing fires without a lock (#19), and nothing locks past lock range
  // (owner 2026-11-21: ~1 km, hull to hull), so an AI pilot never engages
  // from farther out: its own radius + lock range (the target's hull only
  // adds margin).
  fireRange = Math.min(fireRange, LOCK_TUNING.maxLockRange + kind.radius);
  return {
    weaponMode, chargeHoldsLine, fireRange, stopDistFactor, backoffInsideFactor,
    leadMuzzleSpeed, shotRadius, maxTurretHalfArc, broadside,
  };
}
