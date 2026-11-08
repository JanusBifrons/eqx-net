# Perf scenes: measuring and locking performance

*Plan prancy-squishing-donut (performance lock-down), 2026-11-06.*

## Why

Before this, nothing measured speed on a PR:
- the micro-benchmarks were kept out of CI because GitHub's machines vary about 7× in speed;
- the `tests/perf` specs ran in no workflow;
- the netgate only judges the local player's prediction health, so it can't see server tick time, frame time or bandwidth.

Capital ships (many mounts, wide hulls, big art bakes) were about to land with no way to tell what they cost.

## The idea

A **perf scene** is a scripted, repeatable situation in a real room: a fleet fight, a raid warping in beside a base, a wide view over a battle. The runner plays it in a real browser on the real GPU and records what it costs. This is the industry's usual shape: Unreal's Gauntlet perf runs and FPS charts, Unity's Performance Testing package, replay benchmarks.

Three rules make the numbers trustworthy:

1. **Counts gate; timings compare.** Counts (bytes per second, display objects, live entities) barely depend on the machine. Timings (server tick, frame time) do, so a timing is only ever judged against a **base arm run on the same machine in the same session**, interleaved base/head/base/head (rustc-perf and Chrome's Pinpoint work the same way).
2. **Percentiles and hitches, never mean FPS.** One 120 ms stall in a second of 16 ms frames is invisible in a mean.
3. **Deterministic scenes.** A seeded room, a scripted timeline and an idle, near-invulnerable pilot, so both arms play the same scene.
4. **Fixed work.** Perf rooms set `perfFixedLoad`: no time dilation and no load shedding. With them on, an overloaded server slows its clock and drops drones, so a slowdown shows up as fewer ships rather than slower ticks. The first injected-slowdown run (2026-11-06) showed exactly that: head finished below the ship floor and its tick time didn't separate from base.
5. **Alternate the arm order** every rep. The arm that runs second in a round runs on a warmer machine; a fixed order gave head extra hitches in the self-test.

## Pieces

| Piece | Where |
|---|---|
| Scene timeline (spawn N ships at t, warp-in, hostility, end) | `src/server/rooms/scene/SceneScriptRunner.ts`, room option `sceneScript` |
| Scene catalogue (one entry = one `perf-<id>` room + camera + window) | `src/server/rooms/scene/perfScenes.ts` |
| Server numbers: tick and worker-step percentiles while the scene runs, entity counts | `GET /dev/perf` (`scenePerfRegistry.ts`) |
| Client numbers: main-thread frame interval, renderer cost (worker or main), long tasks, display objects, heap | `?perfprobe=1` → `window.__eqxPerf` (`src/client/debug/perf/perfProbe.ts`) |
| Network bytes | the runner, from DevTools network events (no app code; works on a phone too) |
| Runner, A/B and ledger | `pnpm perf:scenes` (`perf/run-perf.ts`) → `perf/ledger/*.json` |
| Verdict | `perf/verdict.ts`: exact Mann-Whitney U plus a relative AND an absolute floor per metric; RED / GREEN / INCONCLUSIVE, optional A/A noise floor |

## Running it

```
pnpm perf:scenes                                  # every scene, 8 reps, head vs origin/main
pnpm perf:scenes --scenes fleet-fight --reps 4    # one scene, the fewest reps that can decide
pnpm perf:scenes --base HEAD --head-params shiplight=gpu --noise-check   # one switch, with a noise floor
pnpm perf:scenes --head-only --reps 1             # a quick look, no A/B
pnpm perf:scenes --device phone-proxy --cpu-rate 2 --base HEAD --base-params shiplight=baked --head-params shiplight=medium   # phone-class, on the laptop
pnpm perf:phone --base HEAD --base-params shiplight=baked --head-params shiplight=medium      # on a real phone over adb (below)
```

`--base HEAD` means this checkout's HEAD (resolved before the perf-base worktree is checked out; before 2026-11-08 it silently meant that worktree's own, stale HEAD).

## Reading the verdict: RED, GREEN, INCONCLUSIVE (2026-11-08)

Each gated metric gets one of three verdicts (`perf/verdict.ts`):

