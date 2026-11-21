/** The HUD shield-ring toggle's store slice (split out of storeTypes.ts, file
 *  cap). Discrete UI state, purity-clean (no spatial field). */
export interface ShieldToggleUi {
  /** The pilot dropped their ship's shields (`set_shields`); from the own-ship
   *  snapshot slice `shieldsLowered` (#16). The shield ring shows DOWN. */
  shieldsLowered: boolean;
  setShieldsLowered: (lowered: boolean) => void;
}
