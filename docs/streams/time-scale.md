# Stream: game-wide time scale (`stream/time-scale`)

**A parallel stream. Never open a PR for this branch, merge it, put it in a train,
cherry-pick from it or merge it into another branch.** It pulls `main` into
itself (merge, never rebase), and nothing flows back. It lands only when the
owner says so. Registered on main in #473 (SHELF.md, handoff "Parallel streams").

- Plan: `C:\Users\alecv\.claude\plans\i-d-like-you-to-deep-elephant.md` (desktop).
- Design: `docs/architecture/game-time-scale.md`, amended by the owner on
  2026-11-12:
  - the speed goes both ways (0.25×–4×);
  - game time is the default, so nothing opts in: one `GameClock`, the
    fixed-step count and the render frame's dt; the wall clock is lint-banned
    outside a real-time allowlist.
- Worktree: `.claude/worktrees/stream-time-scale`. Local port lane: offset 470
  (`EQX_E2E_PORT_OFFSET`, `EQX_SHOWCASE_PORT_OFFSET`, `NETGATE_PORT_OFFSET`).
- Checks: CI doesn't run on this branch. Run the inner loop locally after every
  slice. At phase ends that touch the live loop, start netgate by hand:
  `gh workflow run netgate.yml --ref stream/time-scale`.
- Every slice keeps the game identical at 1×.

## Last sync from main

- 2026-11-12: branched from `1513f927`.

## Phases

| # | Phase | Status |
|---|---|---|
| 0 | Register the stream (#473), log, memory | done |
| 1 | Telemetry: worker dropped ticks, sim-time lateness | next |
| 2 | `GameClock` + lint wall + migration | |
| 3 | Server scale + dev override (`testTimeScale` folds in) | |
| 4 | Client: prediction anchor, interpolation, frame dt, speed chip | |
| 5 | Dynamic controller (slows only, galaxy-wide) | |

## Log

- 2026-11-12: stream started.
