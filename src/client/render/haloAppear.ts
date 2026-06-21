/**
 * Pure decisions for how an off-screen-ring (halo radar) glyph APPEARS — extracted
 * from `HaloRadar.update` (Phase A3: renderer decisions live in a pure, unit-
 * locked module).
 *
 * **The pop-in fix (Equinox Phase-5 audit, 2026-06-21).** A first-visible arrow
 * used to seed its spring just OUTSIDE the screen edge and then spring inward —
 * the "fly-in from the corner" the user reported as "the halo radar popping in!".
 * #133 (camera-relative ring) only moved the ring's reference POINT and never
 * touched this. The fix: a first-visible glyph is placed AT its ring target
 * immediately (no fly-in) and EASED in with a short alpha fade instead.
 */

/** How long (ms) a freshly-appeared halo glyph fades from transparent to opaque.
 *  Short enough to read as "appeared", long enough to not be a hard pop. */
export const HALO_APPEAR_FADE_MS = 160;

/**
 * Advance an appear-fade progress (0 = just appeared, 1 = fully opaque). Reset to
 * 0 when the glyph is swept (off↔on-screen) so a re-appearance fades again. Pure
 * + alloc-free (scalar in/out) — safe in the per-frame radar update (#14).
 */
export function haloAppearFadeStep(prevFade: number, dtMs: number, fadeMs = HALO_APPEAR_FADE_MS): number {
  if (fadeMs <= 0) return 1;
  const next = prevFade + dtMs / fadeMs;
  return next < 0 ? 0 : next > 1 ? 1 : next;
}
