# Phase 2 — Triage (honest read of the snapshot diff)

## The data invalidates the plan's premise

The plan assumed surviving heap growth would name a pool-able user-code allocator. The diff instead shows the 830 KB / 25 s survived growth is dominated by V8 INTERNALS — JIT-compiled code chunks, system arrays, and code wrappers.

### Top-20 breakdown by kind

| Bucket | Sum (KB) | % of growth |
|---|---:|---:|
| V8 JIT / code internals (`code` type) | 587.4 | **71 %** |
| V8 system arrays + wrappers (`system / TrustedByteArray`, `WeakArrayList`, `ProtectedFixedArray`, `SharedFunctionInfoWrapper`, `CodeWrapper`, `FeedbackVector`, etc.) | 218.6 | 26 % |
| Browser native (`PerformanceLongAnimationFrameTiming`, `TaskAttributionTiming`, `PerformanceLongTaskTiming`) | 10.5 | 1 % |
| **User-code Object instances** | **16.6 KB (777 instances)** | **2 %** |
| **User-code heap numbers (boxed)** | **15.1 KB (1290 instances)** | **2 %** |
| WASM module overhead | 2.9 | <1 % |

The user-code survivors total **31.7 KB across the 25 s window** — ~1.3 KB/s of survived allocation. That's an order of magnitude SMALLER than the churn rate the phone capture showed (~970 KB/s).

## What this means for GC pause length

V8's major-GC pause time is roughly proportional to **live-set size** (mark + sweep traversal), not allocation rate. The phone's ~48 MB live heap is dominated by libraries (React, Pixi, MUI, Colyseus) + V8 system overhead. Pooling 31 KB of user-code Objects across a 25 s session won't measurably move 48 MB → 47 MB. The major-GC pause length won't change.

The **young-generation churn** of 970 KB/s drives major-GC FREQUENCY (faster the new-gen fills, faster things get promoted to old-gen, sooner major-GC fires). But snapshot diff measures SURVIVORS, not churn. So the diff doesn't surface the right allocators for the frequency angle either.

## The first JIT-warmup confound

The +473 KB `code` (rank 1) and +199 instances of various V8 code-related types (ProtectedFixedArray, TrustedWeakFixedArray, CodeWrapper, SharedFunctionInfoWrapper, FeedbackVector — all 199 counts) point at ONE thing: **199 functions got V8-optimized between t=5 s and t=30 s**. That's normal JIT-warmup, not a fixable allocator. A longer warmup before snap-t05 (say 20 s of held-fire) would push most of these out of the diff.

## Where this leaves the plan

The plan's TDD fix-loop has no top-3 to point at. The user-code survivors (Object +777, heap number +1290) are small and would need retainer-chain analysis (currently un-implemented in the diff utility) to localise to a specific call site. Even if pooled, the impact would be sub-1 % of the felt stutter mechanism.

## Honest options forward

This is exactly the "honesty section" risk from the plan: "the snapshot-diff top growers are V8/library internals we can't reach without library work." The mitigation was "surface to the user honestly + propose the alternate path".

The alternate paths:

**A.** **Switch back to CDP `HeapProfiler.startSampling` with tighter sampling interval** (128 or 256 bytes vs round-1's 1024). This captures small-but-frequent allocations the original sampling missed. Then target the next-ranked allocators (after r1 dropped `gameRafLoop.loop`). Expected candidates: `WarpScreen.tick` (16.6 KB / 2.2 % in post-r1 profile), `logEvent` cumulative, the per-snapshot literals in `handleDamage`. Modest impact (~2-5 % each) but tractable.

**B.** **Pivot to allocation-timeline tracking** via `HeapProfiler.startTrackingHeapObjects` (records all allocations with stack traces, heavyweight). Definitive on rate; replaces sampling with full coverage but produces large output to analyse.

**C.** **Pivot to the server-side `recv_gap_long` issue** (out of original plan scope, but the data names it). The 6 events with 230-560 ms gaps had ZERO longtask overlap — these are real server silences likely from `SectorRoom` tick budget / TiDi ramp / snapshot scheduler. Fixing this DIRECTLY addresses drone-snap visuals because the buffer underrun is what causes the visible jump on snapshot resume. Different code zone but more on-target for the user's complaint.

**D.** **Pivot to Pixi / React work-reduction** for the worst longtasks (370-457 ms cluster around phase transitions). These aren't allocation-driven; they're Pixi sprite-setup + React reconciliation. Different mechanism, different fix shape.

**E.** **Accept the current state**. R1 was a real improvement (rank-1 allocator gone, JIT-warmup cleaner) even though it didn't move felt stutter measurably. Merge to main, move on to other gameplay work. The felt stutter floor we've reached may be the natural limit of what client-side allocation discipline can achieve with this library stack.

## Recommendation

The data points hardest at **C (server-side recv_gap_long)** as the highest-yield-for-effort path. The data:
- recv_gap_long events have zero longtask overlap → they're not client-GC-induced
- They produce 230-560 ms of snapshot starvation → buffer underrun → drone freeze → snap on resume → "drones jumping"
- The mechanism directly matches the user's complaint
- Server-side work is independent of client allocation discipline (no interaction with r1's fix)

But this is the user's call. The plan deliberately scoped this round to **client allocation**; pivoting to **server snapshot scheduling** is a real scope change that deserves user input.
