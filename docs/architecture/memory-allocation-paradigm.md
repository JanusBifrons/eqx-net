# Memory Allocation Paradigm

> **The most important sentence in this document**: *every allocation inside a 60 Hz / 90 Hz hot loop is a future GC pause we paid for with frame budget we don't have.*

This is the rulebook for memory allocation in EQX Peri's hot loops. It exists because GC pauses are the largest single non-deterministic variable inside our 16.67 ms physics budget and the dominant source of the on-device `raf_gap > 100 ms` cluster spikes documented in [`mobile-perf-investigation.md`](./mobile-perf-investigation.md). The cure is paradigmatic, not surgical — clear-and-reuse over construct-and-discard, everywhere on the live loop.

The paradigm is encoded as **Invariant #14** in root [`CLAUDE.md`](../../CLAUDE.md). This document is the long form; the invariant is the one-liner reviewers see.

---

## Why GC matters in a real-time game loop

V8 uses a **generational** garbage collector. Memory is split into two regions, each with a different reclamation strategy:

- **Young generation (Scavenge / Minor GC).** Small (~16 MB), copying collector. Pauses are typically <1 ms but their **cadence is set by allocation pressure** — every byte allocated brings the next Scavenge closer. Fast individually, expensive collectively.
- **Old generation (Mark-Sweep-Compact / Major GC).** Big, slow. Pauses on a hot heap routinely cross the 5 ms threshold we already alarm at via [`GcMonitor`](../../src/server/debug/GcMonitor.ts) (`GC_PAUSE_THRESHOLD_MS = 5`) and can stretch to **50 ms+** under sustained churn. A single 8 ms MSC pause inside a 16.67 ms physics frame is a missed tick — anything worse is a visible stutter.

The cadences this codebase must respect:

