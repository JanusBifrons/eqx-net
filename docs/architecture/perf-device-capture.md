# Manual on-device perf capture protocol

Phase 3 of the perf-floor plan ([plan file](C:\Users\alecv\.claude\plans\i-want-you-now-abundant-gosling.md)). The automated `pnpm e2e:perf` driver (Phase 2) covers desktop Chromium and a CDP-throttled "mobile-shaped" Chromium arm; this protocol covers what those provably miss — **real iOS Safari** and **real Android Chrome**. Run once per release-candidate; the captures are normalised into the same `diag/perf-baseline/` shape Phase 5's budget reads.

## Why we need this

The CDP-throttled arm in Phase 2 reproduces only **CPU pressure** (Pattern B in `docs/LESSONS.md` 2026-05-08). Real on-device runs add:

- **Cellular radio buffering** — Pattern A: bursty snapshot delivery, multi-hundred-ms gaps the local proxy can't replicate.
- **iOS Safari < 17 quirks** — no `OffscreenCanvas`, no `pixi-viewport` in worker mode; renderer falls back to the main-thread `PixiRenderer`. Phase 4's hotspot triage should look for this delta.
- **GPU architecture deltas** — mobile compositors are different beasts; layer-promotion thresholds, paint costs, and texture-upload latencies diverge sharply from desktop.
- **Thermal throttling** — sustained load on a phone can drop the SoC clock mid-session. The throttled-Chromium arm is flat 4× CPU; a real device may step.

The two captures will disagree. *The disagreement is the data.*

## When to capture

- Before tagging a release candidate.
- After landing any change to: `src/client/render/`, `src/client/net/`, `src/core/prediction/`, `src/core/physics/`, OffscreenCanvas worker path, mobile-specific UI surfaces (`MobileControls.tsx`, layout slots, drawer).
- When the user reports an on-device regression that the desktop + CDP-throttled arms didn't surface.

The cadence is the user's call — there is no automated trigger.

## The protocol — exactly the steps to perform

1. **Quiet the host.** Close other tabs / apps. The capture only competes with the page itself, not background work.
2. **Open the URL** corresponding to the scenario you're measuring:

   | Scenario | URL |
   |---|---|
   | `sol-prime-ambient` | `<server>/?galaxy=sol-prime&diag=0` |
   | `feel-test-25` | `<server>/?room=feel-test-25&spawnX=0&spawnY=0&diag=0` |

   **`&diag=0` is load-bearing.** Skipping it lets the webdriver auto-enable trigger if the device looks like one (rare), or, more often, lets a stale capture from a prior `?diag=1` URL bleed into the new session. The budget will flag `diagEnabledAtCapture: true` as a precondition fail; rerun without `?diag=1` if that happens.

3. **Wait for the warp curtain to lift** — the loading screen fades out and the gameplay surface is visible. This means the player ship has joined, the first snapshot arrived, and the renderer is drawing authoritative state.

4. **Run the fixed action sequence:**
   - **First 5 seconds: stay still.** Don't tap, don't touch the joystick. Lets the rolling stats fill (`rafP50Ms` needs 5 s of `rafTick` samples).
   - **Next 25 seconds: thrust forward and pan the camera** — joystick fully up, slight A/D taps to sweep through the visible drone field. The 25 s window matches the Phase 2 automated arm so the on-device JSON has comparable sampleCount.
   - **Do NOT engage warp.** Warp transitions are a separate scenario; this protocol captures steady-state gameplay only.

5. **Open the drawer → Settings tab → tap "Capture".** The diagnostic upload runs against `/diag/capture` on the running server and writes a directory `diag/captures/<timestamp>-<id>/` containing the NDJSON siblings + `summary.json`. The "Capture saved" toast confirms success and gives you the directory id.

6. **Note the device + scenario** for the ingest step:
   - `--platform=ios` for any iOS device (Safari).
   - `--platform=android` for any Android device (Chrome).
   - `--scenario=sol-prime-ambient` OR `--scenario=feel-test-25`.

