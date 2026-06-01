/**
 * FX kill-switch URL params for heap-bisect measurements
 * (plan: melodic-engelbart, Step 2).
 *
 * Used by the Pixi-heap-bisect spec (`tests/e2e/combat-heap-growth-fx-bisect`)
 * to A/B/C the FX subsystem against the pre-existing heap leak surfaced
 * in capture `wb1al4` (heap 50→95 MB across 5 min, RAF cascade at ~120 s).
 *
 * - `?nofilters=1` detaches all GPU filters (WarpFilterChain → minimal,
 *   LaserGlow / ShieldAura / DestructionFx skip their filter attaches).
 *   Particles still spawn.
 * - `?noparticles=1` bypasses all particle spawn paths (EngineEmitter,
 *   ImpactSparks, DestructionFx particles). Filters still attach.
 *
 * Sibling escape hatches:
 * - `?effects=0` bypasses the entire EffectsService (per
 *   src/client/CLAUDE.md "Effects subsystem" — falls back to legacy
 *   inline starburst). Stays the all-or-nothing switch.
 * - `?worker=0` forces main-thread renderer (touch default).
 */

export interface FxKillSwitches {
  filtersDisabled: boolean;
  particlesDisabled: boolean;
  /** `?nobeams=1` — skip beam (live + remote) Graphics draws. Used by
   *  the phone-stall thermal-isolation A/B to attribute GPU heat. */
  beamsDisabled: boolean;
  /** `?nodmgnumbers=1` — skip damage-number Text rendering. */
  dmgNumbersDisabled: boolean;
  /** `?nohealthbars=1` — skip health-bar Graphics draws. */
  healthBarsDisabled: boolean;
}

export function readFxKillSwitches(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
): FxKillSwitches {
  // Touch devices auto-disable filters (2026-06-01 isolation
  // evidence: LaserGlow + ShieldAura GPU shader passes are 92 % of
  // raf_stutter under 35-drone hostile combat — raf_stutter 93 → 7,
  // GPU Δ +30°C → +11°C, no thermal throttling). `?nofilters=0`
  // explicit URL param opts a touch device BACK IN to filters; the
  // explicit `?nofilters=1` keeps working as before. Desktop /
  // non-touch contexts (jsdom tests, dev) are unaffected — filters
  // stay opt-in via `?nofilters=1`.
  const urlExplicitOff = /\bnofilters=1\b/.test(search);
  const urlExplicitOn = /\bnofilters=0\b/.test(search);
  const isTouch =
    typeof navigator !== 'undefined' &&
    ((navigator as { maxTouchPoints?: number }).maxTouchPoints ?? 0) > 0;
  const filtersDisabled = urlExplicitOff || (isTouch && !urlExplicitOn);
  return {
    filtersDisabled,
    particlesDisabled: /\bnoparticles=1\b/.test(search),
    beamsDisabled: /\bnobeams=1\b/.test(search),
    dmgNumbersDisabled: /\bnodmgnumbers=1\b/.test(search),
    healthBarsDisabled: /\bnohealthbars=1\b/.test(search),
  };
}
