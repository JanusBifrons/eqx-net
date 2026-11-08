# Hostile review: desktop-verification-report.md

**Verdict: SIGN-OFF WITH CORRECTIONS.** The server-side "laptop-caused" verdicts (H1, H2, H3, H6/H11, H7), P1's maths and the revised H8 hold up. Parts of F4/F5 are wrong as written, and H4 claims more than its metrics can show.

## Objections

1. **F4/F5: the failure has a known start, and it is commit 23b15fb0 — severity: invalidates three sub-claims.**
   - 23b15fb0 is the direct parent of 1b71a140, the docs-only commit the bisect landed on. It moved `{timeout}` out of the waitForFunction *arg* slot, so the 2 s deadlines took effect for the first time. Before that commit, beam-appears waited until the whole test timed out.
   - It touched beam-appears, auto-fire, energy-bar, gate-fly-through, wave-attack, interceptor-beam and missile-frigate: 7 of the 10 failing specs.
   - So "a docs-only commit confirms it is not a code change" is backwards. A docs-only "first bad" means the bisect marked 23b15fb0 good on a flaky pass (`--repeat-each=2`); the real first-bad commit is 23b15fb0.
   - "Not a recent regression" is false: it is a test-code regression from 2026-11-06.
   - "This PC lifts the curtain later than CI or the laptop, so they pass by luck" has no evidence. No curtain timings were measured on the laptop or CI, and before 23b15fb0 there was no deadline to miss on any host.
   - F5 (energy-bar "passes on the laptop") is explained the same way. Neither "slow runner" nor "curtain" is established.
   - **Fix:** run beam-appears at 9d623ecc (expect pass) and at 23b15fb0 (expect fail), 6 reps each. Rewrite F4/F5 around the commit that made the deadlines real.

2. **F4's curtain race is extrapolated beyond beam-appears — weakens.**
   - Only beam-appears has the curtain diagnostic.
   - interceptor-beam and missile-frigate both **call** `waitForInPlay` (2 calls each), yet they fail every time. The report leaves them unexplained but still frames the failures as mostly a curtain race.
   - wave-attack fails on the `warp-warning[data-warning-count="8"]` locator, not on a start-of-play wait.
   - **Fix:** say "proven for beam-appears; suspected for the other specs that lack waitForInPlay; interceptor and missile-frigate are unexplained". Or capture `data-warp-visible` at the failure point for each spec.

3. **H4: the metrics cannot see GPU cost — weakens.**
   - The desktop profile is non-touch at 1280×720, so `selectRenderer` picks the **worker** renderer.
   - `clientFrameP95` and hitches are therefore main-thread rAF, which the renderer does not draw on.
   - `renderP95` is `frameMarkers.rendererUpdateMs`, which is CPU encode time (PixiRenderer.ts:2316), not GPU execution time.
   - Frame p95 is quantised to vsync: 16.7 or 33.4 ms, never in between. A shader-cost regression under one refresh is invisible.
   - "No measurable cost" should read "no main-thread or CPU-side cost, and no dropped vsyncs on a 5070 Ti".
   - **Fix:** add GPU timer queries (EXT_disjoint_timer_query) or run headed with `worker=0`, uncapped.

4. **H4: the art-stats check is unlogged and probably ran in a different mode — weakens.**
   - `__eqxArtStats` is set on `globalThis` by PixiRenderer. In worker mode that is the worker's global, so `page.evaluate` cannot see it.
   - The 8-page/186 MB vs 5-page/166 MB probe must therefore have run main-thread, not in the perf arm's configuration.
   - It is also not recorded anywhere in the scratchpad, and the report doesn't say whether "default" included `art=machined`. Under automation the default art is classic.
   - **Fix:** log the probe's URL and output, run with the arm's exact URL, and record `shiplight` in the ledger.

5. **P1: the "×2 GPU-lighting hitches" lacks a same-code baseline — weakens.**
   - The maths checks out: C(6,3)=20 → p=0.10; C(8,4)=70 → 0.029; C(10,5)=252 → 0.008. The laptop ledgers are reps=3.
   - But the laptop same-code self-test (`selftest-2026-11-06.json`, 5 reps) already showed head > base: idle 8.8→20.3 (×2.3), fleet-fight 21.4→29.6 (×1.38). A ×2 gap fits inside the head-arm bias between identical builds.
   - The "4 of 4" also leaves out hitch-points (26.0→27.5) and hitch-shadow (29.5→33.6), which the report itself lists as GPU-lighting evidence. It also ignores wide-view in gpu-light-ab2, where the GPU arm had fewer hitches (9.8→6.0).
   - **Fix:** report all seven pairs next to the same-code result. Re-run on the laptop at ≥5 reps with a same-code control in the same session.

6. **Scope: the desktop result does not answer the laptop question — weakens.**
   - Laptop fleet-fight server tick p95 is 8–19 ms with the browser on the same 4-core machine. The laptop's main-thread hitches are plausibly CPU contention, which 16 threads remove by design.
   - Desktop "0 hitches" therefore cannot confirm or refute "GPU lighting costs hitches on weak hardware". The report's "Left open" says this; the verdict line should too.
   - **Fix:** run the 8-rep A/B with `--device phone-proxy` (CPU ×4), or pin Chrome and the server to 4 cores.

7. **gpulight-8 server tick p99 rise dismissed as noise — weakens.**
   - p99 went 2.03→3.62 (×1.78), p95 1.62→1.93. The ratio and absolute-change conditions both pass; only p=0.16 keeps it GREEN.
   - The row says GREEN in the ledger, not "PRINT" as the report states.
   - The same-code control (aa-8), run later under the **same** parallel-session load, was flat (1.73→1.73). That argues against "noise from the other session".
   - Base p99 was high only in reps 1–3 and then dropped; head stayed high. That is an order or time effect.
   - Client lighting can affect the server: both share one CPU.
   - **Fix:** call it "unexplained, p=0.16", and re-run once the other session has stopped.

8. **H3 is not the laptop claim — weakens.**
   - The claim was 60 ships with load shedding off. fleet-fight ends with about 47–53 ships, and shedding was on.
   - The laptop p99 range is 10–74 ms across the ledgers, not 24–49 (cosmetic).

9. **H1 tests less load than the laptop claim — cosmetic/weakens.** The laptop claim was two browsers plus Vite. The showcase runs one capture browser.

10. **F1 "every machine" was only checked on this PC — weakens.** The laptop and CI renderer strings were not checked. The desktop's hybrid iGPU+dGPU may be why it fell back to SwiftShader. If so, curtain timing differs because baking runs on a software renderer, which is relevant to objection 1.

11. **SHA mismatch — cosmetic.** Only 2 server commits separate 3785d135 and 971f5d62, so the tick comparisons stand. Hitch and render comparisons across SHAs (render 7–8 ms vs 1.4 ms) mix machine and code changes; say so.

12. **Revised H8 — accepted with one caveat.**
    - `App.tsx` pauses the ticker under `webdriver` while the drawer is open, so the mechanism is real.
    - The screencast gaps sit at 1.5–7.3 s on the frame clock, while the drawer is said to open at 4.4 s and close at 10.4 s on the trace clock. That only lines up if the two clocks are offset by about 3 s.
    - **Fix:** state the offset. Also verify it with `worker=1` or by flipping the webdriver check: one take that passes would settle it.