7. **Pull the capture directory** from the dev server's `diag/captures/`. If you're running the server on your laptop and the device is connecting over LAN, the directory is already local. If the server is remote, `scp -r user@host:eqx-net/diag/captures/<id> ./diag/captures/` to pull.

8. **Run the ingest script:**

   ```bash
   node scripts/ingest-device-capture.mjs diag/captures/<id> \
     --scenario=sol-prime-ambient \
     --platform=ios
   ```

   The script reads `summary.json` + `raf.ndjson` + `other.ndjson`, computes the same `{median, p95, p99, sampleCount}` aggregates as Phase 2's `perfCapture.ts`, and writes `diag/perf-baseline/sol-prime-ambient-device-ios.json` (or `*-device-android.json`).

9. **Review the JSON.** Sanity checks:
   - `diagEnabledAtCapture` MUST be `false`. If `true`, the capture is invalid — rerun without `?diag=1`.
   - `sampleCount` should be a few hundred for a ~30 s session at 60 Hz (rafTick samples every 4th frame ≈ 450 samples / 30 s). A much smaller count means the rafTick logger fell behind — possibly a paint-stalled session worth investigating.
   - `metrics.rafP50Ms.median` is the headline. < 16.7 ms = 60 Hz. > 33 ms = visible stutter.
   - `source.userAgent` and `source.viewport` are preserved for provenance.

10. **Commit the JSON.** The `diag/perf-baseline/` directory is un-ignored. Commit message: `data(perf): device capture <platform> for <scenario> (Phase 3, plan: perf-floor)`. Reference the capture directory id in the body.

## Pattern A vs Pattern B from the capture

The on-device JSON disambiguates the same way the LESSONS 2026-05-08 checklist does:

| Symptom in metrics | Pattern | Likely cause |
|---|---|---|
| `rafP50Ms` healthy + `tickBudget.totalAvgMs` healthy + correction-rate spikes | Pattern A | Cellular radio buffering. Mitigation: server-side backpressure / `JOIN_BROADCAST_GRACE_TICKS` tuning. |
| `rafP50Ms` > 25 + `tickBudget.totalAvgMs` healthy + `longtaskCount30s` > 5 | Pattern B (client CPU) | Main-thread compute. Mitigation: extract to worker, throttle, defer. |
| `rafP50Ms` healthy + `tickBudget.totalAvgMs` > 12 ms + `tickBudget.overBudgetRatio` > 0 | Server CPU-bound | TiDi may be engaging or near. Mitigation: optimise SectorRoom hot subsystem. |
| `rafGapCount30s` > 2 + correlated `longtaskCount30s` spikes | Main-thread block / GC pause | Run the user-paired CDP profile (the existing `analyze-cdp-profile.mjs` tooling) to attribute. |

## What this protocol does NOT cover

- Synthetic stress tests (`swarm-soak`, `swarm-tidi`). Those exercise rescue paths (LoadShedder, TiDi); they're outside the "ambient floor" scope the user chose at plan time.
- Programmatic device control (no Selenium-on-device, no BrowserStack). The protocol is deliberately user-driven so the cadence is the user's call and the cost is one tap-and-pull per platform per release.
- Multi-user testing. The capture is a single-player session; cross-client interactions need the netgate (`pnpm e2e:netgate`).

## See also

- [`docs/LESSONS.md`](../LESSONS.md) — Pattern A/B diagnostic checklist (2026-05-08 entry).
- [`tests/perf/perfCapture.ts`](../../tests/perf/perfCapture.ts) — `PerfAggregate` shape produced by both ingest paths.
- [`scripts/analyze-cdp-profile.mjs`](../../scripts/analyze-cdp-profile.mjs) — companion tooling for GC / main-thread-block attribution.
- Plan file: `C:\Users\alecv\.claude\plans\i-want-you-now-abundant-gosling.md`.
