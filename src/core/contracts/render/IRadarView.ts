import type { RadarInsets, RadarPrefs } from '../../../shared-types/settings/radar.js';

/** Off-screen radar + HUD world overlays. Part of `IRenderer`. */
export interface IRadarView {
  /**
   * Off-screen indicator radar (plan sparkling-wondering-rose). The active
   * preferences — the device-class defaults until the player's saved overrides
   * load. Plain structured-cloneable data (crosses the worker boundary).
   */
  setRadarPrefs(prefs: RadarPrefs): void;
  /** HUD geometry the radar must keep clear of, measured on the main thread
   *  from the layout slot hosts (the worker has no DOM). */
  setRadarInsets(insets: RadarInsets): void;
  /** Clear the radar while IN_TRANSIT / ARRIVED (the mirror still holds the
   *  old sector). NOT during SPOOLING — the player can still be attacked. */
  setRadarSuppressed(suppressed: boolean): void;
  /**
   * HUD-mode world overlays (showcase `?hud=`, `cinematic/hudMode.ts`).
   * `lockMarks` false hides the fire-control lock visuals drawn in the world
   * (lock rings / brackets / firing lines, threat arcs + diamonds, the hover
   * outline, structure turret range rings + aim lines); `radar` false hides
   * the off-screen edge radar. Both true in normal play. Separate from
   * `setRadarSuppressed` (transit), which it never overrides.
   */
  setHudOverlays(lockMarks: boolean, radar: boolean): void;
}
