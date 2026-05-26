/**
 * Pure helper: classify a pointerdown→up as tap vs drag.
 *
 * A pointerdown→up that moved less than `tapThresholdPx` AND took less
 * than `tapThresholdMs` counts as a tap. Either threshold exceeded
 * → drag. Mutually-exclusive classification — the caller picks one
 * branch.
 */

export interface TapVsDragThresholds {
  /** Tap pixel-distance threshold. Default 6 px. */
  tapThresholdPx: number;
  /** Tap duration threshold (ms). Default 250 ms. */
  tapThresholdMs: number;
}

export interface TapClassification {
  /** True when the release qualifies as a tap (short distance + duration). */
  isTap: boolean;
  /** Total pixel distance from start to release. */
  distancePx: number;
  /** Wall-clock duration from start stamp to release stamp (ms). */
  elapsedMs: number;
}

/**
 * Classify a release event. Pure — no internal state.
 *
 * @param startX  pointerdown screen X
 * @param startY  pointerdown screen Y
 * @param endX    pointerup screen X
 * @param endY    pointerup screen Y
 * @param startStamp  Date.now() at pointerdown
 * @param endStamp    Date.now() at pointerup
 * @param thresholds  tap distance + duration limits
 */
export function classifyTap(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  startStamp: number,
  endStamp: number,
  thresholds: TapVsDragThresholds,
): TapClassification {
  const ddx = endX - startX;
  const ddy = endY - startY;
  const distancePx = Math.hypot(ddx, ddy);
  const elapsedMs = endStamp - startStamp;
  const isTap =
    distancePx < thresholds.tapThresholdPx &&
    elapsedMs < thresholds.tapThresholdMs;
  return { isTap, distancePx, elapsedMs };
}
