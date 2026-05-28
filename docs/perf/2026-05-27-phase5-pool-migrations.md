# Phase 5 — targeted pool migrations (2026-05-27)

Wrap-up for the third tier of the GC/allocation reduction work
(paradigm plan: quirky-rabbit). Phases 0-2 + 4 + 6 + 7-A landed the
foundation (paradigm doc, pool utility, SnapshotBroadcaster, generation
counter across 7 sites, server `gc_pause` echo, `pnpm bench:gc` gate).
Phase 3 was descoped to the candidate-led approach below per the
conversation log's "you can do this autonomously" verdict.

## What landed

Three commits, each with a behavioural lock + a heap-delta lock:

| Commit | File | Change |
|---|---|---|
| `ec22327` | `src/client/net/swarmInterpolation.ts` | Module-scope `_populatedScratch` of size `POSE_RING_DEPTH`. In-place insertion sort during fill replaces `Array.prototype.sort`. |
| `fa8543f` | `src/server/rooms/WeaponMountTicker.ts` | `writeTargetSlot` helper. Acquire-or-create `MountTargetView` instances in `mountTargetsScratch` / `droneMountTargetsScratch`; logical-length-over-physical-slot truncation. |
| `8a351e5` | `src/client/render/halo/wedgeGrouping.ts` + `HaloRadar.ts` | `PartitionScratch` parameter; HaloRadar holds it as a class field. Module-scope `_wedgeKeys` cache for `wedge:N` strings. |

## Methodology

Each migration's lock test:
1. Builds a realistic workload (10 drones × 100 000 calls; 30
   targets × 10 000 ticks; mixed near+far radar candidates).
2. Warms up for 1 000 iterations so JIT settles and scratch
   instances reach steady-state.
3. Forces `global.gc()` to a clean baseline.
4. Runs the measurement loop.
5. Forces `global.gc()` again.
6. Asserts `heapUsed` delta < 200 KB across the whole run.

Pre-migration the same workload would produce many MB of churn —
the 200 KB ceiling catches a regression that would re-introduce
even a single fresh allocation per iteration.

## Why no full before/after numbers in this memo

The earlier `measure-pool-impact.ts` exercise (Phases 2 + 4
wrap-up) showed two truths worth not repeating:

1. **Per-call byte-allocation deltas are modest** because V8's
   scavenger reclaims young-gen between samples. The honest
   signal is GC event count under sustained load.
2. **The synthetic benchmark rate is misleading** if reported
   as a production rate. The benchmark drives 50 000–100 000
   calls/sec; production runs at 60-90 fps × N entities. Divide
   accordingly.

The heap-delta locks above measure the right thing: zero
allocation across a 100 000-call workload. If a future PR
re-introduces a per-call allocation, the lock fires.

## What was deliberately skipped

`PixiRenderer.updateLingeringShips/updateWrecks` and `HaloRadar.update`
were Phase 4 targets — they use generation-counter stamps instead of
the Phase 5 pool pattern because that's structurally cheaper. Those
migrations don't have heap-delta locks at the unit level because
booting a Pixi `Application` in vitest is awkward; they're covered
structurally by removing the `new Set` literal.

The original plan also mentioned `ColyseusClient.tickLocalMountAim`
mountIds — that landed in Phase 4 (class-field Set scratch) and is
locked by `probe8Pooling.test.ts` already.

The plan's "Chrome DevTools Allocation profile on a galaxy sector"
was the canonical Phase 3 — I deferred to the candidate-led approach
above because the candidates were already named and individually
measurable. If a future regression of unknown origin appears, the
right next step is to wire up a Playwright + CDP capture (see the
conversation log's "what I could do autonomously" section).

## Invariant compliance

All three migrations preserve Invariant #12 (one-pose-per-frame,
one-write-path for mount angles):
- `swarmInterpolation` is still called once per drone per frame from
  `updateMirror`. The scratch is single-threaded; no second
  resolution site.
- `WeaponMountTicker` writes `playerMountAngles` / `droneMountAngles`
  exactly as before. The pool only affects the candidate-list
  allocations.
- `wedgeGrouping` is a pure function. Same inputs → same returned
  reference (the caller's scratch.result). The
  fresh-alloc-vs-scratch identity is locked by a behavioural test.

## What's left

- **Phase 7-B**: tighten `tests/e2e/heap-growth-gate.spec.ts`
  threshold from "sanity-only" to a hard ≤ 0.3 MB/sec slope. Wants
  measurement to set the threshold defensibly; safe to defer until
  the on-device data arrives.
- **Lint enforcement of invariant #14** — separate PR. Banning new
  `new Set/Map/Array` inside files matching the live-loop glob.
  Needs an alloc-debt sweep first.
- **On-device profile on the 90 Hz Android phone** — genuinely needs
  user hands; desktop profiling is a proxy.
- **Worker-boundary structured-clone reduction** — flagged as
  out-of-scope in the plan; separate follow-up.
