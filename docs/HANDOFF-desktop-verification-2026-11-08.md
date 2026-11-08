# Handoff: desktop verification + machine-independent perf (2026-11-08)

Plan: `machine-independent-perf` (WS1–WS8). WS4, a desktop runner, was **dropped by the user**: nothing may depend on the gaming desktop.

Evidence is in [`diag/measurements/2026-11-08-desktop-verify/`](../diag/measurements/2026-11-08-desktop-verify/):
- `desktop-verification-report.md`
- `hostile-review.md` (signed off with corrections, all applied)
- `host.md`

This doc is self-contained. Pick it up on any machine.

## What we learned

1. **Most of the laptop's "slow" results were the laptop.** On a quiet, strong host:
   - fleet-fight server tick p95 was about 1.5 ms (the laptop measured 10–19 ms);
   - 0 hitches in 8 reps per scene;
   - 1080p capture at 60 fps (the laptop managed 20).
   Recording three showcase streams at once on the desktop reproduced laptop-like stutter.
2. **The perf A/B gate couldn't fail at 3 reps.** An exact two-sided Mann-Whitney test has a minimum p of 0.10 at 3 v 3. Every GPU-lighting decision (#344–#346) used 3 reps, so those verdicts were inconclusive, not GREEN. **Fixed in #352.**
3. **Two wrong explanations had been written into the docs:**
   - The feature-spec failures were blamed on slow hosted runners. They actually came from #310 (`23b15fb0`), which made the 2 s `waitForFunction` deadlines take effect while specs still acted before the loading curtain lifted.
   - The trade-deal "Trade-tab main-thread freezes" were really the automation-only Pixi ticker pause (`src/client/App.tsx`, keyed on `navigator.webdriver`).
4. **Melee corrections were a netcode design gap.** Every AI ship ("drone", swarm kind 1) and all scrap collided against the drawn pose, about 100 ms in the past, while the local ship is predicted ahead. Remote *players* were already on the predicted timeline. **#360 unifies them into one paradigm.**

## Landed (merged)

| PR | What |
|---|---|
| #351 | `test:gc` runs in CI (5 stale tests fixed, all stale, no regressions); weekly full `@feature` run (advisory) |
| #352 | Honest perf verdicts: RED / GREEN / **INCONCLUSIVE**, 8 even reps by default, A/A noise-floor arm, richer ledger (params, GPU, host) |
| #353 | Host-load sensing (CPU, RAM, foreign game servers: busy reps become INVALID and are retried); `EQX_SHOWCASE_PORT_OFFSET`; pid-file fixes. A unit test was killing live perf/showcase runs (`EQX_SHOWCASE_pidFile()` typo). |
| #354 | `pnpm perf:phone`: the same 8-rep A/B on a real phone over adb; GPU-lighting docs corrected to "inconclusive"; `--base HEAD` resolution bug fixed |
| #355 | Melee correction failing lock + diagnosis |

## In flight (auto-merge ON; GitHub merges each when its checks pass)

| PR | What | Watch for |
|---|---|---|
| #356 | Count budgets that gate every PR on any machine. Server work counters are gated in integration (CI matches desktop). `pnpm perf:counts` client draw calls / atlas pages run as an advisory CI job. Two flaky wall-clock unit tests converted to counts. Linux `killPort` self-kill fixed. | Confirm the `perf-counts` CI job renders at least 20 frames after the half-resolution change. If it doesn't, lower the device scale or lengthen the window. |
| #359 | E2E: join helpers wait for play by default. beam-appears, energy-bar, auto-fire, interceptor-beam and wave-attack are fixed. wave-attack also had a **real** gap: a one-shot `warp_warning` was missed by late joiners, now replayed on `client_ready`. | Touches SectorRoom, so the netgate applies. |
| #362 | **WS6.4:** the automation ticker pause is keyed on an explicit flag (`localStorage.eqxE2ePause` / `?e2ePause=1`, set via the E2E storage state for the smoke, feature and gate projects) instead of `navigator.webdriver`. Showcase and perf now film and measure the live game behind menus. Trade-tab and energy-bar doc notes are corrected. | Stacked on #359. Perf drawer specs (e.g. `mobile-perf-probe4`) no longer get the pause; that's intended. Re-record trade-deal to confirm `DrawFrame` gaps of about 17 ms. |
| #360 | **One collision paradigm:** players, drones and scrap anchor to the latest server state and step on the predicted timeline. The per-frame follower is deleted. Rendering is unchanged. Local rays test drones at the drawn pose (`DisplayPoseHitscan`). Model corrections went 7 → 0 (drones) and 17 → 0 (scrap). | **Live-loop change: the netgate decides.** If RED survives the automatic retry, treat it as real and investigate; don't dismiss it as host noise. |

If any in-flight PR fails CI: read the failing job, fix on its branch, and sync with main first (CLAUDE.md).

## Not finished

