---
name: netgate
description: Run the netcode-health gate (`pnpm e2e:netgate`) and report the verdict (pass/fail + offending metric + magnitude). The front door to Phase 1 of the e2e-rebuild plan — localises live-loop regressions without on-device testing.
allowed-tools: Bash
disable-model-invocation: true
---

# /netgate — netcode-health regression gate

You are running EQX Peri's machine-insensitive netcode-health gate to detect live-loop regressions between two refs (or HEAD-vs-`origin/main` by default). This is the canonical Phase-1 deliverable; it ships an outcome-only verdict, not a hypothesis.

## What this is for

- The user has made changes in `src/client/net/`, `src/core/prediction/`, `src/core/physics/`, the client render loop, snapshot decode/interpolate, mount aim, or `SectorRoom`'s tick/snapshot path — anything that could plausibly move `data-pred-stats`.
- The deterministic suite (typecheck/lint/unit/integration/bench) is GREEN, but green-deterministic is **not** a playability signal (root CLAUDE.md invariant #8 corollary; 2026-05-19 incident).
- The user wants to know: *is HEAD playable, relative to a known-good baseline, on this box?*

## Invocation

The user typed `/netgate` (or `/netgate <baselineRef> <headRef>`). Arguments:

- `$1` (optional) — baseline ref (default `origin/main`)
- `$2` (optional) — head ref (default working tree)

## What to do

1. **Pre-flight check.** Confirm:
   - We're inside a git repository (`git status` succeeds).
   - The working tree is clean OR the user has accepted that `head = working tree` includes uncommitted changes. If neither, ask once before running.
   - The user has been told *up front* that this is a 6–8 minute multi-arm run (announce timing per the timeout protocol in root CLAUDE.md).

2. **Run the gate.** Use `Bash` with `run_in_background: false` and an explicit `timeout: 720000` (12 min — ~50 % cushion over the ~6–8 min expected runtime). Redirect output to a log file so the verdict survives any harness truncation:

   ```bash
   pnpm e2e:netgate <baseline> <head> 2>&1 | tee .claude/netgate-last.log; echo "EXIT=$?"
   ```

   (Omit args when defaults are wanted.)

3. **Parse the verdict.** Read the log file. The gate's output stanza is:

   ```
   === netcode-health verdict (medians over N reps) ===
     baseline: { ...stat block... }
     HEAD    : { ...stat block... }
     [PRECONDITION FAILURES: ...]    ← if any (a DISTINCT result; "the gate did not validly run")
     [REGRESSION <metric>: HEAD <h> vs baseline <b> ratio=X ...]   ← per failing metric
     PASS=true|false
   ```

   The single source of truth for the budget thresholds is `tests/netgate/netHealthBudget.ts`.

4. **Report.** Three branches:

   - **PASS=true.** "Netgate green. HEAD ≈ baseline within margin on this box. The on-device pain (if any) reproduces as *baseline-equivalent*, i.e. a pre-existing issue rather than a HEAD regression — investigate as a scoped fix, not a wrap-up rollback." Include the baseline + HEAD stat blocks verbatim.

   - **PASS=false, with REGRESSION lines.** "Netgate RED on `<metric>` (HEAD <h> vs baseline <b>, ratio Xx, beyond the `MARGIN=Y, EPS=Z, CEIL=W` AND-gate). HEAD has a real netcode regression vs baseline. Suggested next step: `git bisect run pnpm e2e:netgate` between `<baseline>` and `<head>` — the gate is a deterministic pass/fail script so bisect narrows the offending commit automatically." Include the offending metric line(s) and the baseline + HEAD stat blocks.

   - **PRECONDITION FAILURES (snapshotCount, diagEnabled, etc.).** "Netgate did not validly run — `<precondition>`. This is NOT a healthy verdict; it means the measurement environment was wrong (e.g. `?diag=1` slipped on, the room never spawned, dev server didn't boot). Diagnose the precondition before re-running. The verdict is undefined."

5. **Don'ts (load-bearing rules — do NOT violate):**
   - **Do NOT predict from `git diff`.** "Those commits don't touch netcode so it's probably fine" is the falsified cop-out class — the gate exists so we never make that prediction. Report the metric, not a theory.
   - **Do NOT widen a margin to silence a flake.** If the gate flakes, run `main`-vs-`main` ≥ 3× to characterise variance and fix the *mechanism* (or demote the metric to print-only — like `snapshotJitterMs`); never the threshold.
   - **Do NOT measure with `?diag=1`.** The Phase 0a `?diag=0` override is the gate's whole "measure production code" assertion. The spec asserts `__eqxDiagEnabled === false` before reading stats.
   - **Do NOT run the gate in the inner loop.** It creates worktrees and takes 6–8 minutes. The deterministic suite is the inner loop; the netgate is a conditional outer gate.

## On flakes

If the gate flakes (PASS state varies across identical invocations), the answer is to characterise the variance with `main`-vs-`main` ≥ 3×, then either:
- demote the unstable metric to print-only (like `snapshotJitterMs` already is), OR
- fix the underlying mechanism.

Never widen a `MARGIN/EPS/CEIL` to "smooth over" the flake. The anti-flake architecture is mechanism, not margin.

## References

- Plan: `C:\Users\alecv\.claude\plans\i-want-you-to-lively-tulip.md` (Phase 1 + Mechanism 1–4)
- Budget module (single source of truth): `tests/netgate/netHealthBudget.ts`
- Driver: `tests/netgate/run-netgate.ts`
- Spec: `tests/e2e/netcode-health.spec.ts`
- Root CLAUDE.md: "Netcode-health gate" section
