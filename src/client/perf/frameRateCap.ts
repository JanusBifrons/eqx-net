/**
 * Internal work-loop cap — pure decision helper.
 *
 * Browser `requestAnimationFrame` fires at the display refresh rate.
 * Mobile phones increasingly default to 90/120 Hz panels, so RAF
 * fires 50-100 % more often than on a 60 Hz device. Our simulation
 * is fixed-step 60 Hz (`tickPhysics`) and our worker render is
 * already `every-2nd-RAF`-throttled — so RAFs above the cap cost
 * mirror rebuild + structured-clone postMessage + reconciler
 * `advanceLerp` allocation pressure for diminishing perceptual
 * gain.
 *
 * Historical evidence (captures `q4wtht` 90 Hz vs `d3cprl` 60 Hz,
 * both 2026-05-21 on the same device): 86× more >100 ms RAF stalls
 * at 90 Hz with `snapshot_applied` 70 % heavier — the per-RAF
 * allocation pressure was the trigger of a thermal/scheduler chain
 * that produced the spiral.
 *
 * That evidence drove the historical cap value of 15 ms, which
 * deliberately throttled 90 Hz devices to ~45 fps processed. But
 * Probe 1 on capture `3vzz3q` (2026-05-24, Pixel 6 / Chrome 148)
 * measured per-RAF work at ~1 ms median (90 % at 1 ms, 6 % at 2 ms,
 * 14+ ms headroom every RAF). The thermal-cascade concern from the
 * original cap no longer applies to the current code, but the
 * 45 fps penalty on 90 Hz devices remained and was the dominant
 * source of mobile-felt unplayability (`device_info_calibration`
 * confirmed 90 Hz native; `rafTick.elapsedMs` 97 % at 22 ms == the
 * cap throttling every other RAF).
 *
 * The cap value was therefore reduced from 15 ms → 10 ms (2026-05-24,
 * commit ec4...). At 10 ms:
 *   - 60 Hz devices (16.67 ms native): process every RAF → 60 fps (unchanged)
 *   - 90 Hz devices (11.1 ms native): process every RAF → 90 fps (the fix)
 *   - 120 Hz devices (8.3 ms native): skip alternate RAFs → 60 fps (unchanged)
 *
 * The cap: if the RAF arrived <`minIntervalMs` after the last
 * PROCESSED frame, skip work this RAF. The caller MUST NOT update
 * its `lastFrameTime` on skip — otherwise the next RAF's `deltaMs`
 * would reset to ~0 and the cap would never engage.
 *
 * The replay harness drives `tickPhysics` directly via `MockClock`
 * and never enters the RAF loop, so this cap is invisible to
 * deterministic tests. The captured-cadence test
 * `tests/unit/frameRateCap.realCapture.test.ts` validates the cap
 * against the user's actual measured device rate.
 */
export const DEFAULT_MIN_FRAME_INTERVAL_MS = 10.0;

export function shouldSkipFrame(
  deltaMs: number,
  minIntervalMs: number,
  isFirstFrame: boolean,
): boolean {
  if (isFirstFrame) return false;
  return deltaMs < minIntervalMs;
}
