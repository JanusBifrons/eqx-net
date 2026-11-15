/**
 * The motion sample the speed effects are measured from (C3 speed zoom).
 *
 * `stepSpeedFx` turns successive (centre, time) samples into a speed, and the
 * speed into the camera's speed zoom-out. While the camera follows a ship, the
 * sample is that ship's drawn pose at the time it was drawn for
 * (`mirror.frameTimeMs`), never the camera centre at the renderer's clock: the
 * pose advances in steady frame-time steps while the renderer clock (worker
 * or main thread) steps unevenly, and at that point of `update()` the centre
 * is still last frame's. Mixing them made the raw speed swing ±15-60 % a
 * frame, and the speed zoom made the whole view breathe ~2 px at the screen
 * edge (capital-guns-fighter take, 2026-11-12). Same lesson as the cinematic
 * director's velocity estimate. Lock: `speedFxSample.test.ts`.
 *
 * Command view's free camera is not flight: nothing is followed and the
 * player moves the view by hand (WASD, drag, wheel zoom round the cursor).
 * Measuring the camera centre there zoomed the view out by up to 20 % on
 * every pan and eased it back after, the commander view "stutters like it
 * thinks I've still got a ship travelling fast" (owner, 2026-11-14). So a
 * free camera holds the last sample position: the speed eases to zero.
 * Lock: `speedFxSample.test.ts`, `tests/e2e/command-view-camera.spec.ts`.
 */

/** One (position, time) sample for `stepSpeedFx`. Pixi space (y down). */
export interface SpeedFxSample {
  x: number;
  y: number;
  /** Milliseconds; only deltas matter. */
  t: number;
  /** True when (x, y, t) is the followed ship's drawn pose at the frame time
   *  it was drawn for; false for the camera centre at the renderer clock. A
   *  change of source re-primes the estimate (the clocks differ). */
  fromPose: boolean;
}

export function newSpeedFxSample(): SpeedFxSample {
  return { x: 0, y: 0, t: 0, fromPose: false };
}

/**
 * Fill `out` with this frame's speed sample. Allocation-free.
 * @param followPose the pose the camera follows this frame (Pixi space), or
 *   null when nothing is followed (command view, cinematic script).
 * @param frameTimeMs the time that pose was drawn for (`mirror.frameTimeMs`).
 * @param camCenter the camera centre as it stands (Pixi space).
 * @param wallNowMs the renderer's own clock.
 * @param freeCamera true in command view: the view moves only by the player's
 *   hand, so the sample holds its last position (no speed).
 */
export function speedFxSampleInto(
  out: SpeedFxSample,
  followPose: { readonly x: number; readonly y: number } | null,
  frameTimeMs: number | undefined,
  camCenter: { readonly x: number; readonly y: number },
  wallNowMs: number,
  freeCamera = false,
): SpeedFxSample {
  if (freeCamera) {
    out.t = wallNowMs;
    out.fromPose = false;
    return out;
  }
  if (followPose && frameTimeMs !== undefined && Number.isFinite(frameTimeMs)) {
    out.x = followPose.x;
    out.y = followPose.y;
    out.t = frameTimeMs;
    out.fromPose = true;
    return out;
  }
  out.x = camCenter.x;
  out.y = camCenter.y;
  out.t = wallNowMs;
  out.fromPose = false;
  return out;
}
