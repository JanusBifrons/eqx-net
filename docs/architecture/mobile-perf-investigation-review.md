# Hostile review of mobile-perf-investigation.md

> **SUPERSEDED (2026-05-24 EOD):** start at **[`docs/HANDOFF-mobile-perf-2026-05-24.md`](../HANDOFF-mobile-perf-2026-05-24.md)**. This review of the earliest diagnosis identified gaps that the subsequent probes (0-8) addressed; the fixes shipped are documented in the handoff doc. Kept here for historical traceability.

Reviewer's stance: the diagnosis is doing real work — it correctly demolishes the
worker-IPC narrative and correctly refuses to declare a winner — but several
of its load-bearing comparative claims are weaker than the prose suggests,
and at least one is plainly wrong. The recommendation toward option (c) is
under-evidenced; the agent's own data points harder at GC pressure than the
agent admits.

## Claims the diagnosis got RIGHT

- **Worker IPC is not the sole stall cause.** Confirmed: `su7udq/other.ndjson`
  and `x8hdwj/other.ndjson` both show `useWorker:false, workerParam:null`, and
  both still cluster gaps at the ~110-117 ms quantum. Commit `45400f3`'s
  "decisive" smoke pair is over-claimed.
- **The pre-pivot "spiral" framing as a generic prediction-window feedback
  loop is plausible.** `1fc0oe/corrections.ndjson` shows `ticksAhead 94-98`
  during the 49.5-52.9 s stall burst — same shape as `m6rq2t`'s, but the
  cause cannot be client-AI re-sim because that code was deleted three days
  earlier.
- **`applyMs` p50 is genuinely low** (su7udq: 0.5-5 ms after warmup; iph9cv:
  0.5-4 ms). The JSON snapshot reconcile is not the dominant cost.

## Claims that OVERREACH

- **"cfyb5r 0.90 % pre-pivot vs 1fc0oe 5.55 % post-pivot, same evening, ~25
  bots" is a bogus comparison.** cfyb5r captured only 27 s of client time
  (`timing.client.durationMs: 26995`) starting at `firstTs ≈ 68 s` — the
  diag stream came up *after* most of the session and the player
  disconnected at t=90.3 s. 1fc0oe captured 83 s starting at firstTs ≈ 2 s
  — full session incl. join, multiple galaxy-map↔game transitions, and a
  cross-sector transit (`population.ndjson` shows player count in
  sol-prime going 1→0 at server ts 1779130584, mid-stall-burst). The
  stall-rate denominators are not the same scene. **The 5.55 % figure is
  inflated by counting transit-window and sector-switch stalls.**

- **"The 110.7-110.9 ms cluster is present in every capture from pre-pivot
  through worker-off" is false.** `m6rq2t/perf.ndjson` has 5 raf_gaps —
  122, 122.1, 133.2, 188.6, 266.2 ms. **Zero in the 110-111 band.** The
  agent's flagship pre-pivot capture does not exhibit the cluster the
  diagnosis declares universal. cfyb5r has only two 111-ms gaps and three
  others at 133/166.5/277.5. The cluster is real in 1fc0oe, 721mwk, o4n4pw
  (in part), eajc6g (3 events), but absent from m6rq2t and weak in cfyb5r.

- **Two distinct clusters are being conflated.** su7udq and x8hdwj's
  *dominant* cluster sits at **116.4-116.7 ms**, shifted ~6 ms from the
  110.8 ms cluster the diagnosis names. su7udq: 24 of 61 gaps are in
  116.3-117.2; only 19 in 110.7-111.1. x8hdwj: 17 of 46 are 116.3-116.7;
  15 are 110.8-111.6. Either the frame-budget cap (60 Hz on a 90 Hz phone)
  introduced a NEW quantum at 7×16.6=116.7 ms post-`9e23436`, or there are
  multiple mechanisms. The "same quantum survives every fix" framing
  hides this.

