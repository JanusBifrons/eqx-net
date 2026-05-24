# Probe 0 capture analysis — mg5rpe

Source: `diag/captures/2026-05-24T13-56-19Z-mg5rpe/` on `origin/feat/perf-floor` (65428c7; off ebd81a5 + 74d2847 "Probe 0").

## Session summary

- 101.4 s in-game rafTicks; 196 fire + 23 warp_in + 9 swarm_near_enter/exit — active combat.
- **Stall rate**: 16/4517 frames > 50 ms = **0.354 %**. Better than y2wpa5 (1.27 %), much better than su7udq/x8hdwj (10 %+), close to o4n4pw (0.48 %). User reported it as unplayable smoke.
- **Big surprise (load-bearing for the verdict)**: rafTick `elapsedMs` has a hard 22.0 ms mode — **4337/4517 = 96.0 %** of frames at exactly that. Stalls fall on integer multiples (22, 33, 44, 55, 66, 77, 88, 99, 110 ms). y2wpa5 shows the same 22 ms mode (93.7 %). **The phone is running a 45 Hz vsync floor**, in both captures.

## Probe 0 instrumentation: did it land?

Yes.

- `heap_sample` with new fields present from `perf.ndjson` line 3: `{"ts":7332.7,"tag":"heap_sample","data":{"heapUsedMb":41.62,"swarmDecodeMaxMs":3.9,"swarmDecodeAvgMs":0.28,"swarmDecodeCount":26}}`. 752 samples; 723 carry the swarm fields (29 omit zero-valued fields via NDJSON sparseness).
- `profile_started` fired at ts=5479.5 / 5484.4 (StrictMode dual-mount); `profile_ended` at ts=65480.9 / 65486.0 (`reason: "auto-stop"`). 60 s autoStop worked.
- **`swarm_decode_slow` count: 0**. No decode crossed 5 ms across 106 s of combat.

## Heap trajectory + swarm decode

- **heapUsedMb**: min 37.6, max 142.6, mean 80.4. Sawtooth — 4 full GCs dropping **75–98 MB at t=36.5, 54.7, 76.2, 99.2 s** (~22 s cadence). Many minor 5–7 MB drops between.
- **swarmDecodeMaxMs**: max **3.90**, mean **0.150**, p95 0.20. 1 sample > 3 ms (the first), 6 > 1 ms total. Never crossed 5 ms.
- **swarmDecodeAvgMs** mean 0.069, max 0.30. **swarmDecodeCount** max 52/window, mean 7.7. Probe wired; cost trivial.

**Stalls vs swarm decode** (200 ms window before each): none had `swarmDecodeMaxMs > 0.30`. The 110.9 / 100.9 ms gaps at t=44.8/44.9 s show swMax = 0.00 and 0.20 — flat. **H2 falsified.**

**Stalls vs major GC**: 4 major GCs at 36.5/54.7/76.2/99.2 s have **zero** stalls within ±500 ms. Conversely, the 5 stall clusters (7 s init, 28, 44–47, 62–67, 85 s) have **zero** major GCs within ±500 ms. Disjoint timelines. **H1 falsified for major GCs.** Minor GCs (5–7 MB) also not clustered around stalls — the 44–47 s cluster sits in steady 73 → 94 MB *growth* with no drop. The one `raf_gap` with delta data (t=67.3 s, +14.24 MB over 22 s) is 0.65 MB/s — well below GC-pressure rates.

## Stall pattern

16 stalls > 50 ms. Clusters: **7.0–7.3 s** (4, 78–99 ms; startup) / **28.6 s** (1, 77 ms) / **44.7–47.1 s** (5, 55–110 ms; mid-combat) / **62.9–67.5 s** (5, 66–110 ms; mid-combat) / **85.2 s** (1, 55 ms). Durations are multiples of 22 ms: 55, 66, 77, 88, 99, 110. **Compositor missed N vsyncs in a row.** y2wpa5 had identical modal cadence and the same multiple-of-22 stall distribution, just more often.

## Verdict

**The data supports H3 (below-JS / compositor / vsync).**

Three independent lines:

1. **45 Hz vsync floor**: 96 % of frames at exactly 22.0 ms is a hardware refresh cadence, not a JS workload signature. JS work would produce a continuous distribution. The compositor is gating frame delivery at 45 Hz; stalls are quantised to vsync misses.
2. **Major GCs and stalls are disjoint timelines**: 4 largest GCs of the session (75–98 MB each) produced zero stalls; 5 stall clusters had no major GC. y2wpa5 flagged this tentatively; mg5rpe confirms.
3. **Swarm decode is negligible**: 0.15 ms mean, 3.9 ms max, zero crossings of 5 ms. Probe 0 measured the feared surface; it doesn't dominate.

**Specific fix**: none of the JS-side mitigations (pool scratch arrays, batch follower writes, reduce binary cadence) will move the floor. The 45 Hz mode is set below JS.

**Next probe needed**: the Chrome flame graph from `?profile=1` (the toggle worked — the profile blob exists). Inspect compositor + GPU thread timelines during the 44–47 s or 62–67 s clusters. Secondary: instrument `document.timeline.currentTime` vs `performance.now()` rAF stamps to confirm the 22 ms interval is the screen and not Chrome rAF coalescing.

## Confidence

**Medium-high** on the negatives (H1 and H2 falsified); **medium** on the positive (H3).

Decided cleanly: swarm decode is not the bottleneck (Probe 0 measured it directly); major GCs are not the stall mechanism (0/4 correlation).

Cannot decide: whether the 22 ms cadence is a Chrome power-mode artefact, the Android panel native rate, or thermal/battery throttle (the probe doesn't see below JS by design); whether the 44–47 s and 62–67 s mid-combat clusters share cause with the vsync floor or are separate (swarmDecode windows are flat, so they aren't workload-spike-driven, but mid-combat clustering is suspicious).

Next capture: `?profile=1` with the Chrome profile downloaded, inspected for compositor + GPU thread activity during a mid-combat stall cluster. If the compositor shows long commit gaps with main idle, the plan must pivot to render-pipeline scoping (texture upload cadence, layer count, OffscreenCanvas viability) instead of allocation budgets.
