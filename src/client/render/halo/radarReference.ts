/**
 * Phase 5 — the off-screen ring's REFERENCE POINT decision (pure, alloc-free).
 *
 * The halo radar orbits its glyphs around — and measures contact distance from —
 * a reference point. In normal play that's the local ship. In SPECTATOR the ring
 * must be CAMERA-relative, decoupled from any ship (the user's "ring icons still
 * function in spectator but go to the ship I was previously piloting" half-way-
 * house bug): the free camera centre becomes the reference.
 *
 * Writes into a caller-owned `out` (invariant #14 — the radar tick is per-frame
 * and must not allocate) and returns whether a reference exists. Frames:
 *   - `local{X,Y}` is GAME space (Y-up), as `mirror.ships` poses are.
 *   - `cameraCentre{X,Y}` is the pixi world frame (Y-down) — `camera.center`.
 * The output is GAME space, so the spectator branch un-flips the camera Y.
 */
export function resolveRadarReference(
  spectating: boolean,
  localX: number | null,
  localY: number | null,
  cameraCentreX: number,
  cameraCentreY: number,
  out: { x: number; y: number },
): boolean {
  if (spectating) {
    out.x = cameraCentreX;
    out.y = -cameraCentreY; // pixi(Y-down) → game(Y-up)
    return true;
  }
  if (localX !== null && localY !== null) {
    out.x = localX;
    out.y = localY;
    return true;
  }
  // Not spectating and no local ship (between rooms / pre-spawn) → no ring.
  return false;
}
