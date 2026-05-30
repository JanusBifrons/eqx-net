# Phase 4 — Post-fix re-measurement vs Phase 1 baseline

Fix shipped on `integration/four-branches`:

| SHA | Subject |
|---|---|
| `bc46a93` | `feat(test): startHostile JoinOption + hostile CDP profile spec` |
| `aaaebec` | `perf(client/raf): gate rafWork logEvent + writeE2EDataset on diag/webdriver` |

## CDP hostile allocation profile (post-fix vs P1 pre-fix), `?diag=0`

Same spec, same workload, same browser. 25 s held-fire on `feel-test-25` + `startHostile=1`.

| Function | P1 pre-fix | P4 post-fix | Δ KB | Δ rank |
|---|---|---|---|---|
| **`gameRafLoop.loop`** | **55.0 KB (6.8 %)** | **NOT IN TOP-25** | **< -47 KB** | **rank 1 → out** |
| **`tick` WarpScreen.tsx** | 40.8 KB (5.1 %) | 16.6 KB (2.2 %) | -24.2 KB | rank 2 → rank 4 |
| `exec` (V8 internal) | 31.4 KB (3.9 %) | 23.7 KB (3.1 %) | -7.7 KB | rank 3 → rank 1 |
| `onMessageCallback` colyseus | 30.1 KB (3.7 %) | (out of top-25) | -22+ KB | rank 4 → out |
| `keys` (V8 internal) | 23.4 KB (2.9 %) | (out of top-25) | -15+ KB | rank 5 → out |
| `validateChildKeys` React | 20.0 KB (2.5 %) | (out of top-25) | -12+ KB | rank 6 → out |
| `logEvent` cumulative | 43.4 KB (5.4 %) | ~18 KB (~2.4 %) | -25 KB | -3.0pp |
| **TOTAL sampled** | **0.79 MB** | **0.75 MB** | **-0.04 MB (-5 %)** | |

**Read-out**: The targeted allocator (`gameRafLoop.loop`) dropped from rank 1 / 6.8 % share to outside the top-25 (<1 %). `WarpScreen.tick` co-dropped substantially (-59 % share) — likely because the `writeE2EDataset` dataset mutations had been triggering React MutationObserver / reconciliation work that no longer fires in the new gated path. `logEvent` cumulative roughly halved because the `rafWork` builder no longer feeds the ring with a 6-field literal every RAF.

**Honest scope read**: Total sampled volume only fell 5 %. The bulk of the residual allocation is in code paths I can't reach without major refactoring — Pixi internals (`deepmerge`, `checkType`), React internals (`renderWithHooks`, `validateProperty$1`, `useUtilityClasses`), Colyseus library (`onMessageCallback`), and V8 internals (`exec`, `keys`, `getPrototypeOf`). The fix removes a clearly-named-and-fixable production allocator; it does NOT fundamentally restructure the steady-state pattern. **Phone smoke is the verdict on whether GC-cadence felt-impact moves.**

## combat-heap-growth gate (4 reps, post-fix)

The gate runs `feel-test-25` peaceful + `?diag=1` + Playwright (`navigator.webdriver=true`). Under that environment **neither** of my gates engages (isFullDiagMode=true, E2E_DATASET_ENABLED=true), so the fix has by-design zero effect on this gate's measurement.

| Rep | slope MB/s | rafGapCount | maxStallElapsedMs | peakMb |
|---|---:|---:|---:|---:|
| 1 (back-to-back after hostile profile) | 0.745 | 30 | 1049.9 | 64.06 |
| 2 (back-to-back) | 0.754 | 34 | 1016.6 | — |
| 3 (10 s cooldown) | 0.408 | 46 | 433.3 | — |
| 4 (after fresh dev-server boot + 3 s cooldown) | 0.430 | 37 | 833.2 | — |
| **Median** | **0.587** | **35** | **925** | — |
| lazy-mochi P4 post-fix median (different session) | 0.122 | 22 | 350.1 | 49.05 |

Reps 1-4 are tightly clustered at 0.4-0.75 MB/s — **stable but elevated** vs lazy-mochi's session median of 0.122. Lazy-mochi's individual reps ranged 0.071-0.920; mine fit within that range but cluster higher. **This is the documented "Timing-E2E is a host-load sensor" pattern** — the gate measures GC scheduling decisions that depend on V8 + OS state at the moment of the run, not the deterministic code path. My commits do not touch any allocator that fires in this gate's environment.

Conclusion per the user's standing rule "deterministic gates ≠ playable; rely on the deterministic gates":

- ✅ `pnpm test:gc` — 29/29 pass (was 25/25; +4 from new `gameRafLoop.heapDelta.test.ts`)
- ✅ `pnpm typecheck` — clean
- ✅ `pnpm lint` — 0 errors, +3 warnings (new eslint-disable for the test's console suppression)
- ✅ Targeted CDP profile — `gameRafLoop.loop` dropped from rank 1 to out-of-top-25
- ⚠ `combat-heap-growth` — 4 reps elevated above lazy-mochi's session median; cluster suggests host load (gate environment doesn't engage either of my fixes by design)

The user's phone smoke is the next signal. The expected behaviour: a phone capture of hostile-sector combat should show the rank-1 production allocator (the `gameRafLoop.loop` JSON.stringify + literal churn) is gone. Whether that meaningfully reduces the felt GC stutter cadence vs capture `5d0e7d` depends on whether `gameRafLoop.loop` was a load-bearing contributor to the 2.5 MB/s rising-edge or just one allocator among many.

## Verification commands run

```powershell
# Inner loop
pnpm typecheck             # clean
pnpm lint                  # 0 errors, 98 warnings (3 new)
pnpm test:gc               # 29/29 pass

# Outer loop
netstat -ano | findstr ":2567 :5173" | findstr LISTENING   # killed stale
# Stop-Process -Id <pid> -Force; boot fresh dev servers
pnpm e2e --project=feature tests/e2e/combat-allocation-profile-hostile.spec.ts --reporter=line
pnpm e2e --project=feature tests/e2e/combat-heap-growth.spec.ts --reporter=line     # × 4 reps
```

Git state at end-of-phase: `git status` clean, `integration/four-branches` HEAD `aaaebec`, 2 commits this session ahead of `3aeae46` (lazy-mochi handoff).
