/**
 * Pure aim-line-length policy (Equinox R2 WS-3 / R2.14).
 *
 * The dotted "where will this mount fire" preview used to be a hardcoded
 * `AIM_LINE_LENGTH = 500` for EVERY mount, so e.g. the interceptor's beam
 * (hitscan range 250) drew a guide line twice as long as the beam could
 * actually reach — the smoke report "interceptor aim-line longer than range."
 *
 * The length is now derived per-mount from the mount's fire-gate reach, the
 * shared `mountWeaponReach` (the weapon's `weaponAutoFireRange`: hitscan →
 * `range`; projectile → 0.85 × max travel; missile → 0.5 × max travel; a
 * mining tool scaled by its mount size), so the guide always traces the
 * distance the mount may fire to. Kept Pixi-free so it is unit-testable
 * without loading the renderer.
 */
import { mountWeaponReach } from '../../core/combat/mountReach.js';
import type { WeaponMount } from '../../shared-types/shipKinds.js';

/** World-unit length of a mount's aim-line preview = its fire-gate reach. */
export function aimLineLengthForMount(mount: WeaponMount): number {
  return mountWeaponReach(mount);
}