- **"GC longtasks are not the cause" is contradicted by the captures the
  diagnosis itself cites.** Every su7udq and x8hdwj raf_gap event carries
  `heapDeltaMbSinceLastStall` and they sawtooth ±2-5 MB on virtually every
  110-117 ms stall, at ~110 ms spacing (msSinceLastStall 104-117). This
  is the textbook signature of V8 incremental-marking pauses — each
  individual GC slice stays under the 50 ms `PerformanceObserver` longtask
  threshold, but slices batch back-to-back inside a single rAF frame and
  surface as exactly the observed gaps. **The longtask-count
  falsification is a false negative:** longtask reports tasks ≥ 50 ms, GC
  pauses of 10-40 ms × 3-5 in a row inside one rAF window cross 110 ms
  total without ever crossing the longtask threshold.

- **"iph9cv spent most of its 99 s in galaxy-map phase" is wrong.** Its
  `lifecycle.ndjson` shows game-phase windows 6.3-39.7 (33.4 s) +
  44.4-57.9 (13.5 s) + 69.8-88.2 (18.4 s) + 91.9-106.8 (14.9 s) =
  **~80 s of game phase out of 99 s**, plus 78 combat events and 60
  fires. iph9cv is a *genuinely healthy* in-game capture, not a
  galaxy-map confound. The agent's hand-wave dilutes the strongest
  positive data point.

- **The May-22 drone-count is unobserved, but the agent treats it as
  N=25.** The diagnosis correctly notes `population.ndjson` is empty on
  those captures, then immediately writes "Hunter pool is unchanged at
  25." That's inferred from `LivingWorldDirector.ts:55` — which is
  defensible — but it skips an obvious alternative: a flaky Living World
  director (mid-development), a transit-only session that left the player
  in a low-density sector, etc. **The entire May-22 capture analysis is
  missing the key variable.**

- **The o4n4pw "healthy during combat" reading is partially correct but
  the interpretation is misleading.** o4n4pw shows ONE stall at t=8.6 s,
  then 0 stalls for 57.4 s, then 13 stalls clustered t=66-75 s. During
  that cluster, heap jumps 87 → 130 → 138 MB (a 40+ MB allocation surge
  in 7.5 s, sawtoothing on every stall). Combat *ends* near t=72.7 s; the
  stalls cluster around and after combat ends, exactly when GC would
  catch up on allocation backlog. Reading this as "healthy in combat" is
  technically true but obscures that the system was building allocation
  debt the whole time.

## Confounds the diagnosis did not address

- **`applyMs` excludes the binary swarm channel.** The
  `snapshot_applied` event measures `handleSnapshot()` for the JSON
  message only. The binary `swarm` packet (60 Hz when in-interest)
  is decoded + `syncSwarmIntoPredWorld()` is called with NO timing
  instrumentation (`ColyseusClient.ts` around line 1010 on
  `feat/perf-floor`). The agent's "reconcile is not the cost"
  conclusion silently excludes the post-pivot dominant per-frame
  surface.

- **`interpolateSwarmPose` allocates per drone per frame.**
  `swarmInterpolation.ts:150` builds `const populated: PoseRingEntry[]
  = []` and `populated.sort()` PER drone PER frame. With ~25 in-interest
  drones at 60 Hz this is ~1500 small array allocations/s plus the
  comparator closure cost. The agent acknowledges this then dismisses it
  on longtask grounds — which is the bad reasoning step (see GC point
  above). The comment at line 149 ("Allocating a 3-slot scratch each
  call is fine — JIT inlines it") is an assumption, not a measurement.

- **Drawer / galaxy-map open state during stalls is unchecked.** 1fc0oe
  spent t=59.3-62.5 s in galaxy-map, then re-entered game — the stall
  cluster sits right around that transition. iph9cv had four game↔map
  transitions and only 3 stalls. The "drawer-open is a perf hazard"
  story from `docs/LESSONS.md` 2026-05-13 is not investigated at all.

- **Sector-transit stalls.** 1fc0oe's largest stalls (488.3, 332.8, 255.3
  at t=9.7-10.6) happen during the initial join+spawn; the next cluster
  (110.9 × 6) happens around server ts 1779130584 when the player
  transitioned from sol-prime to cygnus-arm. These should be excluded
  from steady-state stall accounting.

