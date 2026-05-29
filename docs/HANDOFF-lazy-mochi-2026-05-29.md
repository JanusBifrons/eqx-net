# Handoff — `integration/four-branches` post-lazy-mochi (2026-05-29 EOD)

## Branch state

- **Branch**: `integration/four-branches` (LOCAL only, 5 commits ahead of origin)
- **HEAD**: `088e8d0`
- **Working tree**: clean
- **Dev servers**: were running at handoff time (Vite 5173 + Colyseus 2567); free to kill before next session

## Commits shipped today (lazy-mochi plan)

| SHA | Subject |
|---|---|
| `4a5558e` | `chore(deps): pin @playwright/test to 1.49.0 exact` |
| `1d0c18f` | `perf(net): tighten ramming_probe gate to ?probe=ram opt-in` |
| `7af9620` | `perf(effects): pool ImpactSparks particles + heap-delta lock` |
| `9803224` | `perf(effects): pool DestructionFx particles + heap-delta lock` |
| `088e8d0` | `docs(diag): lazy-mochi P1-P4 measurement evidence trail` |

## Phone-smoke verdict (capture `2026-05-29T13-26-14Z-5d0e7d`)

63 s session on a real Android 10 Chrome 148 device. User-reported: "feels back to normal when calm; I think it's the RAF stalls I can feel most now".

### Data verifies "calm feels normal"

| Metric | This session | gate (HEAD post-fix) | gate (HEAD pre-fix) | main baseline |
|---|---|---|---|---|
| raf_gap events (>100 ms) | **0** | 22 | 15 | 1 |
| raf_stutter events (30-100 ms) | **8** (max 77 ms) | n/a | n/a | n/a |
| longtasks > 100 ms | **2** (both initial-join burst) | n/a | n/a | n/a |
| heap slope (overall) | **0.104 MB/s** | 0.122 (median 3-rep) | 0.462 | 0.428 |
| Duration of zero-stutter gameplay | 20-60 s (40 s window) | n/a | n/a | n/a |

Comparable to perf-floor-shipped baseline (2026-05-25 `vr9mrb`): 0 raf_gap stalls diag-on, slope -0.042 MB/s diag-off, accepted as "fine tuning and bugs on other areas".

### Stall pattern (where the user feels them)

Stutters cluster at TWO event-bound windows, NOT throughout gameplay:

**Window 1 — ts=12-13 s (initial join):**
- Welcome message at ts=12.764 s
- 189 ms longtask starting ts=12.022 s
- 387 ms longtask starting ts=12.264 s
- 5 raf_stutters in 200 ms (max 77 ms)
- Likely cause: post-welcome catch-up burst (Pixi cache warm, first snapshot decode, asteroid swarm spawn, predWorld init, reconciler init). This is essentially a one-shot warmup tax.

**Window 2 — ts=60-65 s (session end):**
- 32 small longtasks (50-79 ms each) clustered in 10 s
- 3 raf_stutters (max 44 ms)
- 41.9 MB heap reclaim at ts=64.1 s
- Likely cause: V8 incremental major-GC slices firing before disconnect tear-down.

**ts=20-60 s = clean gameplay** — 27 warp events, 50 fires, 76 damage_number_spawned events, zero longtasks, zero stutters.

### The actual story under the surface

Overall slope (0.104 MB/s) hides a **sawtooth allocation pattern**:

| Time window | Heap behaviour | Rising-edge rate |
|---|---|---|
| 13 → 28 s | 51 → 95 MB | **2.92 MB/s** rising |
| 28 → 36 s | 56 → 75 MB | **2.63 MB/s** rising |
| 36 → 44 s | 56 → 76 MB | **2.43 MB/s** rising |
| 44 → 49 s | 58 → 69 MB | **2.32 MB/s** rising |
| 49 → 64 s | 59 → 98 MB | **2.61 MB/s** rising |

7 major reclaims (>5 MB) in 50 s — V8 major-GC every 5-15 s. The reclaims at 28.6 s (38.7 MB) and 64.1 s (41.9 MB) were large enough to fully recover the heap, but V8 mostly used concurrent/incremental GC (longtasks 50-79 ms, not blocking RAF events).

**So**: the 2.5 MB/s rising-edge allocation rate IS allocating something real during gameplay. The fixes shipped today addressed the gate-measurement allocators (`ramming_probe` was 76 % of the gate confound; `ImpactSparks` + `DestructionFx` were the handoff-named effects modules). But the **production allocators that fire when hits land + drones die in hostile sectors** are NOT named by the CDP profile (which ran on the peaceful `feel-test-25`). They're the natural next localisation target.

## Recommendation for next session

**Order of work:**

1. **Don't push or merge yet.** Phone smoke confirmed; merge to `main` is a separate user-call decision.

2. **Build a hostile-drone CDP allocation-profile spec.** Today's `combat-allocation-profile.spec.ts` runs `feel-test-25` (25 peaceful drones, zero hits land). To localise the 2.5 MB/s rising-edge allocator we need:
   - A test room with hostile drones that return fire (one of the existing `feel-test-*` variants, or a new `combat-allocation-hostile.spec.ts`)
   - 20-30 s of held-fire combat
   - CDP `HeapProfiler.startSampling` over the window
   - Triage the top-25 ranking — candidates to look for first:
     - `handleDamage` / `pendingDamageNumbers` (76 damage numbers in 63 s of light combat)
     - Snapshot decode (3163 snapshot events in 63 s)
     - `sendFire` (ghost spawn + scheduled damage spawns)
     - Effects per-event (hit ImpactSparks ✓ pooled; check effectsService dispatch overhead)
     - Warp transit handlers (27 warp events in this capture; resetPredictionState reallocates several fields)

3. **Failing-test-first as usual** for whatever the profile names; the EngineEmitter / ImpactSparks / DestructionFx pool pattern is the canonical template.

4. **Deferred items still in scope** (from fuzzy-gray handoff):
   - `el.radius` polygon mismatch (handoff §"Two smaller follow-ups")
   - `-0` damage number in `DamageNumbers.ts:68`

**Push-back framing for the user:**

The "RAF stalls" perception is real but minor (8 stutters in 63 s, max 77 ms, all clustered at sector-load or session-end). Pursuing further GC reduction will yield diminishing returns on perceptible stutter count UNLESS we localise the 2.5 MB/s rising-edge allocator. If the user wants to ship and stop polishing here, merging to main + tackling the deferred items is reasonable; the current state is at-or-below the previously-accepted perf-floor baseline.

## How to resume

```powershell
# 1. State check
git checkout integration/four-branches
git log --oneline -7                           # expect 088e8d0 at HEAD, 5 ahead of origin
git status                                     # expect clean

# 2. Re-read today's evidence trail
cat docs/HANDOFF-lazy-mochi-2026-05-29.md
ls diag/measurements/2026-05-29-lazy-mochi/
ls diag/captures/2026-05-29T13-26-14Z-5d0e7d/

# 3. Inner-loop sanity
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test:gc

# 4. If pursuing the 2.5 MB/s rising-edge allocator: read
#    tests/e2e/combat-allocation-profile.spec.ts as the starting
#    template + decide on a hostile-drone room
```

## Open questions

1. Push `integration/four-branches` to origin and merge to `main`? (Phone smoke is accepted; this is a release decision.)
2. Pursue the 2.5 MB/s rising-edge allocator next session, OR move to deferred items (el.radius, -0 damage, then re-baseline phone smoke)?
3. The user previously called the perf-floor-shipped state ("Accurate. The issues now are fine tuning") — by that standard the integration is now ready. Confirm or reject.
