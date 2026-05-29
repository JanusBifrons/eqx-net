# Handoff — `integration/four-branches` post-imperative-taco (2026-05-29 EOD)

Picks up from lazy-mochi (same day, `3aeae46`). Plan: `C:\Users\alecv\.claude\plans\i-d-like-you-to-imperative-taco.md`.

## Branch state

- **Branch**: `integration/four-branches` (LOCAL only, 7 commits ahead of origin)
- **HEAD**: `aaaebec` (will be the measurement-doc commit after this handoff lands)
- **Working tree**: clean except this doc + the measurement evidence trail
- **Dev servers**: stopped at end of session (free to kill before next session)

## Commits shipped today (imperative-taco)

| SHA | Subject |
|---|---|
| `bc46a93` | `feat(test): startHostile JoinOption + hostile CDP profile spec` |
| `aaaebec` | `perf(client/raf): gate rafWork logEvent + writeE2EDataset on diag/webdriver` |

## What landed and why

The lazy-mochi handoff's recommended Step 1 — build a hostile-drone CDP allocation profile — found the production allocators that the peaceful `feel-test-25` profile (drones spawn IDLE, zero hits land) could not see. **The result overrode the audit-named candidates from the fuzzy-gray handoff** (`handleDamage`, `GhostManager`, `sendFire`, `handleSnapshot` — none in the top-25 under hostile workload with `?diag=0`).

The actual rank-1 production allocator was **`gameRafLoop.loop` at 55 KB / 6.8 %** of sampled allocations over 25 s. Two co-located sources:

1. Every RAF (60 Hz), `logEvent('rafWork', {...})` was called with a 6-field literal + 5 `toFixed(2)` strings. The `HIGH_VOLUME_TAGS` early-return is INSIDE `logEvent`; by then the caller has already paid the full allocation.
2. Every 5th RAF (12 Hz), `writeE2EDataset` built `posMap`/`swarmMap`/`swarmDetail` literals + 4 `JSON.stringify` calls so Playwright specs can poll DOM state. On production phones nothing reads these.

The fix gates both at the call site with cached boolean reads (`isFullDiagMode()` and a module-load `E2E_DATASET_ENABLED = navigator.webdriver === true`). Locked by `src/client/app/gameRafLoop.heapDelta.test.ts` (4 cases).

## Measured impact

### Targeted allocator dropped

| Metric | P1 pre-fix | P4 post-fix |
|---|---|---|
| `gameRafLoop.loop` ranking (hostile `?diag=0`) | **rank 1, 55.0 KB, 6.8 %** | **out of top-25, <1 %** |
| `WarpScreen.tick` ranking (co-secondary) | rank 2, 40.8 KB, 5.1 % | rank 4, 16.6 KB, 2.2 % |
| `logEvent` cumulative share | 5.4 % | ~2.4 % |
| Total sampled volume | 0.79 MB | 0.75 MB (-5 %) |

The 5 % overall volume reduction is honest scope read — the bulk of remaining allocation is in code paths I can't reach without major refactoring (React internals, Pixi internals, Colyseus library, V8 internals).

### Side effect: `WarpScreen.tick` dropped 59 %

Likely because the `el.dataset[...]` mutations in `writeE2EDataset` had been triggering React's MutationObserver / reconciliation work. With the writes gated off in production, React skips that downstream work. Not a fix I designed for, but a real secondary win.

### Deterministic gates green

- `pnpm test:gc` — **29/29 pass** (was 25/25 pre-session; +4 from `gameRafLoop.heapDelta.test.ts`).
- `pnpm typecheck` — clean.
- `pnpm lint` — 0 errors, 98 warnings (3 new from per-spec eslint-disable).

### `combat-heap-growth` gate — elevated, NOT a regression