| Loop | Rate | What allocation costs us |
|---|---|---|
| Server physics tick | 60 Hz (fixed) | Each Scavenge cycle eats into the tick budget |
| Server snapshot broadcast | 20 Hz | Per-client snapshot allocations multiply by N players |
| Server binary swarm wire | ~60 Hz | Encoder runs every tick per client |
| **Client RAF (the user's 90 Hz phone)** | **device-native, capped to ~100 fps** | Per-frame allocations fire 60–100 times/sec; mobile feels the GC tail |
| Client `tickPhysics()` | 60 Hz (wall-clock-anchored) | Catches up after a stall — replays of multiple ticks back-to-back |
| Client `interpolateSwarmPose` | 1× per RAF per in-interest entity | Invariant #12 (one-pose-per-frame); ~5-10 entities/frame production |

The 90 Hz device is the worst-case allocator pressure point — the [`DEFAULT_MIN_FRAME_INTERVAL_MS = 10`](../../src/client/perf/frameRateCap.ts) cap throttles 120 Hz devices to ~60 fps but leaves 90 Hz uncapped.

### The academic foundation

Three references explain why "just allocate more RAM" doesn't work:

1. **Bell, 1976 — *List Processing in Real Time on a Serial Computer*.** Foundational work on the **generational hypothesis**: "most objects die young." V8's generational structure inherits this assumption. The hypothesis is helpful when it holds (a frame-local scratch object dies fast) and brutal when it doesn't (a pooled object lives long enough to be promoted to old-gen, paying MSC scan cost forever).
2. **Ungar, 1984 — *Generation Scavenging: A Non-disruptive High Performance Storage Reclamation Algorithm*.** The actual algorithm V8's Scavenger inherits. Two semi-spaces, copying. Pause time scales with **live young-gen size**, not with allocated bytes — so reducing allocation rate reduces Scavenge frequency, which is what we care about.
3. **Hertz & Berger, OOPSLA 2005 — *Quantifying the Performance of Garbage Collection vs Explicit Memory Management*.** The decisive measurement: GC overhead is **17%+ of runtime when the heap headroom is less than 3× live set, climbing to 70% at 1.5×**. Mobile devices have constrained RAM; we cannot fix GC overhead by adding memory. We have to **reduce live-set churn**.

Jones, Hosking & Moss, *The Garbage Collection Handbook* (2nd ed., 2023), ch. 9 covers object pooling and freelists — the body of literature this codebase implements ad-hoc.

---

## The paradigm — five rules

### R1: No new allocations in the hot loop

From this PR forward, **no new `new`, `{}`, `[]`, `.map`/`.filter`/`.slice`, template literals over module-cached strings, or `Array.from` inside any function called transitively from**:

- `update()` (server room tick)
- `tick()` (any system tick)
- `render()` / RAF callback (client renderer)
- `handleSnapshot()` (client snapshot ingestion)
- `tickPhysics()` (client wall-clock-anchored input loop)
- `onMessage()` (server message handler)

Existing pre-landed allocations are technical debt — they are tolerated for now but get `// TODO: alloc-debt` markers when touched. We commit to **forward progress**, not a backfill audit we won't complete.

Lint enforcement is a deliberate **follow-up PR**, not this one. The rule is a code-review contract today; an `eslint-plugin-no-restricted-syntax` rule banning `new Set/Map/Array` inside live-loop file globs lands later, after the alloc-debt backfill.

### R2: Reuse > recycle > construct

In order of preference:
1. **Module-scope or class-field scratch** that lives as long as the consumer. Lowest overhead; no pool bookkeeping.
2. **Pool acquire / release** from [`src/core/pool/`](../../src/core/pool/) helpers when the consumer has a discontinuous lifetime (per-frame, per-snapshot, per-tick) and a small bounded count.
3. **Fresh allocation** — never in the hot loop.

Match the pool cadence to the consumer cadence. A per-frame pool can't be served by per-snapshot acquires.

### R3: Typed arrays > object arrays for numeric, stable-shape data

`Float32Array` of 10 numbers reuses the same buffer slot every tick. `Array<{x, y, z}>` of 10 objects allocates 10 object headers, 10 hidden-class transitions, and 10 GC root scans per refresh. The wire format ([`swarmWireFormat.ts`](../../src/shared-types/swarmWireFormat.ts)) and the lag-comp ring ([`SnapshotRing.ts`](../../src/server/lagcomp/SnapshotRing.ts)) both follow this rule — copy them.

### R4: `Set/Map.clear()` is NOT always free

V8 frees the backing `OrderedHashTable` on `.clear()` for Sets/Maps with **more than ~16 entries**. Pooling these via `RecyclableSet` only wins when:
- The typical population is **small** (<16 entries), AND
- The population is **stable** (doesn't repeatedly grow past 16 and back).

For a Set that holds 0–3 lingering hull IDs across all frames, pooling saves ~32 bytes of object header per acquire. For a Set that swells to 100 entries on a full-snapshot keyframe and back to 0, `.clear()` already free the backing arena and the pool wins nothing.

**Bench-verify before adopting** on any new candidate; don't pool by reflex.

### R5: Prefer generation-counter over Set-of-seen for cache reconciliation

The idiom
```ts
const seen = new Set<string>();
for (const id of incoming) { seen.add(id); /* update cache[id] */ }
for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id);
```
is alloc-positive (a fresh Set per call) AND O(N) clear cost. The **zero-allocation equivalent**:
```ts
this._frameId++;
for (const id of incoming) { /* update cache[id]; cache[id].stamp = this._frameId */ }
for (const [id, entry] of cache) if (entry.stamp !== this._frameId) cache.delete(id);
```

No Set, no pool, no clear. Faster than even a pooled Set in every measured workload. Apply this pattern wherever the underlying intent is "reconcile cache against the current frame's input set."

`Number.MAX_SAFE_INTEGER / 90 fps` ≈ a trillion years until wraparound — irrelevant.

---

## Canonical exemplars (study these before adding new patterns)

| Pattern | File | What to copy |
|---|---|---|
| **Pre-allocated typed-array ring** | [`src/server/lagcomp/SnapshotRing.ts`](../../src/server/lagcomp/SnapshotRing.ts) | 192 KB Float32 buffer; zero allocs per record |
| **Fixed-cap pool with state machine** | [`src/server/livingworld/director/HunterBotPool.ts`](../../src/server/livingworld/director/HunterBotPool.ts) | 25 hunter bots; idempotent state transitions |
| **Freelist of integer slots** | [`src/server/net/SwarmEntityRegistry.ts:66-77`](../../src/server/net/SwarmEntityRegistry.ts) | `freeEntityIds.pop()` reuses entity slot indices |
| **Single ArrayBuffer reused per tick** | [`src/server/net/BinarySwarmBroadcast.ts:54-56`](../../src/server/net/BinarySwarmBroadcast.ts) | Encoder owns its buffer; emits subarray views |
| **In-place decode into pre-allocated ring** | [`src/client/net/BinarySwarmDecoder.ts`](../../src/client/net/BinarySwarmDecoder.ts) | `poseRing` slots are mutated, never recreated |
| **Capped pool with LIFO eviction** | [`src/client/render/DamageNumbers.ts`](../../src/client/render/DamageNumbers.ts) | `POOL_CAP = 20`; oldest evicted under churn |
| **Mutate-in-place on snapshot rebuild** | [`src/client/net/SnapshotSyncHelpers.ts:42-59`](../../src/client/net/SnapshotSyncHelpers.ts) | Probe-8 pattern: update entry fields, don't replace |

---

## Anti-patterns from the wild

These are the false-positive and real-positive shapes the GC-optimisation audit kept hitting. Recognise them.

### "Looks hot, isn't" — idempotent constructor

[`MountVisualManager.ts:107`](../../src/client/render/MountVisualManager.ts) early-returns on `clusters.has(shipId)`. The `new Map<string, MountGraphics>()` two lines later fires **once per ship lifetime**, not per frame. Greppable but not hot.

### "Lazy alloc looks per-tick, fires once per spawn"

[`WeaponMountTicker.ts:163`](../../src/server/rooms/WeaponMountTicker.ts) — `new Float32Array(mounts.length)` only when `mounts.length !== angles.length`. Mount counts are **immutable per ship lifetime** (Invariant #11 — ship-kind catalogue is append-only), so this alloc fires once per spawn, not per tick. Don't pool it.

### "Build Set, sweep cache" (real, and very common)

The dominant alloc-positive pattern across the renderer and the snapshot path. See R5. Replace with generation counter; do **not** reach for a Set pool.

### "Pool the Float32Array by length"

Trap: looks principled, costs more than it saves when mount counts are 1–4 and constant. The savings are per-spawn, not per-frame. Skip unless the same pool serves a per-frame consumer.

### "Use `usedJSHeapSize` to compute an allocation rate"

`performance.memory.usedJSHeapSize` is a **post-GC sample**, not a continuous counter. Between collections it does not move. A "rate" computed from it is sawtooth noise dominated by GC cadence, not allocation pressure. Use [`PerformanceObserver({entryTypes: ['gc']})`](https://web.dev/articles/monitor-total-page-memory-usage) on Chromium, or echo the server's [`GcMonitor`](../../src/server/debug/GcMonitor.ts) `gc_pause` events to the client.

---

## Code-review checklist

When reviewing any PR that touches a file under `src/client/render/**`, `src/client/net/**`, `src/server/rooms/**`, or any function called from the hot-loop entry points (R1):

- [ ] Any new `new Set/Map/Array/Float32Array/...` inside a hot-loop callee? → reject; use module-scope scratch or `src/core/pool/`.
- [ ] Any new `[...x]`, `.map`, `.filter`, `.slice`, `.concat`, `Array.from`, `Object.keys/values/entries`, `JSON.parse/stringify`, `structuredClone` in a hot-loop callee? → reject; manual loop into scratch.
- [ ] Any new template literal `` `${...}` `` building a key string in a hot-loop callee? → reject or cache the result at module scope.
- [ ] Any new "build a Set of seen IDs, then sweep" pattern? → R5 violation; use generation counter.
- [ ] Pool consumer? Is the `release()` paired in every exit path (including thrown exceptions and early returns)?
- [ ] Pool consumer? Is the pool sized for the **realistic** worst-case (not the engineering-room peak)?
- [ ] Does the change preserve Invariant #12 (one-pose-per-frame, one ownership site for mount angles)?
- [ ] If the change touches `ColyseusClient` / prediction / snapshot / render: is `pnpm e2e:netgate` baseline-relative-green?
- [ ] Did you bench-verify R4 for any new Set/Map pool? Document the measured population range in a comment.

---

## What this paradigm does NOT cover

These are deliberately out of scope; flagged here so they don't accidentally land under the #14 umbrella:

- **Pixi internals** — `Graphics` geometry rebuilds, `Text` texture churn. We don't control them. Document residuals; don't fork Pixi.
- **Worker IPC structured-clone overhead** — separate allocator-pressure source on the OffscreenCanvas boundary. Owns its own follow-up plan.
- **Colyseus schema-diff serialiser** — closed-source allocator behaviour. We feed it; we don't tune it.
- **Backfill of pre-existing alloc-debt** — `// TODO: alloc-debt` markers exist for triage but a full audit is a separate, deliberate project.

---

## Deferred follow-up: numeric ID interner

`Set<string>` and `Map<string, T>` on hot paths frequently key on entity IDs (`'swarm-123'`, shipInstanceId UUIDs, mount IDs). Migrating to numeric IDs via an interner would cut allocations across many call sites because:
- Numeric IDs avoid string-concatenation allocations at every callsite that builds a key.
- `Set<number>` / `Map<number, T>` benefit from V8's `SMI` (small integer) optimisations — backing stores are flat number arrays, not hash tables.

Deferred because the migration touches many files at once and the smaller-blast-radius pooling work has to land first. Tracked as the "Phase 2 paradigm rollout" follow-up plan.

---

## Why we documented this as a paradigm and not as point-fixes

Point fixes regress. Three months from now someone adds `const seen = new Set<string>()` to a new renderer method, the diff is +3 lines, and it ships because nobody remembered why we were nervous about it.

A paradigm is a load-bearing rule that survives the people who wrote it. Invariant #14 is the one-liner reviewers see; this document is the why. Future PRs that violate the paradigm get rejected against the rule, not against a benchmark — and the rule is here in writing so the rejection is impersonal.
