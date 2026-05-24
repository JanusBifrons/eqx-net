# `diag/` — committed diagnostic artefacts

This directory is **tracked in git**. Captures from `POST /diag/capture`,
`pnpm e2e:perf` perf baselines, and one-off CDP traces all persist
in-repo so they can be re-read alongside the code that produced them.

Policy reversed on 2026-05-24 — previously `/diag/*` was ignored with
only `diag/perf-baseline/` un-ignored. The reversal exists so phone
smoke captures (which carry the only evidence of mobile-RAF / spiral
regressions) survive across sessions and machines, and so any
contributor can audit the capture that triggered a given fix without
re-running the failing scenario.

## Subdirectories

- `captures/<ISO-timestamp>-<id>/` — directory per session, populated by
  `POST /diag/capture` (`src/server/routes/diagRouter.ts`). NDJSON
  siblings (`raf`, `corrections`, `combat`, `lifecycle`, `population`,
  `snapshots`, `perf`, `other`) plus a top-level `summary.json` with tag
  histograms + extracted highlights. Read `summary.json` first; it tells
  you which sibling has the rows for the question you're asking. For
  streaming sessions (`?autocapture=1`), `session.json` is the in-flight
  marker until finalisation.
- `perf-baseline/` — captured perf-baseline JSONs from `pnpm e2e:perf`
  (perf-floor Phase 2) and `scripts/ingest-device-capture.mjs` (Phase
  3). See `perf-baseline/README.md` for the per-file schema + re-capture
  procedure. Phase 5's `perfBudget.ts` reads these as the HEAD-vs-baseline
  reference lock.
- `drawer-lag-trace/` — CDP performance trace captured on 2026-05-13
  during the drawer-perf incident; the canonical reference for the
  paradigm-shift documented in `docs/HANDOFF-drawer-perf-2026-05-13.md`
  and `docs/LESSONS.md`. Analysed via `scripts/analyze-cdp-profile.mjs`.

## Working with captures

- The capture id (the `-<id>` suffix) is what plans, memory entries, and
  bug reports cite (e.g. `iph9cv`, `2q0jxw`, `d3cprl`). Search the repo
  for a capture id to find every reference: `Grep` the id literal, or
  `git log --all -S <id>` for commits that mention it.
- Replay harness: `scripts/replay-capture.mjs <dirName>` consumes a
  capture directory (streaming or finalised) and emits a deterministic
  trace; see `docs/architecture/replay.md` if it exists, else the script
  source.
- To prune: deliberate `git rm -r diag/captures/<dirName>` with a commit
  message explaining what the capture proved and why it's now redundant.
  Don't bulk-delete — most captures pin a regression-lock to a specific
  commit and removing them costs that audit trail.

## What does NOT belong here

- Anything sensitive or user-identifying. Captures contain per-session
  UUIDs (non-PII) and gameplay telemetry only; if a future capture
  source introduces real PII (player email, IP, etc.), gate the field
  out at the capture writer before it ever lands on disk.
- Workspace scratch (`*.log`, `*.stackdump`) — caught by the global
  `.gitignore` rules.
- E2E test artefacts (`playwright-report/`, `test-results/`) — they
  belong in their own gitignored directories.
