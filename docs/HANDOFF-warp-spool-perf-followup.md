# HANDOFF — warp-spool frame cost (RESOLVED 2026-05-16 — arrival prediction drift, test-locked)

Live worklog for the deferred warp performance item. Supersedes the
"OPEN" section of `docs/HANDOFF-warp-perf-2026-05-15.md` (which is
preserved as the as-of-end-of-session record). Branch for the work:
**`perf/warp-spool-frame-cost`** (cut from `main` after the
`wip/pixi-filters-warp` merge so it carries the merged warp code).

> User priority: this is the **headline** post-merge defect — "works in
> the sandbox, lags badly in game." It MUST be done **data-driven**:
> instrument → measure → attribute → fix only what the data indicts.
> Estimated-ms hypotheses below are to be *tested*, never acted on blind
> (Invariant #13 + the "on-device-evidence over theory" lesson).

## Symptom & evidence (verbatim)

The warp filter chain is **smooth in the visual-effects sandbox** but
**lags badly in the actual game**. Diagnostic
`diag/captures/2026-05-15T22-08-40-272Z-s3b9l8`:

- ~29 ms mean frame confined to the spool window (ts 16895–20492) —
  exactly when the fullscreen filter chain is active on a DPR≈2.6
  mobile GPU.
- 4 `raf_gap`s (116–183 ms) — **all** at the transit room-swap boundary
  (ts 20321, 20532, 20869, 25961). Transient handoff cost, not steady.
- The capture **cannot** attribute filters-vs-labels.

## The decisive clue: sandbox vs game

The sandbox (`src/client/__offscreen-spike__/visual-effects-sandbox-main.ts`)
runs the **same** OffscreenCanvas worker + the **same** filter chain and
is smooth. So the lag is **contention with the in-game per-frame
workload, not the shaders themselves.** What the sandbox does NOT do that
the game does (the differential to measure):

1. **BackgroundGrid label `Text` churn** — `computeGridLabels` is O(n²)
   over the padded window; during spool the camera pans fast (ship flies
   ~539 u) so labels create/destroy every frame. (`BackgroundGrid.ts`.)
2. **Per-frame `RenderMirror` structured-clone** across the
   `WorkerRendererClient → worker` postMessage boundary — scales with
   entity count; sandbox has 1 ship. (`WorkerRendererClient.ts:282`,
   `protocol.ts`.)
3. **Per-frame mirror rebuild** (`ColyseusClient.updateMirror`,
   ~`:2413`) + snapshot apply.
4. The 4 `raf_gap`s look like a **separate** transit room-swap stall
   (Colyseus re-subscription / new-sector entity sync), not steady spool
   cost.

UNVERIFIED hypothesis from code-reading only: `tickWarpShockwaves` is
~1–2 ms/frame and **not** the bottleneck. **Do not lighten the filter
chain on this hypothesis** — the markers (F2) decide.

## Plan (data-driven; Invariant #13)

**F1 — Instrument (the "measuring test first"). DESIGN VERIFIED FROM
CODE 2026-05-16 — turnkey; one architectural decision flagged.**

*Sink* — `logEvent(tag,data)` at `src/client/debug/ClientLogger.ts:29`
pushes `{ts:performance.now(),tag,data}` to a 2000-entry ring exposed as
`window.__eqxLogs`; server route `src/server/routes/diagRouter.ts`
(`POST /diag/capture`, `BUCKETS` ~L36-90) buckets by tag into
`<capture>/<bucket>.ndjson`. **No gate** — `logEvent` is already
unconditionally per-frame (`rafTick`/`raf_gap`); a blanket gate would
regress E2E specs reading `window.__eqxLogs`. Markers use the same
always-on model (capture is the opt-in via the diag route). Add the 5
tags to `BUCKETS → 'perf'` so they land in `perf.ndjson`.

*Boundary (DECISION REQUIRED before coding)* — `PixiRenderer` runs in
the worker (`renderer.worker.ts`); no `window.__eqxLogs` there.
`renderer_update`/`warp_tick`/`grid_update` must cross to main. Minimal
channel = one optional `markers?` field on `RendererFeedback`
(`src/core/contracts/IRenderer.ts:269`) piggybacking the existing
per-frame `FEEDBACK` postMessage (no new message type; ~40 B vs the
KB-scale mirror going the other way). **BUT `RendererFeedback`'s
docstring + `src/client/CLAUDE.md` mandate a phase-gate review for any
new field** (every entry expands the worker→main per-frame payload).
Options: (a) accept the optional diag-only field, review noted; (b) a
separate `FRAME_MARKERS` worker→main message (no contract change; +1
`protocol.ts` variant + a worker-side enable). Choose first.

*Verified anchors (✓ read 2026-05-16)* —
`ClientLogger.ts:29` logEvent / :34 installWindowLogger;
`protocol.ts` FeedbackMsg@333, WorkerToMainMsg@357, MirrorUpdateMsg@49;
`IRenderer.ts` RendererFeedback@269 (closed-set, phase-gated);
`PixiRenderer.ts` feedback field@532, update()@806, feedback-populate
block@1331-1357, tickWarpShockwaves@1741, getFeedback@2005;
`BackgroundGrid.ts` update()@128, computeGridLabels caller + Text-create
loop ~186-203, cleanup/destroy loop ~206-211 (the split point);
`ColyseusClient.ts` updateMirror()@~2413 (MAIN, direct logEvent);
`WorkerRendererClient.ts` update()@~282 (MAIN, bracket the
`this.post({type:'MIRROR_UPDATE',mirror})`), FEEDBACK receive handler =
where worker markers re-emit via logEvent.

*The 5 markers* — `renderer_update {totalMs,spriteCount}` (worker),
`warp_tick {totalMs,filterCount}` (worker), `grid_update {labelSpecMs,
textCreateMs,cleanupMs,labelCount}` (worker), `mirror_rebuild {totalMs}`
(main, ColyseusClient), `mirror_clone {costMs,approxBytes:
JSON.stringify(mirror).length}` (main, WorkerRendererClient). Worker
ones collect into a per-frame object, ship via the chosen boundary,
main re-emits each via `logEvent`.

*Analyzer* — new `scripts/analyze-frame-markers.mjs` (NOT
`analyze-cdp-profile.mjs` — that reads a `.cpuprofile`). Read a capture
dir's `perf.ndjson` (+`raf.ndjson` for frame boundaries), filter the 5
tags, compute mean/p50/p95/max **within the spool window** (handoff
cites client `ts` 16895–20492) and **at the transit boundary** (raf_gaps
ts 20321/20532/20869/25961) separately, plus residual = frame −
Σ(markers) ⇒ GPU/other. Line shape:
`{"source":"client","ts":<perfNow>,"tag":<tag>,"data":{...}}`.

*Budget check* — `performance.now()` brackets are sub-µs; confirm a
markers-off vs markers-on baseline frame-time delta is within noise
before trusting F2 numbers.

**F2 — Reproduce in Playwright FIRST; attribute.** Automated repro is
the first attempt — drive join→spool→arrival in a Playwright scenario
emitting a capture; escalate *within Playwright* (device-emulation
viewport/DPR, CDP CPU/GPU throttling, a mobile project) if desktop
under-represents the DPR≈2.6 mobile GPU. **The user's phone / a fresh
on-device capture is a LAST RESORT**, only after the automated path
provably can't surface the cost, stated with evidence (their manual
bandwidth is finite — Invariant #13). Also analyze the existing
`…s3b9l8` capture. Output: a ranked attribution table. This table — not
the hypotheses above — gates F3.

### F2 RESULT — 2026-05-16 — DECISIVE (CPU hypotheses refuted)

Automated capture `tests/e2e/warp-spool-perf-capture.spec.ts` →
`diag/captures/2026-05-16T09-52-00-799Z-cmilox`, F1 markers active,
~100 frames. Analyzer (`scripts/analyze-frame-markers.mjs`) per-marker
mean (ms): `renderer_update` 0.54 · `warp_tick` **0.04** · `grid_update`
**0.12** · `mirror_rebuild` **0.05** · `mirror_clone` **0.15**.
**Σ all instrumented CPU = 0.89 ms.** FRAME mean ≈ 69 ms ⇒ **residual
(frame − Σ) ≈ 68.7 ms (98.7 %) = GPU / compositor / pipeline.**

VERDICT: every CPU hypothesis is **refuted with data** — grid-label
`Text` churn (the prior *leading* suspect) 0.12 ms; mirror
structured-clone 0.15 ms; mirror rebuild 0.05 ms; warp filter CPU tick
0.04 ms. The cost is **NOT CPU**; it is the GPU/compositor/pipeline
residual. The grid/mirror theories are dead. The original "is it the
filters?" instinct was directionally right but specifically the
**GPU shader-fill of the fullscreen chain**, whose CPU tick we measured
at ≈0 and whose fill cost lands in no CPU bracket.

CAVEAT: headless-desktop Playwright capture — the ~69 ms ABSOLUTE is
CDP/headless-GPU inflated, **not** the mobile number. The robust,
portable result is the **relative** one (CPU sub-costs <1 ms vs ~70 ms
frame ⇒ CPU exonerated on any device; DPR≈2.6 mobile = ≈7× the filter
fill pixels). Open isolation, still automated-first: (a) on-device
`?diag=1` + Settings→Capture Diagnostic capture (real mobile GPU —
confirms/quantifies; the now-legitimate user-device step); (b)
in-Playwright A/B filter-chain on vs off to prove the residual *is* the
filter shader-fill (vs pipeline/CDP).

**F3 — Fix the data-indicted cost (GPU fill, NOT CPU).** The CPU-path
options are CLOSED by F2. Direction: reduce the fullscreen warp filter
chain's GPU fill on high-DPR / coarse-pointer — cap the filter
render-target `resolution` / tighten `filterArea`, fewer `ShockwaveFilter`
layers, lower `BloomFilter` quality/kernelSize, and/or shorter spool on
coarse-pointer — gated so desktop is unchanged. Confirm the residual IS
the filter pass (on-device + filter-on/off A/B) BEFORE the fix. ONE
principled change, before/after capture proof, no blind stacking.

### F2 ON-DEVICE CONFIRM — 2026-05-16 (phone capture `…jgimvi`)

Real device: Android 10 / Chrome 148 Mobile, viewport 411×809; ~6.5 s
join-warp smoke (`?diag=1`). Analyzer: **steady FRAME p50/p95 = 16.6 /
16.8 ms ≈ a clean 60 fps.** Σ all CPU markers **2.48 ms**
(`renderer_update` 1.76 the largest; `grid_update` 0.45; `mirror_clone`
0.18; `mirror_rebuild` 0.07; `warp_tick` 0.016). **CPU exonerated on
real mobile — confirms the F2 desktop result; the lightened filter
chain performs fine at mobile DPR.**

The ONLY blemish: a **single transient ~133 ms frame** at ts ≈ 18650 =
the **warp→game handoff teardown** — a 51 ms `self` longtask
(18628–18679) + a React `component_unmount` @ 18677.5 coinciding with
the 132.9 ms rafTick; `renderer_update` stays ~1–2 ms across it (the
spike is **residual**, not CPU). Matches the user's "lag spike but
otherwise okay" exactly. Not sustained; partly masked by the arrival
curtain/flash.

**F3 — REVISED TARGET (if pursued at all).** The warp is healthy
on-device; this is optional polish, not a correctness blocker (user
bar: "otherwise okay / move on if no issues"). IF pursued: target the
**warp-end teardown frame ONLY** — stagger the Pixi filter-stack
detach off the React unmount frame and/or soften the WarpScreen/curtain
unmount so the detach + unmount + any longtask don't converge on one
frame. ONE change, before/after on-device capture proof. Do NOT touch
the steady filter chain (proven fine).

### F2 ON-DEVICE — WARP-OUT LOCALIZED — 2026-05-16 (`…y8ftt6`)

User report: "laggy on warp **out**; the starting (cold-load) lag is
gone on subsequent loads." Phone capture confirms + localizes:

- Steady FRAME **p50 11.1 ms** (~90 fps idle — phone is fast). But
  **p95 44.4 ms, max 111 ms.** Σ all CPU markers **1.40 ms**
  (`renderer_update` max 2.5). Residual again ⇒ GPU/pipeline, CPU dead.
- Slowest rafTick frames cluster **ts 17546–17852**: 111→77→55→55→44→44
  ms — a **~300 ms run of consecutive 44–111 ms frames**, i.e.
  *sustained* warp-out degradation, NOT a one-off. Load curtain dropped
  at ts 15333 (≈2.2 s earlier) ⇒ this is **not** load/join. A separate
  55 ms longtask + `component_unmount` ~ts 18300–18360 is the minor
  teardown blip (secondary, ≈ jgimvi's).
- Cold-start join hitch (jgimvi 133 ms) does NOT recur warm — confirmed
  by the user; deprioritised.

VERDICT: the reproducible "warp-out lag" = a ~300 ms GPU-fill burst
during the warp-out **climax/burst** — the filter chain at its DESIGNED
peak (`DEFAULT_WARP_PARAMS`: climaxAmplitude 220, climaxZoomBlur 0.7,
burstAmplitude 440, burstBrightness 2.6, bloomStrengthMax 6) doing
fullscreen shader fill on the mobile GPU. The original handoff
hypothesis, now on-device-confirmed in the RIGHT scenario.

**F3 — DATA-LOCKED TARGET: warp-out climax/burst GPU fill on
coarse-pointer (mobile).** ONE principled change: lower
`bloomStrengthMax` + Bloom quality/kernelSize, `climaxZoomBlur`, and/or
cap the warp filter render-target `resolution`, **gated to
`pointer: coarse` / mobile DPR** so desktop visuals are untouched.
Visible tradeoff: a less intense bloom/blur at the warp-out peak on
phones (the climax/burst is already curtained/flashed, so the
perceptual hit is small). Steady filter chain + spool: do NOT touch
(proven fine). F4: re-measure on-device via the same `?diag=1` +
Settings→Capture loop; the 17546-cluster p95/max must drop.

### F3 HYPOTHESIS FALSIFIED — 2026-05-16 (user on-device A/B)

**F3 (cap warp filter resolution) was REVERTED — uncommitted, never
shipped.** User: "I only test on mobile" + "[the sandbox] was lag-free
on mobile." The sandbox (`visual-effects-sandbox-main.ts`) runs the
**same `WorkerRendererClient` + same filter chain** as the game; the
user runs **both on the same phone (same DPR)**. Sandbox lag-free at
mobile DPR ⇒ the filter chain (incl. climax/burst) is affordable at
that DPR ⇒ the warp-out lag is **NOT the filter GPU fill**. The
"sandbox-smooth was low-DPR desktop" reasoning was wrong (user never
tests desktop). The earlier leap "residual at ts-17546 = filter
climax/burst" had no direct evidence (no transit/warp event ts in the
capture) and is **not supported**.

CORRECTED ATTRIBUTION: the real sandbox-vs-game differential at the
SAME device/DPR is what the game does that the sandbox does NOT —
**the inter-sector transit room-swap** (Colyseus leave old room → join
new → new-sector schema sync → predWorld/reconciler reset). The capture
has `player_leave/join/rebind` server events; warp-OUT == a networked
room swap. The F1 CPU markers (`mirror_rebuild`/`mirror_clone`/etc.)
bracket the STEADY per-frame path, NOT the room-swap burst, so it lands
in "residual" as a transient stall — matching the original handoff's
"raf_gaps at the transit room-swap boundary". This is largely inherent
to a networked sector change and is masked by the load curtain / warp
flash; steady play is 60–90 fps.

ASSESSMENT (user: "we might be chasing tail here" — concur): the merge
(the actual deliverable) is long done & solid; steady play is smooth;
the warp-out hitch is a ~300 ms transient during an already-curtained
network transition. Micro-optimising it is low-ROI. RECOMMEND: accept
it as inherent-to-the-room-swap, document, and close Phase F — unless a
dedicated transit-pipeline profiling effort is explicitly wanted (a
separate, deeper, uncertain-payoff investigation; NOT the filters).

**F4 — Re-measure** (same markers/scenario). If flat, REVERT and
re-attribute — never stack a second guess.

**F5 — Lock + green-bar + merge.** Perf-budget regression test
(Invariant #9/#13) asserting spool-window mean frame ≤ budget + transit
max `raf_gap` ≤ budget, at the layer the cost lives (worker-seam ⇒
probe-page). Full Invariant-#8 bar. Update `src/client/CLAUDE.md`
(per-frame budget paradigm) in the same commit as the fix. `--no-ff`
merge.

## Also tracked here (carried from the warp-merge session)

- **bench-in-CI**: `.github/workflows/ci.yml` does not run `pnpm bench`,
  though Invariant #8 lists it. Add a `Bench` step after `Unit tests`,
  before `Build`; verify deterministic on `ubuntu-latest`. **Caveat
  found 2026-05-16:** only `spring.bench.ts` produces samples;
  `swarm-broadcast`/`physics-tick`/`persistence-worker` report 0 samples
  / `NaNx` — a pre-existing harness quirk that makes bench a weak gate.
  Fix the 0-sample benches *before* wiring bench into CI, else the gate
  is theatre.
- **Pre-existing combat/collision E2E debt + suite scale** (separate
  from perf, but needed context for whoever runs CI): `combat.spec.ts`
  `:172/:246/:376` fail on `main` (warp-innocent, confirmed
  2026-05-16); the 124-spec suite cannot finish Playwright's 6-min
  `globalTimeout` at 1 worker. Needs its own effort: fix/quarantine the
  dual-client flakes + shard CI (or raise globalTimeout/workers, or tag
  `@slow`). NOT a perf item; logged so the next session has the full
  picture.

## Pointers

- Warp centre resolver: `resolveWarpFilterCenter`
  (`src/client/render/PixiRenderer.ts`, pure/tested).
- Warp filter tick: `tickWarpShockwaves` (~`PixiRenderer.ts:1741`).
- Grid labels: `computeGridLabels` (`BackgroundGrid.ts`).
- Worker boundary: `WorkerRendererClient.ts:282`, `protocol.ts`,
  `renderer.worker.ts`.
- Mirror rebuild / snapshot apply: `ColyseusClient.ts` (`updateMirror`
  ~`:2413`, `handleSnapshot` ~`:1373`).
- Sandbox A/B reference: `src/client/__offscreen-spike__/visual-effects-sandbox-main.ts`.
- Architecture: `docs/architecture/warp-visual.md`.
- Origin record: `docs/HANDOFF-warp-perf-2026-05-15.md`

## ROOM-SWAP HYPOTHESIS ALSO FALSIFIED — 2026-05-16 (cross-clock)

User chose to keep instrumenting (correct call). Cross-clock
correlation of `…y8ftt6` via `clientEpochMs` 1778926490084: server
room-swap `player_leave → player_join` = client-ts **10762 → 10988**
(finished ~11 s); curtain down (`load_curtain_change`) = client-ts
**15333**; stall cluster = client-ts **17546–17852**. The stall is
**~6.5 s after the room-swap completed and ~2.2 s after the curtain
revealed the new sector** ⇒ NOT room-swap mechanics.

Robust theory-free facts: a ~300 ms residual stall hits **~2 s
post-arrival, curtain-down, settled in-sector**; NOT CPU (F1 markers
<2.5 ms through it), NOT filters (same-device sandbox A/B), NOT
room-swap (timing). **Zero client log events near ts 17546** — the
warp-out→arrival→settle path is an instrumentation black box. Two
hypotheses (filter-fill, room-swap) killed by data; no third guess —
instrument the black box.

**NEXT (F-transit-instrument):** gated (`isDiagEnabled`) discrete
`logEvent` lifecycle+span markers across the FULL inter-sector
transit→arrival→settle path so a CLIENT-ts timeline exists around the
stall: engage → old-room leave → seat-consume/new-room join → first
`onStateChange` → `resetPredictionState` → first post-arrival snapshot
reconcile → curtain-down → first ~30 post-reveal frames (surface a
per-frame `spriteCount` delta to catch a first-render GPU-upload
spike). Route new tags → `perf` bucket. Then ONE on-device capture
names the step that eats the 300 ms. Data tool, not a regression lock.
Then F3′ fixes only the indicted step; F4′ re-measures..

## RESOLVED — 2026-05-16 — arrival prediction drift (test-first fix, Invariant #13)

The F-transit-instrument plan worked exactly as intended. The user's
on-device capture **`2026-05-16T11-59-43-103Z-tl56wa`** (fixed diag
pipeline: 30000 ring, 64 MB limit, 30000 schema cap — full timeline
survived: `transit_mark` 39, `transit_frame` 120, `raf_gap` 44, 18365
logs) named the step in one read.

**Timeline (intentional vs the actual defect):**
- `SPOOLING → IN_TRANSIT` ≈ 3 s — the designed vulnerable spool. Intentional.
- room-swap ≈ 0.3 s, `pred_reset` step 0 ms — fast; **not** it (room-swap hypothesis already falsified above, now confirmed by direct span).
- `first_snapshot → curtain_down` ≈ 2.5 s — the **5 s `joinMinimumElapsed` minimum-display floor** (commit 8792822). Intentional.
- **`first_snapshot` `driftUnits` = 210 / 380 / 87** ⇐ **THE DEFECT.** The destination's first authoritative snapshot is hundreds of units off the client's reset prediction; the reconciler lerps that out over the first ~1.3 s post-curtain (choppy 33–144 ms frames, `raf_gap`s to 344 ms). That correction lerp *is* the "warp-out lag".

**Root cause:** `resetPredictionState()`'s "fresh-connect seed" was true
for the RTT/timing state it re-creates and **false for the spatial
body** — it never despawned the local `predWorld` body nor dropped the
`Reconciler`. The `transit_ready` mirror-cleanup preserves the local
ship, so `tryInitPredWorld` early-returned on `hasShip(localId)` at the
destination and the body kept the SOURCE pose; the first destination
reconcile surfaced the whole source→dest delta as drift. Intermittency
= configurable-arrival varying how far the landing point is from the
pre-transit pose. Full write-up: `docs/LESSONS.md` 2026-05-16.

**Fix (one ownership site, no second correction path):**
`resetPredictionState()` now despawns the local predWorld body + nulls
the `Reconciler`; the destination's first state-diff/snapshot reseeds at
the AUTHORITATIVE arrival pose via the existing `tryInitPredWorld`
(rebuilds the Reconciler). `tickPhysics` + `handleSnapshot` already
guard `!this.reconciler` — re-enters a well-tested state.

**Test-first (Invariant #13):**
`src/client/net/ColyseusClient.transitArrivalDrift.test.ts` — drives the
real seed→`resetPredictionState`→reseed→first-snapshot sequence on a
real `ColyseusGameClient` + real `PhysicsWorld` (the level the bug
lives — NOT the integration harness, which uses a raw colyseus.js
client and can't observe `reconciler.lastDrift`; NOT a naive Reconciler
unit test). Asserts first-arrival `reconciler.lastDrift < 5`: **RED at
384 u pre-fix, GREEN ~0 post-fix, re-fails on revert.** Companion
`ColyseusClient.resetPredictionState.test.ts` updated to the new
contract (reconciler nulled, not just `lastRtt` zeroed).

Green bar: typecheck 0 · lint 0 (29 pre-existing cosmetic warnings) ·
`pnpm test` 87 files / 820 · `pnpm test:integration` 14 / 45. CLAUDE.md
(`src/client`) + `docs/LESSONS.md` updated same commit (Invariant
#7/#10). The three earlier theories (filters / grid-labels / room-swap)
remain falsified — recorded above as the methodological win: instrument
the black box, don't guess a fourth time.

**Note on the residual carried in the 2026-05-15 LESSONS entry:** the
~29 ms spool-window mean frame + transit-boundary `raf_gap`s are a
*separate, lower-priority* steady-cost question (filter fill + grid
labels on a DPR≈2.6 GPU) and were NOT the user-reported "lag" — that
was the drift, now fixed. If spool-window frame cost is ever revisited,
it gets its own capture + measurement; do not conflate it with this.