- **The user's "broke past ~10 drones" report is not reconciled with the
  m6rq2t evidence.** The agent leans on m6rq2t (24 bots) as the canonical
  pre-pivot spiral, but the user said lockstep broke at N≈10. If the user
  is right, the spiral mechanism was triggering well before Living World
  pushed density to 24, and the "Living-World-induced, not intrinsic"
  framing is too generous. The agent should have read `af605ec`'s test
  fixture (the `feel-test-lockstep` canary at 10) and asked whether 10
  was *symptomatic* or *asymptomatic*.

## Hypotheses worth adding to the candidate set

1. **V8 incremental-marking pacing is the 110 ms quantum.** Strong prior
   given the sawtooth heap deltas. Testable: same scene with
   `--js-flags=--max-old-space-size=512` vs default; or capture
   `chrome://tracing` GC categories alongside diag stream.
2. **`syncSwarmIntoPredWorld` per-frame writes are the allocation
   source.** Each entity does `setShipState(id, x, y, vx, vy, angle,
   angvel)` per frame; if Rapier's wrapper allocates a transform object
   internally this is ~25 × allocation/frame on top of
   `interpolateSwarmPose`'s ~25.
3. **60 Hz internal cap on 90 Hz phone may have created the 116 ms
   cluster** (post-`9e23436`). 7 × 16.67 ms = 116.7 ms — exactly the new
   peak. The cap may delay enough work into one rAF that the GC pause
   that follows pushes the gap to 7 frames instead of 6.
4. **Touch dispatch during stalls** — not tested; the diag stream has
   `inputSent` events with timestamps. Worth correlating.

## Verdict on the recommendation

The agent's lean toward option (c) is **under-evidenced**. The strongest
single result in the captures is the heap-sawtooth pattern in su7udq,
x8hdwj, and o4n4pw post-combat — which directly indicts an
**allocation-rate / GC pacing** problem orthogonal to both Living World
density and to the lockstep-vs-snapshot-interp choice. Throttling
Living World to N=0 may reduce allocation pressure but probably won't
eliminate the 110 ms quantum; we'd be solving the symptom by removing
a workload, not by fixing the underlying behaviour. **Probe (2)
(below-JS instrumentation) should come first.** Probe (1) (N=0 vs N=25)
is still cheap and worth doing in parallel, but the agent ranking it
first treats the population narrative as more probable than the GC
narrative without giving the evidence its due.

A cheaper probe the agent missed: **`PerformanceObserver` with
`type: "longtask", buffered: true` AND `type: "measure"` recording
`performance.measure('gc', { detail: navigator.deviceMemory })`** —
combined with `performance.memory.usedJSHeapSize` polled at every rAF
(already in the diag stream) — can localise GC vs non-GC stalls
without leaving JS-land. Even cheaper: **a one-line `console.profile()`
toggle wired to a query-param** so the user can submit a Chrome DevTools
recording from the actual phone session that produced a bad capture.

## Honest uncertainties

- Whether the 110.8 / 116.5 / 117.0 quanta share a single mechanism or
  three. The data doesn't separate them.
- Whether the iph9cv vs su7udq stall delta is explained by activity
  (combat presence) or by some startup vs warmed-state difference (e.g.
  Pixi texture upload finishing, asset cache priming). iph9cv had 60
  fires and 78 combat events; su7udq had 0 fires and 0 combat. The
  agent doesn't engage with this.
- Whether the heap-sawtooth pattern is *cause* or *symptom*. A
  per-frame allocation surge causes GC pacing; an unrelated stall might
  also free GC-pending memory and show a delta. Distinguishing requires
  tracing.
- Whether the user's "broke past 10 drones" recollection refers to
  perceived smoothness, observed correction rate, or something else
  entirely. Without re-querying the user, the diagnosis's choice to
  treat 24 as the failure threshold is unjustified.
