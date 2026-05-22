/**
 * Internal 60 Hz work-loop cap — pure decision helper.
 *
 * Browser `requestAnimationFrame` fires at the display refresh rate.
 * Mobile phones increasingly default to 90/120 Hz panels, so RAF
 * fires 50-100 % more often than on a 60 Hz device. Our simulation
 * is fixed-step 60 Hz (`tickPhysics`) and our worker render is
 * already `every-2nd-RAF`-throttled — so RAFs above 60 Hz cost
 * mirror rebuild + structured-clone postMessage + reconciler
 * `advanceLerp` allocation pressure for zero perceptual gain.
 *
 * Direct evidence (captures `q4wtht` 90 Hz vs `d3cprl` 60 Hz, both
 * 2026-05-21 on the same device): 86× more >100 ms RAF stalls at
 * 90 Hz with `snapshot_applied` 70 % heavier — the per-RAF
 * allocation pressure was the trigger of the thermal/scheduler
 * chain that produced the spiral.
 *
 * The cap: if the RAF arrived <`minIntervalMs` after the last
 * PROCESSED frame, skip work this RAF. The caller MUST NOT update
 * its `lastFrameTime` on skip — otherwise the next RAF's `deltaMs`
 * would reset to ~0 and the cap would never engage. This means a
 * 90 Hz device skips alternate RAFs (~45 Hz processed) and a
 * 120 Hz device skips alternate RAFs (~60 Hz processed); 60 Hz
 * and below are unchanged.
 *
 * The replay harness drives `tickPhysics` directly via `MockClock`
 * and never enters the RAF loop, so this cap is invisible to
 * deterministic tests.
 */
export const DEFAULT_MIN_FRAME_INTERVAL_MS = 15.0;

export function shouldSkipFrame(
  deltaMs: number,
  minIntervalMs: number,
  isFirstFrame: boolean,
): boolean {
  if (isFirstFrame) return false;
  return deltaMs < minIntervalMs;
}
