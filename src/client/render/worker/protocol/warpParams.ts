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

  // ---- Bloom: amplifies the bright wavefront during climax + burst ----
  /** Peak BloomFilter `strength` at climax + burst. Bloom amplifies
   *  bright pixels (the wavefront has its own `brightness` uniform) so
   *  the wave reads as a glowing line that distant viewers can spot
   *  even before the displacement reaches their screen. 0–8. 0 = off. */
  bloomStrengthMax: number;
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

  // Climax: toned down 2026-05-27 (M3): amplitude 220→70 (third), brightness
  // 2.0→1.4, zoomBlur 0.7→0.35. The disable note said filters were not
  // load-bearing for playability — keep the dramatic shape (single big
  // ripple) but bring the intensity in.
  climaxDurationMs: 1100,
  climaxWavePeriodMs: 5000,
  climaxAmplitude: 70,
  climaxBrightness: 1.4,
  climaxZoomBlur: 0.35,

  // Burst + flash: toned down 2026-05-27 (M3): amplitude 440→220, bloom
  // 6→1.5, flashAlpha 0.85→0.55. Still legible at perimeter (speed/range
  // unchanged) but no longer dominates the screen.
  burstDurationMs: 1500,
  burstAmplitude: 220,
  burstSpeed: 2800,
  burstWavelength: 520,
  burstBrightness: 1.6,
  flashAlphaMax: 0.55,
  flashDurationMs: 380,
  flashRangeMax: 2500,
  bloomStrengthMax: 1.5,
};
