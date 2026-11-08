# Desktop verification of laptop results — 2026-11-08

**Code:** `971f5d62` (origin/main, merge of #346), in worktree `.claude/worktrees/desktop-verify`.
**Host:** see `host.md`.
- Ryzen 7 9800X3D, 31 GB RAM.
- Perf and showcase runs use the RTX 5070 Ti (checked via `UNMASKED_RENDERER`).
- The host was idle and no game ports were in use when runs started.

## Phase 1 — Quality suite

| Step | Result | Time |
|---|---|---|
| typecheck | pass | 15 s |
| lint | pass (0 errors, 184 warnings) | 12 s |
| unit | 4390 pass, 61 skipped | 69 s |
| integration | 324/324 pass | 560 s |
| test:gc | **5 fail** | 7 s |
| e2e:smoke | 55 pass, 1 fail (sector-alpha playerId reload) | 229 s |
| e2e:feature | 174 pass, **14 fail** | 24.4 min |
| e2e:gate | 1 skipped (nothing to run) | 7 s |

### Findings

**F1 — Plain E2E runs on software WebGL on this PC, and probably everywhere.**
- `playwright.config.ts` launches headless Chromium with no GPU flags. On this PC it reports "SwiftShader". With `--use-angle=d3d11` or `channel:'chromium'` it reports the RTX.
- I only checked this PC. The laptop and CI renderer strings were not checked, but `docs/LESSONS.md:584` records the same SwiftShader fallback.
- Treat E2E timings as non-GPU measurements.
- Only `perf:scenes` and `showcase` use the real GPU.

**F2 — The test:gc failures are old test code, not host load.**
- `vitest.gc.config.ts` is not run by any CI workflow.
- The failing tests have not been touched since May–June: a flipped sign (`'1000'` vs `'-1000'`) and a 506 KB vs 500 KB heap limit.

**F3 — Feature-tier failures.** Each failure was re-run twice in isolation. 25 of the 30 runs failed.

*Fail every time on this PC:*
- beam-appears
- interceptor-beam coast
- auto-fire (neutral→hostile)
- energy-bar "sustained fire drains"
- fx-turrets recoil
- missile-frigate auto-refire and fizzle
- machined-art nebula inside/outside
- wave-attack

*Fail half the time:* fence-hits, gate-fly-through.

*Pass on re-run (flaky):*
- sector-alpha playerId reload (smoke)
- fx-weapons glow
- galaxy-drawer portrait
- sync-health W-thrust

**F4 — The feature-tier failures were introduced by test commit `23b15fb0` (#310, 2026-11-06), not by any host. Corrected after hostile review.**
- `23b15fb0` moved `{timeout}` out of the `waitForFunction` argument slot, so the 2 s deadlines in specs took effect for the first time. Before it, they were silently ignored.
- **Proof (beam-appears, 6 reps each):**
  - parent `9d623ecc`: **6/6 pass**
  - `23b15fb0`: **6/6 fail**
  - `971f5d62` (HEAD): 6/6 fail
- My first bisect wrongly assumed `23b15fb0` was good and landed on its docs-only child. That claim is withdrawn.
- **Mechanism, proven for beam-appears only.**
  - `launchTestClient` returns on ship count while the loading curtain is still up. The curtain lifts at about 2.4 s, and the beam turns on at that same moment. The now-effective 2 s deadline misses it by about 0.4 s.
  - **Firing works.** The test has a race condition.
- **Other specs.**
  - 7 of the 10 persistent failures were edited by `23b15fb0`: beam-appears, auto-fire, energy-bar, gate-fly-through, wave-attack, interceptor-beam and missile-frigate. The same mechanism is *suspected* for those without `waitForInPlay`: auto-fire, energy-bar, gate-fly-through, fx-turrets and fence-hits.
  - **Not explained:** interceptor-beam and missile-frigate (both already call `waitForInPlay`), and wave-attack (fails on the `warp-warning[data-warning-count="8"]` locator). They need their own diagnosis.
- **Not established:** whether CI or the laptop would also fail now. No curtain timings exist from those hosts.

**F5 — The energy-bar note in the audit doc is unsupported.**
- `docs/refactors/test-coverage-audit.md:256` blamed slow hosted runners.
- The failure follows the `23b15fb0` deadline change, not host speed: it fails every time on this much faster PC.

**H9 — #310 said smoke failures "fail on the laptop, pass on CI".** Not reproduced here. The only smoke failure was sector-alpha playerId reload, and it passed on re-run.

## Phase 2 — Perf: re-testing the laptop's claims

Ledgers are in `ledger/<run>/*.json`; logs are in `logs2/`. Every A/B ran at the same SHA (`971f5d62`) with base and head alternating.

**Confound (disclosed).** From 16:43:34 another Claude session ran its own game server and Vite (`eqx-net-hud`, ports 2667/5273). It used about 1.3 cores continuously, out of 16 threads. The inject runs (16:34–16:43) were clean. The headonly-8, gpulight-8 and aa-8 runs shared the CPU with it. In both A/Bs this load hit both sides, because base and head alternated.

### P1 — The laptop's 3-rep A/B gate cannot go RED (methodology bug)
- `perf/verdict.ts` uses an exact two-sided Mann-Whitney test and requires p < 0.05. Using the project's own `mannWhitneyP`, perfectly separated arms give:
  - n = 3 → p = 0.100
  - n = 4 → p = 0.029
  - n = 5 → p = 0.008
- **Demonstration on this PC.** The same injected slowdown (`--inject-server-burn 6 --inject-client-burn 20`, fleet-fight):

| Reps | Frame p95 | Hitches/min | Server tick p95 | Verdict |
|---|---|---|---|---|
| 3 | 16.8 → 33.4 (×1.99) | 0 → ~300 | ×5.13 | **GREEN**, every p = 0.10 |
| 4 | same slowdown | same | same | **RED**, p = 0.03 on frame p95, hitches, tick p95 and tick p99 |

- **Every laptop ledger that GPU lighting relied on ran 3 reps:** `gpu-light-ab.json`, `gpu-light-ab2.json`, `hitch-bare/geo/points/shadow.json` and `phone-proxy-ab.json`. Their GREEN verdicts carry no evidence either way.
- **All seven laptop GPU-lighting pairs** (fleet-fight hitches/min, base → head):

| Ledger | Base → head |
|---|---|
| gpu-light-ab | 17.4 → 35.4 |
| gpu-light-ab2 | 15.6 → 31.9 (wide-view **9.8 → 6.0**) |
| hitch-bare | 15.8 → 30.4 |
| hitch-geo | 9.8 → 19.9 |
| hitch-points | 26.0 → 27.5 |
| hitch-shadow | 29.5 → 33.6 |

- **Same-code control.** The laptop's own `selftest-2026-11-06.json` (5 reps, identical arms) already showed head above base: idle 8.8 → 20.3 (×2.3), fleet-fight 21.4 → 29.6 (×1.38).
- So a ×2 gap is within the laptop's same-code bias. **The laptop data neither shows nor rules out a GPU-lighting hitch cost.** (Corrected after hostile review; I previously cited "4 of 4".)
- **Second issue.** The runner alternates order each rep. With an odd number of reps, one arm runs second more often (2 of 3). The runner's own comment says that position "showed up as head-only extra hitches".

### H2 — Laptop noise (fleet-fight tick p95 swung 10–19 ms in one session)
- Desktop, head-only, 8 reps (ms):
  - fleet-fight tick p95: 1.47–1.70
  - wide-view: 2.19–2.92
  - teleport-raid: ~0.45
  - idle: ~0.16
- Hitches were **0/min in every rep of every scene**. Frame p95 was 16.7–16.8 ms, a locked 60 fps.
- Same-code vs same-code control (aa-8, 8 reps): all metrics ×1.00–1.02, all GREEN.
- **Verdict: confirmed laptop-caused.** The desktop's tick is about 7–12× lower, and the noise band is ±7% here vs ±30% on the laptop.

### H3 — "60-ship fight: server p99 ~40 ms"
- Desktop fleet-fight server tick p99 is 1.7–3.6 ms (aa-8 and gpulight-8), against a 16.7 ms budget. The laptop ledgers showed p99 10–74 ms.
- **Different set-up from the claim:** fleet-fight ends with 47–53 ships and load shedding on. The claim was 60 ships with shedding off, which I did not reproduce.
- **Verdict: consistent with laptop-caused** (about 10× headroom here), not a like-for-like confirmation.

### H4 — GPU lighting (baked vs `shiplight=gpu`), 8 reps
- **Check that the switch takes effect.** A one-off probe on the test-sector room, `worker=0`, fighter, with `art=machined&fx=new` in both arms, reading `__eqxArtStats`:
  - without `shiplight`: 8 atlas pages, 186 MB
  - `shiplight=gpu`: 5 pages, 166 MB
- **Caveats on that probe:**
  - It ran main-thread (`worker=0`), while the perf arms use the worker renderer.
  - The lighting level is resolved by the same `resolveShipLighting` in both modes, and `run-perf.ts` passes `art=machined` to both arms.
  - The ledger does not record `shiplight`; it should.

| Scene | Frame p95 | Hitches | Render p95 | Server tick p99 |
|---|---|---|---|---|
| fleet-fight | 16.7 / 16.75 | 0 / 0 | 1.7 → 1.8 ms (p = 0.09) | 2.0 → 3.6 (p = 0.16, PRINT) |
| wide-view | flat | 0 / 0 | 1.85 → 1.9 | flat |

- **Server tick p99 rose 2.03 → 3.62 ms (×1.78, p = 0.16; the ledger marks it GREEN).** This is unexplained.
  - Client lighting shouldn't affect the server.
  - The same-code control run later under the same parallel load was flat, which argues against noise.
  - It needs a re-run on a quiet box.
- **What the metrics can and can't see.** In worker mode, frame p95 and hitches measure the main thread's rAF; `renderP95` is the renderer's CPU time, not GPU time; and frame time moves only in whole 16.7 ms steps.
- **Verdict:** on a 5070 Ti there is **no CPU-side or main-thread cost and no dropped frames** (render CPU +0.1 ms). GPU shader cost was not measured; that needs GPU timer queries.
- **Does not answer the laptop question.** This PC can't say whether GPU lighting costs hitches on weak hardware: the laptop's hitches may well be CPU contention, which 16 threads remove. The phone-proxy A/B (#346's evidence) also used 3 reps. **To settle it:** run the 8-rep A/B with `--device phone-proxy`, or pin the browser and server to 4 cores.

### H7 — Capture resolution (laptop: 1080p screencast only 20 fps)
- Desktop `bench-capture.ts` results for game rAF and captured fps:

| Mode | Game rAF | Captured |
|---|---|---|
| none 720p / 900p / 1080p | 60.1 fps, max 17 ms | — |
| cdp 720p / 900p / 1080p @ q80 | 60.1 fps, max 17 ms | 60.0 fps |
| cdp 1080p @ q90 | 60.1 fps | 60.0 fps |

- **Verdict: laptop-caused.** The 720p default was a hardware limit, so 1080p native capture is fine on this PC.

### H1 — Server pace (laptop: 25 Hz with two browsers + Vite)
- Server alone (`serverTickRate.test.ts`): **60.0 Hz** over 3.00 s.
- With browser and Vite: each showcase take records `serverHz`. See Phase 5 and the diagnostic shots.
- **Diagnostic showcase takes** (1080p, RTX confirmed, baked look, `diagshots/manifest.json`, log `logs2/diagshots.log`). Each recorder runs Vite plus a capture browser plus the game server:
  - machined-turrets: 60.1 fps, worst gap 21 ms, server 60.1 Hz, 0/200 corrected
  - capital-guns-fighter: 60 fps, gap 24 ms, server 60 Hz, 0/440 corrected
  - capital-guns-bystander: 60 fps, gap 24 ms, server 60 Hz, 0/480 corrected
  - **trade-deal: 33.9 / 33.8 fps, worst gap 1215 / 1165 ms (both takes FAIL)**, with server 60 Hz and 0 corrections
- **H1 verdict: laptop-caused, with less load than the claim.** The server holds 60 Hz with one capture browser plus Vite. The laptop case had two browsers. During the reel recording, three recorder stacks ran at once (three servers, three Vite instances, three browsers), and their per-take server Hz is in the Phase 5 manifests.
- **Cross-SHA note.** Laptop ledgers are at older SHAs (3785d135 → 971f5d62 differ by only 2 server commits). So the server tick comparisons stand, but render and hitch comparisons across SHAs mix machine and code changes.

### H6 / H11 — laptop showcase hitches (memory pressure; machined-turrets 53–55 fps)
- Not reproduced. Every take ran at 60 fps with a worst gap of 21–24 ms. **Verdict: laptop-caused.**

### H8 — trade-deal fails the gate
- **It reproduces on this desktop:** 33.9 fps, with frame gaps of 1.2–1.5 s. The server holds 60 Hz with 0 corrections.
- **Trace analysis** (`tradetrace/clips/trade-deal/trace.json`, scripts in `scratchpad/trace-analysis/`):
  - The renderer main thread has **no long tasks**. The longest task is 31 ms, and the thread is about 7% busy during the "stalls".
  - Pixi's WebGL calls drop to 0 the moment the drawer opens (4.4 s) and resume when it closes (10.4 s).
  - The compositor's `DrawFrame` gaps (1531, 1161, 900 ms) match the screencast frame gaps (1530, 1160, 918 ms).
- **Cause:** `src/client/App.tsx:802-811` deliberately stops the Pixi ticker while the drawer or galaxy overview is open whenever `navigator.webdriver === true`.
  - This is a 2026-05-13 E2E workaround for CDP starvation.
  - The showcase recorder runs under Playwright, so it films the paused game. With nothing redrawing, the screencast sends no frames.
- **Verdict: an automation artefact.** It is not a player bug, and not the laptop either. Players never hit this path.
  - `docs/architecture/showcase-pipeline.md` blames Trade-tab refreshes blocking the main thread for about 1 s. That explanation is wrong, and the TradeTab poll is innocent.
  - (My first verdict, "real code issue", was wrong in kind. The trace corrected it.)
- **Suggested fix:**
  - Key the pause on an explicit E2E flag instead of `webdriver`, or let the showcase recorder opt out. Then re-record trade-deal.
  - The same applies to any shot that opens the drawer or the galaxy overview.
  - Also, in the showcase runner, `reapStale()` throws ENOENT on a fresh checkout because `showcase-out/` doesn't exist yet (`showcase/tools.ts:152`). Creating the directory first fixes it.

### Not done (to keep the run short)
- H5 (4096² art pages)
- H12 (bigger muzzle A/B)
- the 8-rep phone-proxy GPU-lighting A/B
- the swarm-tidi 4000-entity case
- Phase 3 scripted gameplay sessions. The showcase recordings stand in for these: each shot plays a staged scene on a real server, and its server Hz, corrections and pose-trace counts are logged.

## Phase 5 — Reel recording: what the takes revealed

**Set-up.** Three recorders ran in parallel from separate worktrees on ports 2767/5373, 2867/5473 and 2967/5573. All ran at 1080p with `art=machined&fx=new&shiplight=high` and up to 3 takes per shot. The logs are `logs2/rec-*.log` and the manifests are `reel-*/manifest.json`.

**What recording three at once showed:**
- Server pace held 58.9–60.2 Hz in every take.
- Most shots passed on the first take. Every failure that cleared on a retake was a single 101–116 ms hitch, or a frame-rate dip on the dense `scale` shot (46.5 and 52.4 fps). `scale` passed at 60.1 fps once recorder C had finished.
- Conclusion: under three-way contention the desktop starts to show laptop-like symptoms. That supports the "host load" explanation for the laptop.

**Findings that are not host load:**
- **pack-battle:** failed all 3 takes on *prediction corrections*: 4, 3 and 6 corrections; 64, 18 and 37 of 240 snapshots corrected. Server Hz was 59.9–60.2 and fps 60.
  - With the server at full pace, this looks like a real local-prediction issue in a dense melee, not starvation.
  - `new-effects` showed the same pattern on 2 of 3 takes (4 and 14 corrections, up to 10 tick jumps). It only passed on the third.
  - **Worth investigating as netcode.**
- **sector-travel:** take 1 had a 769 ms hitch and 49.4 fps (server 58.9 Hz); take 2 was clean.
  - This matches the 0.25–0.6 s art-upload stalls reported on the laptop (#337, H5): stalls still happen on an RTX 5070 Ti, intermittently.
  - So H5 is **not purely a laptop artefact**, though this is a single sample.
- **Damage numbers:** the clip reviewer found that overlapping damage numbers render as smudged dark/red blocks inside fireballs (new-effects ~5.4 s, missiles, robots).
- **Staging and framing problems** (hostile clip review, cut from the reel):
  - galaxy-landing: static map, captions over hexes
  - alien-gate and teleporter-ride: mostly frozen frames, pads/gate read as flat placeholder blocks, toasts over the subject
  - npc-citadel: 8 s of empty fenced space, citadel clipped at the top
  - grid-alive: caption and hotbar cover the miner and turret
  These are shot-script problems, not performance problems.
