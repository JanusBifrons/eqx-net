---
name: e2e-triage
description: Triage a red `@smoke` or `@feature` Playwright spec (locator-drift / timing / real-regression) and propose a deterministic fix. Refuses to "fix" a `@gate` failure by loosening the budget.
allowed-tools: Bash, Glob, Grep, Read, Edit
disable-model-invocation: true
---

# /e2e-triage — healer-style E2E spec triage

You are diagnosing a failing Playwright spec in EQX Peri. The goal is a **deterministic fix**: a tighter spec, a bespoke trigger, or a real regression — never `expect(...).toBeVisible({ timeout: 90_000 })`-style "wait longer."

## What this is for

- The user has a red `@smoke` or `@feature` spec and wants to know whether it's a stale locator, a timing issue, or a real code regression.
- The user typed `/e2e-triage <path/to/spec.ts>` or `/e2e-triage <path/to/spec.ts>:<test-name-grep>`.

## Invocation

- `$1` — spec path (required; e.g. `tests/e2e/persistence-kill.spec.ts`)
- `$2` (optional) — `--grep` pattern to narrow within the spec

## What to do

1. **Refuse `@gate` triage.** If the spec is `tests/e2e/netcode-health.spec.ts` (or anything tagged `@gate` in `playwright.config.ts`'s `GATE_SPECS`), STOP. Reply: *"`@gate` failures are handled by the data-driven margin protocol (`docs/architecture/e2e-framework.md` + plan Mechanism 4), not by spec-level triage. Use `/netgate` to characterise the failure; if it's a real regression, `git bisect run pnpm e2e:netgate` localises the commit. Loosening a `@gate` margin to silence a failure is forbidden."* Do not proceed further.

2. **Re-run the failing spec in isolation.** Announce the runtime up front (per root CLAUDE.md E2E playbook):

   > Running `<spec>` — expect ~30 s wall-clock, Bash timeout 60 s.

   Then:
   ```bash
   pnpm e2e --project=feature <spec> --reporter=line [--grep "<test name>"]
   ```
   (Use `--project=smoke` if the spec lives in `SMOKE_SPECS`.)

   **Pre-flight: kill stale dev servers first** (feedback memory: stale servers cause phantom E2E failures). Before the run:
   ```bash
   netstat -ano | findstr ":2567 :5173" | findstr LISTENING
   # For each PID returned: Stop-Process -Id <pid> -Force
   ```

3. **Classify the failure.** Look at the error message + the trace (`test-results/<spec-name>-<id>/error-context.md`). Three categories:

   **A) Locator drift** — the spec waits for an element that no longer exists / has been renamed / moved into a portal.
   - Telltale: `locator(...).toBeVisible failed`, `element(s) not found`, `Timeout exceeded` after a UI refactor.
   - Triage: grep `src/client/` for the OLD locator text; find the new component; update the spec. Mechanically a one-locator-change commit.

   **B) Timing / race** — the spec assumes the gameplay state is reached within N seconds, but a tuning PR moved that threshold past N.
   - Telltale: TTK changed (slow-down-gameplay 2026-05-18 raised HP 50 %), warp spool changed (30 s, was 3 s), regen rate changed, snapshot cadence changed.
   - Triage: **add a bespoke gameplay trigger**, do NOT bump the timeout. The catalogue is in `docs/architecture/e2e-framework.md` "Bespoke gameplay triggers". Today's primitives: `initialHull`/`initialShield` (one-tick-kill), `testTimeScale: 10` room (`test-sector-fast`), `testId` + `filterBy(['testId'])` (per-test rooms). If none fits, define a new one (see the doc's "Adding a new primitive" section).
   - **Reject `test.setTimeout(N_MUCH_LARGER)` and `page.waitForTimeout(N)` as triage answers.** They re-break on the next tuning PR.

   **C) Real regression** — the gameplay surface itself broke.
   - Telltale: a fresh-server isolated rerun still fails; the spec is asserting a behaviour that the current code does not produce; `git log -- <surface>` shows a recent change.
   - Triage: hand back to the user with the smoking-gun commit (`git log` between the spec's last green commit and HEAD on the surface files). DO NOT silently disable the spec. The framework's value IS catching real regressions.

4. **Bespoke-trigger discipline (the load-bearing rule).** When category B is the verdict, the report MUST include:
   - Which existing primitive (if any) skips the game-time delay.
   - If none fits: the proposed new primitive name + JoinOption/room-option shape (zod schema sketch).
   - The reason a timeout bump would be wrong (cite the philosophy: bumps re-break on the next tuning PR).

5. **Output format.** Hand back a short structured report:

   ```
   Verdict: [LOCATOR_DRIFT | TIMING_RACE | REAL_REGRESSION | GATE_REFUSED]
   Spec: <path>:<line>
   Symptom: <one-line>
   Diagnosis: <2-3 sentences>
   Suggested fix:
     - If LOCATOR_DRIFT: <new locator + file:line of new component>
     - If TIMING_RACE: <existing primitive OR proposed new primitive>
     - If REAL_REGRESSION: <suspect commit range OR component> (HAND BACK to human)
   Anti-patterns rejected: <any "bump the timeout" approaches considered and rejected>
   ```

6. **Don'ts.**
   - **Never** bump a timeout to silence a failure (root CLAUDE.md test-harness philosophy).
   - **Never** delete a broken spec to "make CI green." It locks a real surface; demote to `test.fixme(...)` with a documented reason if the fix is too costly for this session.
   - **Never** loosen a `@gate` budget — route to `/netgate` instead.
   - **Never** assert a gameplay-state guess without reading current `src/` — the symptom may not match what the spec was trying to lock.

## References

- Test-harness philosophy: root `CLAUDE.md` "Test-harness philosophy" section.
- Bespoke triggers catalogue: `docs/architecture/e2e-framework.md` "Bespoke gameplay triggers".
- Plan: `C:\Users\alecv\.claude\plans\i-want-you-to-lively-tulip.md` Phase 4c.
- Invariant #13 (the right test LEVEL): root `CLAUDE.md`.
