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
| Verdict | `perf/verdict.ts`: exact Mann-Whitney U plus a relative AND an absolute floor per metric |

## Running it

```
pnpm perf:scenes                                  # every scene, 5 reps, head vs origin/main
pnpm perf:scenes --scenes fleet-fight --reps 3    # one scene
pnpm perf:scenes --head-only --reps 1             # a quick look, no A/B
```

The base arm is a worktree at `.claude/worktrees/perf-base` that shares the root `node_modules` through a junction. Never remove it with `git worktree remove` while the junction is there: that deletes through the link (2026-11-06). Run `cmd /c rmdir <dir>\node_modules` first.

A run is **INVALID**, never fast, if any of these happen:
- a scene spawn was refused (slot pool full);
- the scene never reached its end;
- too few ships were left;
- too few frames were recorded.

## The perf lab: watch it on your own device

The harness's numbers come from a headless laptop browser with an idle pilot. To check that they match what a person sees, `pnpm perf:lab` serves the scenes on the local network:
1. It prints a link: `http://<pc-ip>:5374/__perf-lab__/index.html`. When pasting it into chat, put it in a code block so Markdown doesn't eat the `__`.
2. Open the link on a phone or another browser and tap a scene. It plays in the real game on that device, with a countdown chip.
3. When the scene ends, the device posts its reading (frame times, hitches, renderer cost, device, plus the server's tick numbers for the same window) to `POST /dev/perf/client`. The reading is saved to `perf/ledger/devices/`.
4. The viewer only says whether it looked smooth. Nobody pastes numbers.

Those verdicts, next to the numbers from the same take, set the absolute budgets per device (`perf/budgets.{desktop,phone}.ts`, still to come).

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
- **How sensitive it is:** the laptop is noisy. Base fleet-fight tick p95 ranged from 10 to 19 ms across one session, so the gate catches large regressions (around 1.5× or more), not 10 %. It needs at least 4 reps per arm: with 3, Mann-Whitney can never reach p < 0.05.
- **A finding:** a sustained 60-ship fight (180 ships over the window) pushes the laptop server's p99 tick to about 40 ms with load shedding off, against a 16.7 ms budget. In real play, time dilation and shedding absorb it.

## Adding a scene

Add one entry to `PERF_SCENES` with:
- the room options and `sceneScript`;
- the pilot spawn;
- a camera hold;
- the window;
- the minimum live entities for a valid run.

The room `perf-<id>` is registered automatically.
