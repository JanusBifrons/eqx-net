/**
 * Phase-1 issue 1 — smooth, LINEAR construction bar.
 *
 * The server advances construction on its 1 Hz grid pulse, so the wire's
 * `buildPct` arrives in discrete ~1 s steps. Rendering it raw makes the bar
 * "build in pulses" (the user's complaint). Instead the client interpolates
 * LINEARLY from the last authoritative `buildPct` toward completion using the
 * server-supplied `etaMs` as the slope, re-anchoring whenever a fresh
 * authoritative value arrives. As long as the server keeps delivering, the
 * local ramp tracks the true progress within one pulse; if the build stalls
 * (`etaMs === null`) the bar freezes at the authoritative value.
 *
 * Pure + allocation-free (scalar in/out) so it's unit-lockable and safe to
 * call per frame per blueprint.
 */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * @param startPct   The last authoritative `buildPct` (the anchor).
 * @param etaMs      ms-to-completion at the anchor (`null` ⇒ stalled → freeze).
 * @param elapsedMs  Wall-clock ms since the anchor was set.
 * @returns          The displayed build fraction, clamped to [0, 1].
 */
export function interpBuildPct(startPct: number, etaMs: number | null | undefined, elapsedMs: number): number {
  const s = clamp01(startPct);
  if (etaMs === null || etaMs === undefined || etaMs <= 0) return s;
  // Linear ramp from the anchor toward 1.0 over etaMs.
  return clamp01(s + (elapsedMs / etaMs) * (1 - s));
}
