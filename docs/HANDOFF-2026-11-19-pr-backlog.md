# Handoff 2026-11-19: PR backlog cleared (post-mortem and situation)

Written 2026-11-19 ~12:15 UTC, after the PR-backlog session. **Read this first if you are a session
that was running before 2026-11-18 21:00 UTC:** the PR you were waiting on has probably merged, and
`main` has moved a long way.

## Situation now

- **Open PRs: 0.** Everything that was open on 2026-11-18 evening has merged into `main`.
- **76 PRs merged** between 2026-11-18 21:05 UTC and 2026-11-19 12:06 UTC (#849 to #948):
  - 47 god-file split refactors: SectorRoom 16, ColyseusClient 11, AI brain 11, PixiRenderer 9,
    LivingWorldDirector 3, World 2, fractureHull 2, IRenderer 1, drone tuning 1.
  - 12 features: navigation slices 13–17 and fine-rebuild A/B/C1/C2, join flow stages 3/5/6/7,
    galaxy panel, wreck fields 0b and 9.
  - 7 fixes, 1 docs: hitscan holds on a blocked line (#901), tractor line of sight (#882), barge side
    cone (#876), restored pod look (#871), deterministic `?artDelayMs` (#943), and the flaky-test fixes
    below.
- **If your branch predates this:** `git fetch && git merge origin/main` (never rebase). Expect conflicts
  wherever you touched `SectorRoom.ts`, `ColyseusClient.ts`, `PixiRenderer.ts`, the AI brain or
  `scripts/audit-god-files.mjs`. Code you remember in those files has probably moved to a
  `features/`, `handlers/` or mode module. Grep for the method name before re-adding anything.
  - SectorRoom fleet methods are now reached as `room.wingmen.*`.
  - Fire-control locks live in `src/server/rooms/features/fireControlLocks.ts`.
- **Decided, do not reopen:**
  - Nav hull clearance stays at **30 u**. The owner tried a change and said "leave it".
  - The `fix/nav-clearance-shield` worktree holds nothing to merge.
- **Parked:** time dilation can't absorb an overloaded host. See `docs/SHELF.md`, entry
  "Time dilation can't absorb an overloaded host". It is a live-loop change and needs a failing test
  and the netgate first.
- **Known red, not required:** `perf-counts` is red on `main` and was already shelved. It is not a
  required check.

## Post-mortem: why there was a backlog

There were about 60–75 open PRs at the start. A full CI round takes about an hour, and only a few
runners work at once. Four things compounded:

1. **Deep stacks merged one at a time.** The god-file splits were chains of up to 16 PRs, each based on
   the one below. Merging bottom-up meant one full CI round per link, run one after another, so a
   16-PR chain took about 16 hours even with no failures.
2. **A shared hot file made every merge a conflict.** Every split PR lowered its own cap in the same
   table in `scripts/audit-god-files.mjs`, and most also touched `SectorRoom.ts` or
   `ColyseusClient.ts`. Each merge put every sibling PR into conflict, and fixing a conflict restarted
   that PR's CI. One wave left 14 PRs conflicting at once.
3. **Flaky required tests turned one failure into many lost hours.** Each red integration shard costs a
   full re-run, and a stack can only merge once its top passes. The root causes:
   - `bargeMiningTake` bounded the take by **wall time**. On a loaded CI host, ticks drop past
     `CATCH_UP_MAX_TICKS`, so it ran out of time with 0 chunks. Fixed in #947 by bounding game time
     (`serverTick`) instead, as a test-only change.
   - `eliteDirector` lost its haul on the cargo death **coin flip**. Fixed in #947 by booting with
     `keepAllOnDeath: true`.
   - `wreckBattleStreaming` **double-counted** restored wreck pieces, which come back with fresh ids.
     Fixed in #854 with a `restoredPieces` stat.
   - The factory-line fixture broke a fighter too near the bubble. Fixed in #946.
4. **Holds across streams.** Some refactor chains waited on #836 and #843 from another session, so they
   were ready but blocked.

## What cleared it

- **Merge only the top of each stack.** A stack's top contains every commit below it, so one green
  CI round merges the whole chain, and GitHub marks the lower PRs merged. This turned roughly 16 serial
  rounds into one per stack, and is the biggest single win.
- **Resolve cap-table conflicts mechanically.** On a `scripts/audit-god-files.mjs` cap conflict, take
  the lower of the two caps. That is always correct, because caps only ratchet down. A small script did
  this across every PR instead of by hand.
- **Fix the flake's root cause, never re-run and hope.** A test that fails when the host is loaded or on
  a coin flip will fail again on the next PR. Bound a test by game time, not wall time, and pin
  randomness with a test room option.
- **Every PR had auto-merge on**, so a PR merged the moment it went green, with nobody watching.

## Doing it differently next time

- Cap stack depth, or plan from the start to land a stack top-only. Do not open 16 dependent PRs that
  each wait for full CI.
- Don't run several parallel sessions that all edit the same god file and the same cap table. Run
  those splits as one chain per file.
- A required test with a wall-clock bound or an unpinned random outcome is a backlog waiting to happen:
  fix it the first time it flakes.