| Verdict | Means |
|---|---|
| **RED** | head is worse by more than the metric's relative AND absolute threshold, p < 0.05 (exact two-sided Mann-Whitney), and (with `--noise-check`) the move is bigger than this host's same-code spread. |
| **GREEN** | the move is under the thresholds, **and** the rep count could have produced p < 0.05. A real regression would have shown. |
| **INCONCLUSIVE** | the run can't tell. Too few reps to ever reject; or over the thresholds but not significant; or over the thresholds but inside the A/A noise ("within host noise (×N)"). |

The scene is RED if any metric is RED, else INCONCLUSIVE if any gated metric is, else GREEN. The runner exits 0 GREEN, 1 RED or INVALID, 3 INCONCLUSIVE.

**Minimum reps.** The exact test's smallest possible p is 2 / C(2n, n): 0.10 at 3 v 3, 0.029 at 4 v 4. A 3-rep A/B can never go RED, so before this change its "GREEN" meant nothing (the GPU-lighting A/Bs in #344–#346 were 3 reps). So:
- `--reps` defaults to 8;
- odd counts round up to even (each arm runs second in a round equally often; the second slot runs on a warmer machine);
- below 4 reps per arm a metric is INCONCLUSIVE, never GREEN.

**Noise floor (`--noise-check`).** Adds a third arm, `aa`: the base build with the base params again, booted fresh. Per metric, the spread is max(base/aa, aa/base) of the two arm medians, the same statistic as the head/base ratio over the same number of reps. A head move no bigger than that can't be RED. It is on by default when base and head are the same commit with the same params (an A/A run), and opt-in otherwise; it adds 50 % to the run time. With three arms the order walks all six permutations, and base-before-head still flips every rep. A laptop's same-code spread reached ×2 on hitches (2026-11-08), so on a laptop a hitch "regression" under ×2 is noise until shown otherwise.

**Host-load gate (2026-11-08).** A parallel Claude session once ran its own game server through a whole perf run and nobody noticed. Before and after every rep the runner samples the host (`showcase/hostLoad.ts`):
- system CPU % over 1 s, from `os.cpus()` tick deltas;
- free RAM;
- listeners on the game's ports (2567/5173 dev, 2667/5273 netgate, 2767/5373 capture, +1 and the usual offsets) or EQX node processes, owned by a PID outside this run's process tree.

A rep is **INVALID** (excluded from the verdict, kept in the ledger with its samples) and repeated up to 2 more times, 15 s apart, when free RAM < 1 GB, CPU > 25 % of all cores before it starts, or a foreign game server / Vite is listening. Flags:
- `--ignore-ports 2567,5173` acknowledges a known listener (logged in the ledger);
- `--max-cpu-pct N` moves the CPU limit;
- `--no-load-gate` records only.

Parallel sessions: `EQX_SHOWCASE_PORT_OFFSET=<n>` moves the perf arms to 2767+n / 5373+n (head +1). The capture servers kill whatever listens on their own ports at start, so two runs on one machine must use different offsets.

**The ledger records the run's conditions**: each arm's SHA, full client URL params (`art`, `fx`, `shiplight`, `worker`, …) and server env (the injected burn), the device, the GPU renderer string the browser really used (`UNMASKED_RENDERER_WEBGL`), and the host (CPU model, threads, total and free RAM). Two ledgers from different hosts or renderers are not comparable.

The base arm is a worktree at `.claude/worktrees/perf-base` that shares the root `node_modules` through a junction. Never remove it with `git worktree remove` while the junction is there: that deletes through the link (2026-11-06). Run `cmd /c rmdir <dir>\node_modules` first.

A run is **INVALID**, never fast, if any of these happen:
- a scene spawn was refused (slot pool full);
- the scene never reached its end;
- too few ships were left;
- too few frames were recorded.

## The per-PR count gates (plan machine-independent-perf WS3, 2026-11-08)

The user's laptop is noisy (×2 on hitches, same code) and the desktop isn't always there, so wall-clock timing can't gate a PR anywhere. What gates is **counts**: numbers the host can't move. Timing stays in `pnpm perf:scenes` as an A/B tool.

Two gates, both on every PR, both on any machine:

