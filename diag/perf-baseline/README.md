# `diag/perf-baseline/` — perf-floor captures

This directory holds the captured perf-baseline JSONs from
`pnpm e2e:perf` (Phase 2 of the perf-floor plan, automated arms) and
`scripts/ingest-device-capture.mjs` (Phase 3, manual on-device captures).

## Files (per perf-floor plan)

- `sol-prime-ambient-desktop.json` — desktop Chromium, `?galaxy=sol-prime`.
- `sol-prime-ambient-mobile-shaped.json` — CDP-throttled (4× CPU, DPR 2,
  414×896), same URL.
- `feel-test-25-desktop.json` — desktop Chromium, `?room=feel-test-25`.
- `feel-test-25-mobile-shaped.json` — CDP-throttled, same room.
- `*-device-ios.json` — manual on-device capture from iOS Safari
  (Phase 3 protocol).
- `*-device-android.json` — manual on-device capture from Android Chrome
  (Phase 3 protocol).

## Schema

See `tests/perf/perfCapture.ts` `PerfAggregate` for the exact shape.

## How to re-capture

1. **Kill stale dev servers** (root `CLAUDE.md` § "Stale dev servers"):
   ```powershell
   netstat -ano | findstr ":2567 :5173" | findstr LISTENING
   # for each PID:
   Stop-Process -Id <pid> -Force
   ```
2. **Run on a quiet host** — Playwright competing with another running
   browser session, an IDE indexing the project, or a memory-pressured
   OS will inflate `rafP50Ms` substantially (observed ~100 ms p50 on a
   loaded box where a quiet box reports ~16 ms).
3. **Run `pnpm e2e:perf`** — captures all 4 (scenario × arm) pairs.
4. **Review the JSONs** — `diagEnabledAtCapture` MUST be `false` (a
   `true` value invalidates the capture entirely; Phase 0a `?diag=0`
   should prevent it). `sampleCount` < 20 is a soft warning (sparse
   data — re-run on a quieter box).
5. **Commit the JSONs** when satisfied with the baseline. Phase 5's
   `perfBudget.ts` reads these as the reference HEAD-vs-baseline lock.

## Why not in CI

Per the perf-floor plan anti-pattern list: `pnpm e2e:perf` is NOT in
default CI. It runs ~4 minutes per full capture and is host-load
sensitive. The captures inform Phase 4 triage and Phase 5 locks; they
are NOT a continuous gate. Phase 6's `pnpm e2e:perfgate` is the
continuous-gate path (manual invocation only).
