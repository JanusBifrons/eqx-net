/**
 * Tunable parameters for the warp visual effect. The renderer keeps
 * a copy of the full struct; partials passed in `SET_WARP_PARAMS` are
 * merged on top so sliders only need to send the field they changed.
 *
 * Two-phase envelope driven by `setWarpMode(true)`:
 *   1. Spool — many small short-lived ripples (count = `spoolCount`,
 *      finite `spoolRadius`, fast cycle).
 *   2. Climax — one big ripple (count = 1, infinite radius, slow cycle).
 *
 * After `setWarpMode(false)` a `fadeOutMs` tween brings everything to 0.
 * Today only the visual-effects sandbox posts these; production uses
 * the defaults baked in below.
 */

export interface WarpParams {
  /** ShockwaveFilter `speed` uniform (pixels/sec). 100–2000. */
  speed: number;
  /** ShockwaveFilter `wavelength` uniform. 40–600. */
  wavelength: number;
  /** ZoomBlurFilter `innerRadius` — radius (px) inside which blur is at full strength. 0–400. */
  zoomBlurInnerRadius: number;
  /** Ms to fade everything to 0 after `setWarpMode(false)`. 100–2000. */
  fadeOutMs: number;

  // ---- Spool phase: many small short-lived pulses ----
  /** Spool phase duration (ms). 0–8000. */
  spoolDurationMs: number;
  /** Stacked ShockwaveFilter count during spool. 1–8. */
  spoolCount: number;
  /** ShockwaveFilter time-cycle period during spool (ms). 200–2000. */
  spoolWavePeriodMs: number;
  /** Spool ripples die beyond this radius (px). 50–800. */
  spoolRadius: number;
  /** Peak amplitude at end of spool. 0–80. */
  spoolAmplitude: number;
  /** Peak brightness at end of spool. 1.0–2.0. */
  spoolBrightness: number;
  /** Peak zoom blur strength at end of spool. 0–1. */
  spoolZoomBlur: number;

  // ---- Climax phase: single big pulse ----
  /** Climax phase duration (ms). 0–4000. */
  climaxDurationMs: number;
  /** ShockwaveFilter time-cycle period during climax (ms). 1000–10000. */
  climaxWavePeriodMs: number;
  /** Peak amplitude at climax (the "big pulse"). 10–250. */
  climaxAmplitude: number;
  /** Peak brightness at climax. 1.0–2.5. */
  climaxBrightness: number;
  /** Peak zoom blur strength at climax. 0–1. */
  climaxZoomBlur: number;

  // ---- Burst + flash: the "exit moment" / warp-in arrival pulse ----
  /** Total lifetime (ms) of the burst ShockwaveFilter pulse. 100–1500. */
  burstDurationMs: number;
  /** Peak amplitude of the burst ripple (starts here, decays to 0). 50–400. */
  burstAmplitude: number;
  /** Burst ShockwaveFilter `speed` (px/sec). 400–3000. */
  burstSpeed: number;
  /** Burst ShockwaveFilter `wavelength`. 80–500. */
  burstWavelength: number;
  /** Burst ShockwaveFilter peak `brightness`. 1.0–2.5. */
  burstBrightness: number;
  /** Peak alpha of the white flash overlay. 0–1. */
  flashAlphaMax: number;
  /** Total lifetime (ms) of the flash alpha tween. 100–800. */
  flashDurationMs: number;
  /** World-space distance beyond which the flash is invisible. The
   *  flash alpha scales linearly from `flashAlphaMax` at distance 0 to
   *  0 at this range. Reads camera world centre (i.e. local-ship
   *  position in production) as the viewer. 0–8000. */
  flashRangeMax: number;
}

/**
 * Default warp params — the production warp visual runs with these
 * baked into `PixiRenderer`'s `warpParams` field. The visual-effects
 * sandbox spike also seeds its sliders from this object so the
 * iteration starts at the production baseline.
 *
 * Design intent: spool reads as "build-up flutter" (many small ripples
 * that die early, very subtle blur), climax reads as "the big moment"
 * (one strong ripple, brightness + blur peak). Total ramp ≈ 5 s.
 */
export const DEFAULT_WARP_PARAMS: WarpParams = {
  // Shared
  speed: 600,
  wavelength: 240,
  zoomBlurInnerRadius: 80,
  fadeOutMs: 700,

  // Spool: toned down 2026-05-27 (M3 of effects-subsystem plan
  // wiggly-puppy): spoolCount 4→2 (half the filter passes), amplitude
  // 18→10, brightness 1.05→1.03. The 2026-05-21 disable rationale was
  // duty-cycle cost on mobile — halving spoolCount halves the per-frame
  // shader cost of this phase. EffectsBudget.applyQuality further dials
  // at runtime (medium drops to 1 spool filter; minimal detaches).
  spoolDurationMs: 3750,
  spoolCount: 2,
  spoolWavePeriodMs: 700,
  spoolRadius: 320,
  spoolAmplitude: 10,
  spoolBrightness: 1.03,
  spoolZoomBlur: 0.04,

  // Climax: toned down 2026-05-27 (M3): amplitude 220→70, brightness 2.0→1.4,
  // zoomBlur 0.7→0.35. Phase 3 (#10) — "subtler ripple": amplitude 70→40 and
  // the duration +50% (1100→1650 ms) so the same single big ripple reads as a
  // gentler wave spread over a longer distance rather than a sharp pulse.
  climaxDurationMs: 1650,
  climaxWavePeriodMs: 5000,
  climaxAmplitude: 40,
  climaxBrightness: 1.4,
  climaxZoomBlur: 0.35,

  // Burst + flash: toned down 2026-05-27 (M3): amplitude 440→220, flashAlpha
  // 0.85→0.55. Phase 3 (#10) — "subtler ripple": amplitude 220→140,
  // flashAlpha 0.55→0.35, burst duration +50% (1500→2250 ms) so the arrival
  // burst + white flash are gentler and spread slower. The bloom/glow pass was
  // removed entirely in WS-14/R2.9 (the white arrival flash is the reveal).
  burstDurationMs: 2250,
  burstAmplitude: 140,
  burstSpeed: 2800,
  burstWavelength: 520,
  burstBrightness: 1.6,
  flashAlphaMax: 0.35,
  flashDurationMs: 380,
  flashRangeMax: 2500,
};