| Gate | Where | What it asserts |
|---|---|---|
| **Server** | `tests/integration/sectorRoom/perfSceneCounts.test.ts` (integration-tests job) | per scene (`fleet-fight`, `teleport-raid`, `wide-view`): no refused spawns, the scene busy enough, rx KB/s, and the work per tick over the first 720 **scene ticks**: bodies stepped, AI agents ticked, binary swarm records and bytes encoded, entities per JSON snapshot |
| **Client** | `pnpm perf:counts` (`perf/run-counts.ts`, CI job `perf-counts`, advisory) | per scene × `shiplight` (`fleet-fight`, `wide-view` × `baked`, `high`): WebGL draw calls per frame (p95), display objects, texels uploaded in the window, atlas pages |

Budgets live in `src/shared-types/perf/perfBudgets.ts` (`COUNT_BUDGETS`, `CLIENT_COUNT_BUDGETS`): max of the calibration runs + 25 %, rounded up, each naming its runs in `measured`. Both tests report EVERY budget a run broke, not just the first.

**Why these are host-independent:**
- The scene script is **tick-driven** (`SceneScriptRunner`), so a slow host plays the same ticks. The server gate reads its counters after a fixed number of scene ticks; the client gate measures between two **scene** times (t = 11 s – 19.5 s, polled from `/dev/perf`), not wall time.
- The client gate renders with **SwiftShader** (`--use-angle=swiftshader`) on every host, so the GL driver is the same on a laptop, a desktop and a GitHub runner.
- `?perfcounts=1` **pins the effects tier to High** (`EffectsBudget.pin`). Without it a slow host's budget drops effects and draws less, which would read as an improvement.
- Draw calls are counted by wrapping the WebGL context's draw entry points (fixed-arity wrappers, no allocation) and closing each frame on Pixi's `postrender` runner. It works on the worker renderer and on `?worker=0` (same counts: 22 draws p95 wide-view/baked both ways).

**What varies, and why it's not the host.** Combat plays out differently every run: wide-view ended one run with 50 ships and another with 135. So display objects (4.9k–7.2k fleet-fight) and the close fleet-fight's draw calls (40–140 p95 baked, over 6 runs on two hosts) swing with the battle. The wide shots' draw calls barely move (LOD dots: 20–22 baked, 25 high). Contacts per tick swing ±25 % on one machine, so they are print-only.