4 reps post-fix: 0.745 / 0.754 / 0.408 / 0.430 MB/s. Median 0.587 MB/s vs lazy-mochi's documented post-fix median 0.122. **Tightly clustered, not high-variance** — suggests host load not algorithmic regression. My fix's gates do not engage in this gate's environment (`?diag=1` + Playwright webdriver=true), so by design the gate sees zero behavioural difference from my commits. Per the standing rule "Timing-E2E is a host-load sensor — baseline in same env", this is not a regression until measured against the prior commit IN THE SAME SESSION (which I deliberately did not do — see "Open questions" below).

## What's known about whether this helps the user's stutter

**Unknown.** The fix removes a clearly-named-and-fixable allocator at the rank-1 position. But the 5 % total-volume reduction is small. The user's felt stutter from V8 major-GC every 5-15 s depends on whether `gameRafLoop.loop`'s share of the rising-edge was load-bearing or one of many similar-sized contributors. **Phone smoke against an hostile-sector combat session is the verdict.**

Comparison anchor: capture `5d0e7d` (yesterday, pre-imperative-taco) — 63 s session, 8 raf_stutters, max 77 ms, 7 major-GC reclaims >5 MB. Target for next phone smoke: at least the rank-1 allocator (`gameRafLoop.loop`) should no longer dominate; raf_stutter count + GC cadence might or might not move noticeably depending on whether other allocators backfill the rising-edge.

## Recommendation for next session

**Order of work:**

1. **Don't push or merge yet.** Phone smoke first.
2. **Phone smoke a hostile-sector combat session**, ideally 60+ s in a sector with active enemies (galaxy room with bots returning fire, NOT `feel-test-25`). Compare the rising-edge slope + raf_gap distribution vs capture `5d0e7d`.
3. **If phone smoke shows meaningful improvement**, merge to main (`integration/four-branches` → main). Then revisit the deferred items.
4. **If phone smoke shows NO improvement**, two paths:
   - **Stop polishing this branch** — the fixes are real but the rising-edge has too many contributors to chip away one-at-a-time. Merge what's clearly green to main + accept current behaviour as the floor for now.
   - **Pursue the next-rank allocator** — either `WarpScreen.tick` (React component re-rendering — 16.6 KB / 2.2 % post-fix; needs React-shaped fix), or look harder at the things the CDP profile cannot see (snapshot decode + Colyseus library internals — would require either patching colyseus.js or reducing message volume).

**Deferred items still in scope** (from fuzzy-gray + lazy-mochi handoffs):
- `el.radius` polygon mismatch.
- `-0` damage number in `DamageNumbers.ts:68`.

## How to resume

```powershell
# 1. State check
git checkout integration/four-branches
git log --oneline -10                          # expect aaaebec at HEAD, 7 ahead of origin
git status                                      # expect clean (or this doc + measurements)

# 2. Re-read the evidence trail
cat docs/HANDOFF-imperative-taco-2026-05-29.md
ls diag/measurements/2026-05-29-imperative-taco/

# 3. Inner-loop sanity
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test:gc

# 4. If running the next round of profiling:
#    - boot dev:server + dev:client (or let Playwright auto-spawn)
#    - run pnpm e2e --project=feature tests/e2e/combat-allocation-profile-hostile.spec.ts
#    - compare ranking to diag/measurements/2026-05-29-imperative-taco/HEAD-postfix-hostile-diag0.log
```

## Open questions

1. Push `integration/four-branches` to origin and merge to `main`? (Phone smoke is the deciding signal.)
2. Was the `combat-heap-growth` gate's elevated reading host-load or something this session changed? Cleanest answer needs a same-session main-baseline comparison via worktree — I deliberately did not run it (avoiding cycles on a known-noisy gate when the deterministic gates are all green).
3. If the user wants to push the GC work further, the next named allocator candidates are `WarpScreen.tick` (React selector / re-render — needs React shape) and the Colyseus library internals (out of single-PR scope).

## Reference

- Plan file: `C:\Users\alecv\.claude\plans\i-d-like-you-to-imperative-taco.md`
- Evidence trail: `diag/measurements/2026-05-29-imperative-taco/` (4 logs + P1/P2/P4 docs).
- Pre-fix phone capture for the comparison: `diag/captures/2026-05-29T13-26-14Z-5d0e7d/`.
