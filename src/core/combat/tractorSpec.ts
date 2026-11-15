/**
 * The tractor block of a weapon record (`WeaponDefBase.tractor`, salvage plan
 * PR 11): the pull of an S-size mount; a mount pulls with force × its size's
 * `MOUNT_SIZE_TUNING.power`. Formulas: `tractorImpulse`
 * (core/physics/forceFields.ts). Keep `dRef ≤ hold`, or a load reaching the
 * cushion still feels the full force and slams.
 */
export interface TractorSpec {
  /** F_mount at power 1 (force units: impulse per second). */
  readonly force: number;
  /** Full force inside this distance from the muzzle; inverse square past it. */
  readonly dRef: number;
  /** Cushion radius: inside it the target hovers on a damped spring. */
  readonly hold: number;
  /** Half-width of the beam line; bodies within it feel `lineFrac` × F(d). */
  readonly lineHalfWidth: number;
  readonly lineFrac: number;
  /** Game ticks one accepted fire keeps the beam on (more than a cooldown,
   *  so a held trigger never flickers it off between shots). */
  readonly leaseTicks: number;
}
