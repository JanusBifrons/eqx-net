# Probe 0 capture analysis — y2wpa5

## Session summary

72 s capture on `origin/feat/perf-floor` (HEAD `e25bf27`). Player journey: meta-landing → galaxy-map (t=18s) → game phase (t=20.98s) → game ends at capture cutoff (t=80.4s). ~59 s of in-game time. Combat was sporadic, concentrated at t=71–73s (12 `swarm_near_enter/exit` toggles in 2 s — repeated AI proximity churn), 118 fire events total, 285 damage_number_predicted events, 141 corrections. Stall rate (rafTick gaps > 30 ms, game phase only): **3.39 %** (83 / 2446 ticks). **Middle regime** — worse than `o4n4pw` (0.48 %, healthy) but materially better than `su7udq` (10.59 %) / `x8hdwj` (10.00 %, unplayable).

## Probe 0 instrumentation: did it work?

**No. Probe 0 is absent from this capture.** Search across all eight NDJSON files: zero `swarm_decode_slow`, zero `profile_started`, zero `profile_ended` events. The `heap_sample` events carry only `heapUsedMb` — no `swarmDecodeMaxMs`, `swarmDecodeAvgMs`, or `swarmDecodeCount` fields. `git grep` on `feat/perf-floor` for any of those identifiers returns nothing — the Probe 0 code was never landed before the capture was taken. Cadence confirms: 40 heap_samples over 53.5 s = **~0.75 Hz** (interval ~1320–1328 ms), the legacy 1 Hz tick, not the promised 10 Hz.

**This capture cannot discriminate H1 vs H2 directly.** It only carries the pre-existing instrumentation surface.

## The heap trajectory

Two distinct sawtooth cycles, both ending in a major GC:

| Window | Heap path | Notes |
|---|---|---|
| t=24.9 → 41.4 s | 43.81 → 69.66 MB (+25.8 MB / 16.5 s = **1.56 MB/s**) | growth during early gameplay |
| t=42.0 s | 41.52 MB | **major GC drop (-28 MB)** |
| t=43.0 → 77.0 s | 41.66 → 93.13 MB (+51.5 MB / 34 s = **1.52 MB/s**) | sustained allocation through combat |
| t=78.4 s | 47.56 MB | **major GC drop (-45.6 MB)** |

**Steady allocation pressure ~1.5 MB/s** during gameplay, indistinguishable between idle and combat windows at 1 Hz resolution. The two big drops are full GCs; we cannot see intermediate incremental-marking activity at 1 Hz.

## The binary swarm decode cost

**Not measured.** No swarmDecode fields exist in this capture. Cannot evaluate H2 directly. Indirect proxy: `swarm_near_enter` events at t=47, t=53, t=66, t=71–73 — drones within interest radius — coincide with the second growth phase, but so does everything else.

## Stall pattern

22 stalls > 100 ms. Distribution:

- **108–114 ms cluster**: 16 stalls — the suspect "110 ms" signature.
- **122–129 ms cluster**: 6 stalls.
- **Outliers**: 173, 207, 213 ms.

Timeline:
- t=23.4 s: 1 stall (early, in galaxy-map → game transition).
- t=36.0 s: 1 isolated stall (heap ~57 MB).
- **t=74.7–76.8 s: 11 stalls in 2.1 s** — the combat burst window. Heap was at ~87–93 MB, near pre-GC peak.
- **t=79.4–80.4 s: 9 stalls in 1 s** — post-GC, immediately after heap dropped from 93→47 MB.

Cross-check with `raf_gap.heapDeltaMbSinceLastStall`: the 74.7 s stall reports `+48.17 MB` heap delta since the *prior* stall (51 s earlier — the t=23.4 stall). Successive stalls inside the burst show ±5 MB jitter (small allocs between stalls).

## Verdict

**H3 is the data's best fit; H1 is a viable alternate; H2 cannot be ruled in or out from this capture.**

Evidence for H3 (below-JS / compositor):
- Stalls cluster tightly at 108–114 ms — a suspiciously uniform duration consistent with a fixed-size pipeline event (e.g., ~7 missed vsync frames at 60 Hz = 116 ms), not GC slices which would vary with heap size and survivor population.
- The t=79.4–80.4 s burst happens **immediately after** the major GC (93 → 47 MB at t=78). If H1 were dominant, stalls should *abate* post-GC — instead a 9-stall burst occurs in fresh-heap conditions.
- Total longtask count is only 6 (and 4 of them fire in a 100 ms window at t=81.26 s after the capture's game-end). The PerformanceObserver longtask API is not reporting these 110 ms stalls, which is consistent with stalls living below the JS-task layer.

Evidence for H1 (GC pacing) — secondary support, not refuted:
- 1.5 MB/s sustained allocation is real. The two full GCs land at ~70 MB and ~93 MB respectively, plausible incremental-marking budget territory.
- The t=74.7 s 12-stall burst peaks at heap = 93 MB, the highest pre-GC reading.

Evidence against H2 (binary swarm decode): **none, but only because we did not measure it.** The fact that stall bursts coincide with `swarm_near_enter` activity (t=71–73) is weak — drone presence is correlated with everything player-relevant.

**The 110 ms uniform cluster + persistence-through-GC + longtask invisibility together point at H3.** But the only way to definitively rule out H1/H2 is to land Probe 0 and re-capture.

**Next probe (required):** actually land the Probe 0 instrumentation before the next capture. Specifically: 10 Hz heap_sample with swarmDecode{Max,Avg,Count}Ms fields, swarm_decode_slow per-packet event, and profile_started/ended toggle. Until those events appear in NDJSON, H2 is being evaluated by absence-of-evidence which is invalid.

## Confidence

**Low.** The capture's instrumentation did not include Probe 0 — the entire premise of the analysis (cross-correlating swarmDecode with stalls at 10 Hz) is unmeasurable. What we can say with medium confidence: y2wpa5 is in a milder regime (3.4 % stalls) than the unplayable captures, the 110 ms cluster is real and uniform, and the post-GC burst weakens H1. What we cannot decide: whether decode cost spikes, whether incremental marking is the 110 ms slice cause, and whether the post-GC burst is below-JS or a tail of compactor work. Re-land Probe 0 and re-capture under the same scenario (similar combat density at similar heap pressure) before drawing fix-side conclusions.
