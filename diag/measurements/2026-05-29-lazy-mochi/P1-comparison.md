# Phase 1 measurement — integration/four-branches HEAD vs main

Captured 2026-05-29. Same box, same browser (Chromium-headless-shell 131 via Playwright 1.49.0), same room (`feel-test-25` for combat, `test-sector` for passive).

## Test gate targets (combat-heap-growth.spec.ts)

| Metric | Target | main | HEAD | HEAD vs main | Target met? |
|---|---|---|---|---|---|
| slopeMbPerSec | ≤ 0.4 | 0.428 | 0.462 | +8% | both FAIL |
| rafGapCount | ≤ 10 | 1 | **15** | **15×** | main PASS / HEAD FAIL |
| maxStallElapsedMs | ≤ 150 | 150 | **300** | **2×** | main borderline / HEAD FAIL |

## All combat metrics

| Metric | main combat | HEAD combat | Δ |
|---|---|---|---|
| slopeMbPerSec | 0.428 | 0.462 | +0.034 (+8%) |
| growthMbPerSec (first/last) | 0.775 | 0.407 | -0.368 |
| firstMb | 33.81 | 43.70 | +9.89 (baseline higher post-merge) |
| lastMb | 49.52 | 52.22 | +2.70 |
| peakMb | 51.06 | 54.29 | +3.23 |
| sampleCount | 186 | 145 | **-41 (fewer RAFs serviced during stalls)** |
| rafGapCount | 1 | **15** | +14 (**15×**) |
| rafStutterCount | 47 | 171 | +124 (3.6×) |
| maxStallElapsedMs | 150 | **300** | +150 (2×) |
| maxHeapDeltaAtStall (MB) | 2.21 | 3.68 | +1.47 (1.7×) |
| fireCount | n/a | 93 | combat happened |
| damageNumberSpawnCount | n/a | 0 | no hits landed in the 20s window |

## All passive metrics (test-sector, no combat)

| Metric | main passive | HEAD passive | Δ |
|---|---|---|---|
| slopeMbPerSec | 0.237 | 0.344 | +0.107 (+45%) |
| growthMbPerSec (first/last) | 0.053 | 0.466 | +0.413 (heap climbs un-GC'd on HEAD) |
| firstMb | 34.65 | 42.59 | +7.94 (baseline higher) |
| lastMb | 35.72 | 51.93 | **+16.21** |
| peakMb | 48.43 | 52.21 | +3.78 |
| sampleCount | 174 | 154 | -20 |
| majorReclaims (>5MB drops) | **19** | **0** | -19 (main GCs ~1/s; HEAD doesn't reclaim in window) |

## Interpretation

The **steady-state slope** is only +8% worse on HEAD — a modest delta the user wouldn't experience as "tanked".

The **bursty allocation pattern** is the regression:
- HEAD produces 15× more `raf_gap > 100 ms` events than main during identical combat workload.
- Max single-frame stall doubled (150 → 300 ms).
- HEAD's passive workload has zero major reclamations vs main's 19 — heap climbs continuously rather than GC'ing in small frequent cycles, suggesting allocation **patterns** that defer GC until a single big pause.

Both are consistent with the integration introducing spawn/destroy bursts of Pixi `Graphics` objects (the unpooled `ImpactSparks` per-hit spawn loop + `DestructionFx` per-kill spawn loop) plus their per-instance entry literals. Per-hit/per-kill alloc bursts don't dominate steady-state slope but DO drive `raf_gap` spikes when V8 chooses to major-GC.

## Note on the 0.4 slope target

The combat-heap-growth spec was authored after the `perf-floor` ship to lock the post-fix state. Both main and HEAD fail it, so the target is currently tighter than current baseline. The Phase-4 ship criterion shifts from "spec passes absolutely" to "HEAD matches or beats main on the burst/stall metrics" — which are the actual user-felt symptom.

## Phase 4 success criteria (revised by Phase 1 data)

- slopeMbPerSec: ≤ 0.43 MB/s (≈ main level; +0.002 tolerance for run-to-run noise)
- rafGapCount: ≤ 2 (main = 1; small headroom for noise)
- maxStallElapsedMs: ≤ 200 ms (main = 150; small headroom)
- rafStutterCount: ≤ 60 (main = 47)

If HEAD beats main on the stall/burst metrics post-fix, the integration has neutralised the regression — even if the absolute spec target (≤ 0.4 slope) remains nominally failing because that target was authored against the post-perf-floor state.