**Server work counters** (`SceneWorkCounters`, in `/dev/perf` as `work`): plain numeric fields bumped on the tick path only while a scene runs (#14). Alongside, print-only CPU time: process CPU per tick over 60-tick batches (`process.cpuUsage()`), the main thread's CPU inside `update()` on 1 tick in 10 (`process.threadCpuUsage()`, Node ≥ 23.9 only; Windows rounds it to ~15.6 ms ticks, so treat it as rough), and the physics worker's event-loop utilisation. **Process CPU is NOT the tick's work**: the room's tick loop is a `setImmediate` spin, so the main thread reads ~100 % busy whatever it does. The perf ledger records all of these.

**Ports.** `perf:counts` shifts the capture ports by `EQX_SHOWCASE_PORT_OFFSET` (default 400: server 3167, Vite 5773), so it never touches the dev ports or a parallel session. It refuses to start if anything listens on its ports, and kills nothing it didn't start.

**Local vs CI (2026-11-08, PR #356).** The server work counts on a GitHub runner fell inside the desktop's run-to-run range on every metric (fleet-fight bodies 38.6 vs 38.4–39.9; teleport-raid identical to 0.1). Client: wide-view draw calls p95 matched exactly (20 / 25); fleet-fight stayed inside the desktop spread. The one host difference is atlas pages on wide-view/baked: 9 on CI vs 8 on the desktop (bake completion order packs one more page), so that budget comes from the CI max. The runner rendered only 17–27 frames in the window under SwiftShader at full size, so the page renders at device scale 0.5 (a 480×270 backbuffer; layout, camera and LOD follow the CSS size, so the counts are unchanged) and a run needs ≥ 20 frames. Counts depend on the VIEWPORT (the camera zoom scales with width; at 640 px the fleet fight drops to LOD dots), so it is fixed at 960×540 CSS. The close fleet fight's draw calls are a loose gate: p95 40–140 over 6 runs on both hosts, all scene (explosions on screen), none host.

**Self-tests (2026-11-08):**
- Server: fleet-fight with 45-ship waves instead of 30 failed rx (281 > 275 KB/s), bodies (52.7 > 50), AI agents (51.8 > 48) and entities/snapshot (90.9 > 86). With 40-ship waves (+33 %) it passed: fights thin out, so bodies rose 22 %. The gate catches ~25 %+ growth in per-tick work, not 10 %.
- Client: 40 shapes with alternating blend modes (each breaks the batch) put wide-view at 61–62 draw calls p95 against budgets of 28 / 32: both failed.

```
pnpm perf:counts                          # gate: 2 scenes × 2 lighting levels, ~2–3 min
pnpm perf:counts --calibrate              # print readings + the budgets they'd set
pnpm perf:counts --scenes wide-view --shiplight baked --worker 0
```

`pnpm bench:gc` stays out of CI. It gates GC pause times and major-GC counts, which depend on the machine (its baseline had 0 major GCs and a run on 2026-11-06 had 1). A true per-tick allocation count needs a heap-profiling harness; that's a follow-up.

## The perf lab: watch it on your own device

The harness's numbers come from a headless laptop browser with an idle pilot. To check that they match what a person sees, `pnpm perf:lab` serves the scenes on the local network:
1. It prints a link: `http://<pc-ip>:5374/__perf-lab__/index.html`. When pasting it into chat, put it in a code block so Markdown doesn't eat the `__`.
2. Open the link on a phone or another browser and tap a scene. It plays in the real game on that device, with a countdown chip.
3. When the scene ends, the device posts its reading (frame times, hitches, renderer cost, device, plus the server's tick numbers for the same window) to `POST /dev/perf/client`. The reading is saved to `perf/ledger/devices/`.
4. The viewer only says whether it looked smooth. Nobody pastes numbers.

Those verdicts, next to the numbers from the same take, set the absolute budgets per device (`perf/budgets.{desktop,phone}.ts`, still to come).

## The phone lane: `pnpm perf:phone` (2026-11-08)

The perf lab gives one reading per tap. The phone lane runs a full A/B on a real Android phone, unattended: the same arms (base, head, optional `aa` noise arm), the same arm order (`perf/order.ts`), the same probe reads (`?perfprobe=1` + `GET /dev/perf` + DevTools socket bytes), the same verdict (`perf/verdict.ts`) and the same ledger shape as `pnpm perf:scenes`. Only the browser differs: Chrome on the phone, driven through Playwright's `_android` over adb (the path `tests/mobile-perf/helpers/androidConnect.ts` proved).

```
pnpm perf:phone --scenes fleet-fight,wide-view --reps 8 --base HEAD --base-params shiplight=baked --head-params shiplight=medium --noise-check
```

- **Where things run.** The game servers run on the laptop (one arm at a time, ports as for perf:scenes). The phone reaches Vite through `adb reverse tcp:<port>` (USB or wireless adb, no Wi-Fi routing needed, and `localhost` is a secure context); `--lan` uses the laptop's LAN IP instead (`HOST_LAN_IP` overrides the pick). Chrome is relaunched for every run, like perf:scenes' fresh context per run.
- **Fails fast.** Before any worktree or server is touched it runs `adb devices -l` and stops (exit 4) with what to do: adb not on PATH, no device, the USB-debugging prompt not accepted, a device offline, or several devices and no `--serial` (or `ANDROID_SERIAL`). Flags that only mean something for the laptop proxy (`--device`, `--cpu-rate`, `--headed`, the burn injections) are refused.
- **The phone's own noise.** A hot phone throttles its clocks. Before every run the lane reads `dumpsys thermalservice`; at or above `--max-thermal` (default 2, MODERATE), or with the screen off or locked, the run is INVALID and repeated after 30 s (up to 2 more times), the same way a busy laptop is. The laptop's host-load gate still applies too (the server arm runs there). Every sample is kept in the ledger (`load.before/after.{host,phone}`).
- **Saved settings.** Chrome on the phone keeps its localStorage between launches, so an arm without `shiplight` would run the phone's saved Lighting level. The lane warns when only one arm pins it; pin both.
- **Ledger.** `perf/ledger/<stamp>-<sha>-phone-<model>.json`. `device` is the phone ("phone · Google Pixel 7 · Android 14 · Mali-G710": model, Android version, and the GPU renderer string Chrome reported), `phone` has the getprop identity, SoC and thermal status at start, `host` is the laptop that ran the servers. `--append <ledger>` adds chunks, as for perf:scenes.
- **Exit codes:** 0 GREEN, 1 RED or INVALID, 3 INCONCLUSIVE, 2 crashed, 4 no usable phone.

On the phone, first time: Developer options → USB debugging on; accept the "Allow USB debugging?" prompt; in Chrome enable `chrome://flags/#enable-command-line-on-non-rooted-devices` and Relaunch; set a long screen timeout. The laptop needs adb (Android platform-tools) on PATH.

**No phone?** `pnpm perf:scenes --device phone-proxy --cpu-rate 2 ...` runs the same A/B on the laptop with Chrome's CPU throttled and a phone screen. It is a proxy: CPU only, with the laptop's GPU. When the two disagree, the phone wins. The GPU-lighting question's exact commands for both lanes are in [gpu-lit-ships.md](gpu-lit-ships.md#open-question-cost-on-weak-hardware).

Code: `perf/run-phone.ts` (the CLI) and `perf/phoneLane.ts` (arg parsing, the adb device check, the thermal gate, arm plan; unit-tested with adb mocked in `perf/phoneLane.test.ts`). The per-run measurement mirrors `run-perf.ts` `runOnce`; a metric added there must be added to the phone lane too.

## Proving the gate sees a regression

The runner can slow the head arm on purpose: `--inject-server-burn N` busy-waits N ms in every server tick of the perf rooms, and `--inject-client-burn N` does the same in every client frame. Before a metric gates anything, two runs must hold:
- main-vs-main comes back GREEN;
- an injected run goes RED on the right metric.

### Results (laptop, 2026-11-06)

- **Self-test:** 5 reps of idle and fleet-fight, identical code on both arms. Every gated metric GREEN. Ledger: `perf/ledger/selftest-2026-11-06.json`.
- **Injected:** fleet-fight, 4 reps, head slowed by 6 ms per server tick and 20 ms per client frame. The planted metrics went RED, the others stayed GREEN:

  | Metric | Verdict | Base | Head | p |
  |---|---|---|---|---|
  | server tick p95 | RED | 17.6 ms | 34.5 ms | 0.03 |
  | frame p95 | RED | 16.8 ms | 50 ms | 0.03 |
  | hitches | RED | 18 a minute | 482 a minute | 0.03 |

  Ledger: `perf/ledger/inject-2026-11-06.json`.
- **How sensitive it is:** the laptop is noisy. Base fleet-fight tick p95 ranged from 10 to 19 ms across one session, so the gate catches large regressions (around 1.5× or more), not 10 %. It needs at least 4 reps per arm: with 3, Mann-Whitney can never reach p < 0.05. Until 2026-11-08 the verdict still called such runs GREEN; now they are INCONCLUSIVE (see above).
- **Re-run with the three-way verdict (desktop, RTX 5070 Ti, 2026-11-08):** `--reps 3` with the same burns rounds up to 4 reps and goes RED (server tick p95 2.15 → 8.08 ms, frame p95 16.8 → 33.4 ms, hitches 0 → 323 a minute, each p = 0.03). The same ledger's first 3 reps per arm re-judged give INCONCLUSIVE on every gated metric (min p 0.10). Ledger: `perf/ledger/inject-2026-11-08.json`.
- **A finding:** a sustained 60-ship fight (180 ships over the window) pushes the laptop server's p99 tick to about 40 ms with load shedding off, against a 16.7 ms budget. In real play, time dilation and shedding absorb it.

## Adding a scene

Add one entry to `PERF_SCENES` with:
- the room options and `sceneScript`;
- the pilot spawn;
- a camera hold;
- the window;
- the minimum live entities for a valid run.

The room `perf-<id>` is registered automatically.
