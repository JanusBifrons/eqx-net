# HANDOFF — warp-spool frame cost (OPEN, headline next work)

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
- Origin record: `docs/HANDOFF-warp-perf-2026-05-15.md`.