**From #359 (still quarantined until verified 6/6):**
- missile-frigate-homing `:414`, `:562`: fix landed (cooldown from the catalogue; the impact test waits the real 6 s lifetime).
- machined-art nebula `:162`: maths moved to the browser.
- fence-hits, fx-turrets `:63`, gate-fly-through: they now wait for play.
- **Next:** run each 6×, remove it from `QUARANTINE` when it passes, then run the full feature tier once.

**Flaky, not investigated:** sector-alpha `:424` (playerId reload), fx-weapons `:65`, galaxy-drawer-rich `:48`, sync-health `:17`. They may share the curtain race where they join with their own `page.goto`.

**From #356:**
- The close-up fleet-fight draw-call budget is loose (175) because of battle randomness. It needs a seeded battle, or gate on p50.
- Display-object budgets are wide for the same reason.
- No per-frame allocation counter.
- No physics-worker thread CPU (Node 22 lacks `threadCpuUsage`; event-loop utilisation is the proxy).
- `teleport-raid` and `idle` have no client count budgets; `idle` also has no server budget.
- `TickBudgetTelemetry` "no hitch" asserts are still wall-clock.

**From #360:**
- The showcase `pack-battle` / `new-effects` re-takes were not re-run on a port offset. Do that to confirm the pose gate (at most 2 corrections) in real footage.
- Browser melee still shows some corrections: 14, 6, 2 per flight, versus 20 and 17 before. Contact counts vary widely (1–12 collisions per run).
- **Likely remaining source:** client drone bodies coast at their last server velocity between anchors (no damping, no AI thrust). A drone turning hard inside the replay window can still cost a small correction.
- **Scrap now takes the server's angular velocity.** A June A/B found that harmful, but only under the old per-frame re-pose. The new scrap stress results are good, but spin hasn't been checked on its own.
- `melee-drone-corrections.spec.ts` prints corrections and gates only peak drift. Consider gating on the count once it's stable.

**Never started:**
- **WS7.2:** budget per-frame art upload size on `sector-travel`. A 769 ms stall was seen once even on an RTX 5070 Ti, and #356's upload counter is the hook.
- **WS7.3:** overlapping damage numbers smear into dark blocks inside fireballs. Repro on the `damage-number-probe` page first, then fix the z-order or blend.
- **WS8.1:** refuse to start a showcase recorder when another recorder's ports are live (#353's host-load sampler is the hook).
- **WS8.2:** re-stage the 10 cut shots: galaxy-landing, alien-gate, teleporter-ride, npc-citadel, grid-alive, capital-broadside (show gunfire), warp, scrap, garrison-patrol, pack-battle.
  - Action starts within 1 s.
  - Subjects at least 40 px at 1080p.
  - Caption and HUD kept off the subject.
  - Per-shot problems are in the verification report, Phase 5.
- **WS8.3:** a `staticFrames` QA gate: fail a take with more than 3 s frozen (ffmpeg `freezedetect`).
- **`NETGATE_PORT_OFFSET`:** port it to main so parallel sessions can each run a netgate.

## Recommended next steps (in order)

1. **Let #356, #359, #360 and #362 land.** Fix anything CI flags on their branches.
2. **Settle GPU lighting on weak hardware.** On the laptop, phone attached; about 1 h each; commands are in `docs/architecture/gpu-lit-ships.md`:
   ```
   pnpm perf:phone  --scenes fleet-fight,wide-view --reps 8 --base HEAD --base-params shiplight=baked --head-params shiplight=medium --noise-check
   pnpm perf:scenes --device phone-proxy --cpu-rate 2 --scenes fleet-fight,wide-view --reps 8 --base HEAD --base-params shiplight=baked --head-params shiplight=medium --noise-check
   ```
   Then repeat with `shiplight=low`. If RED, lower the phone default level. The first `perf:phone` run is also the lane's first live test.
3. **Re-record trade-deal** now that #362 has landed, to confirm footage behind menus is live.
4. **Finish the quarantined specs** from #359 (verify 6/6, un-quarantine), then triage the 4 flaky specs.
5. **Decide which advisory CI jobs become required** (user's call): `gc-tests`, `perf-counts`, `e2e-feature-affected`. Suggest after a week green.
6. **WS7.3 damage numbers and WS7.2 upload budget.**
7. **WS8 showcase re-staging + `staticFrames` gate.** Then re-record the reel one shot at a time on the laptop.

## Working rules learned this session
- **Perf A/Bs:** use at least 8 reps (even). Treat INCONCLUSIVE as "this host can't tell", never as "fine". Gate PRs on counts; use timing only to compare.
- **Parallel sessions share the machine.** Use port offsets, check port owners (`netstat -ano` + command line), and never kill processes you didn't start.
- **E2E runs on software WebGL** (no GPU flags in `playwright.config.ts`). E2E timings are not GPU measurements.
- **AI ships are "drones" in code:** everything not flown by a connected human travels on the swarm channel as kind 1.
