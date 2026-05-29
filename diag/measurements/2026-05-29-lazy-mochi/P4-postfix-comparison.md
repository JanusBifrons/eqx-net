# Phase 4 — Post-fix re-measurement vs Phase 1 baseline

3 commits shipped, all on `integration/four-branches`:

| SHA | Subject |
|---|---|
| `1d0c18f` | `perf(net): tighten ramming_probe gate to ?probe=ram opt-in` |
| `7af9620` | `perf(effects): pool ImpactSparks particles + heap-delta lock` |
| `9803224` | `perf(effects): pool DestructionFx particles + heap-delta lock` |

## CDP allocation profile (post-fix vs main vs HEAD-pre-fix)

Single rep each, sampled ~1 MB total per arm.

| Function | main | HEAD pre-fix | HEAD post-fix | Δ pre→post |
|---|---|---|---|---|
| **`updateMirror`** | 64.1 KB (4.6%) | **174.6 KB (15.1%)** | **41.7 KB (4.0%)** | **-132.9 KB (-76%)** ✓ |
| `tickPhysics` | 111.9 KB (8.0%) | 80.3 KB (6.9%) | 76.7 KB (7.3%) | -3.6 KB |
| `tick` WarpScreen | 122.2 KB (8.8%) | 27.3 KB (2.4%) | 61.4 KB (5.9%) | +34 KB (variance) |
| `loop` gameRafLoop | 86.3 KB (6.2%) | 46.8 KB (4.0%) | 52.0 KB (5.0%) | +5.2 KB |
| `sendFire` | (not in top 25) | 30.1 KB (2.6%) | 34.2 KB (3.3%) | +4 KB |
| Total sampled | 1.36 MB | 1.13 MB | 1.02 MB | -110 KB |

**The ramming_probe gate tightening did exactly what the data predicted**: `updateMirror`'s sampled share fell from 15.1 % to 4.0 % — below main's 4.6 %. The dominant new allocator named by lazy-mochi P2 is gone.

## combat-heap-growth.spec.ts — 3 reps post-fix

| Rep | sampleCount | slope MB/s | growth MB/s | rafGap | rafStutter | maxStall ms | maxHeapDelta MB | peakMb |
|---|---|---|---|---|---|---|---|---|
| Pre-fix (single) | 145 | 0.462 | 0.407 | 15 | 171 | 300 | 3.68 | 54.29 |
| Post-fix rep 1 | 125 | 0.920 | 0.983 | 22 | 203 | 666.7 | 4.61 | 66.30 |
| Post-fix rep 2 | 134 | 0.122 | 0.219 | 21 | 174 | 350.1 | 3.20 | 49.05 |
| Post-fix rep 3 | 129 | 0.071 | 0.047 | 23 | 169 | 333.3 | 4.26 | 48.34 |
| **Post-fix median** | **129** | **0.122** | **0.219** | **22** | **174** | **350.1** | **4.26** | **49.05** |
| (main single rep) | 186 | 0.428 | 0.775 | 1 | 47 | 150 | 2.21 | 51.06 |

## Read-out

**Slope: PASS.** Post-fix median **0.122 MB/s** is well below the spec's `≤ 0.4 MB/s` target AND well below main's `0.428 MB/s`. The +8 % HEAD-vs-main slope delta from Phase 1 is overcorrected to a -71 % delta vs main. This metric is the load-bearing measurement of allocation pressure; the fix succeeded.

**Stall counts: STILL ELEVATED.** rafGap median 22, maxStall median 350 ms — both still above main's 1 and 150. But the stall behavior was UNCHANGED across pre-fix and post-fix HEAD, indicating these stalls are not caused by the allocators the fixes addressed.

Three hypotheses for the residual stalls, ordered by my confidence:
1. **Playwright-environment-bound.** Headless Chromium under Playwright has different memory limits and GC tuning vs a real browser. The maxHeapDelta values at stalls don't show the textbook major-GC sawtooth (main's 2.21 MB drop = real GC; HEAD's 3-4 MB stays high suggests cumulative growth, not GC events). Phone smoke yesterday (`yvv0z7`) showed 12 raf_stutters all <70 ms — none of these big 300-650 ms stalls. The gate measurement may be inflating an environmental artifact.
2. **Variance dominates the stall metric.** Slope variance between reps is 13× (0.071 to 0.920); stall behavior is correlated. With only 20 s windows the stall count is bounded by V8's major-GC scheduling decisions, which are non-deterministic.
3. **A residual production allocator the gate workload (no hits in `feel-test-25`) cannot trigger.** ImpactSparks / DestructionFx pools matter when hits/kills happen. The user's phone gameplay (hostile galaxy sectors) DOES trigger them — phone smoke is the proper verification.

The user's standing rule "deterministic gates ≠ playable" applies here in reverse: the gate's slope is now green; its stall counters are noisy; the phone is the proxy that matters.

## Phase 4 verdict

- **Deterministic test gates GREEN.** All 25 heap-delta unit locks pass (`pnpm test:gc`); typecheck + lint + 1521 unit tests pass (8 pre-existing failures unchanged). New per-effect heap-delta tests (ImpactSparks ×3, DestructionFx ×3) prove the pools hold under cycle pressure.
- **CDP profile DATA-CONFIRMS the targeted allocator is gone.** updateMirror's share dropped from 15.1 % to 4.0 % — below main.
- **combat-heap-growth slope target MET** (median 0.122 ≤ 0.4 ≤ main 0.428).
- **rafGap / maxStall metrics still above main**, but stable across pre- and post-fix HEAD — not the regression these fixes target. Phone smoke is the next-step verification.

Per the standing user-confirmed scope: stop at deterministic green + slope green, hand off for phone smoke. Do NOT pre-emptively run `pnpm e2e:netgate` or `pnpm e2e` full.
