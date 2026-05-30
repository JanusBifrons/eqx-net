# Handoff — `integration/four-branches` (2026-05-28 EOD)

## Branch state

- **Branch**: `integration/four-branches` (local-only, not pushed)
- **Base**: `main` HEAD `f38b9ea`
- **Working tree**: clean
- **Dev servers**: stopped at end of session (free to boot fresh tomorrow)

## What landed today

| Commit | What |
|---|---|
| `2639109` | merge: mobile-perf (Playwright Android + CDP heap budget) |
| `f5d9d8d` | merge: GC discipline + Invariant #14 (plan: quirky-rabbit) |
| `af2b056` | merge: missile-frigate + heat-seeker (adapts to GC pooling) |
| `90096c1` | merge: visual-effects subsystem + T-ship gallery + convex hulls (plan: wiggly-puppy) |
| `b7b18d1` | fix(spawn): filter engineering kinds from galaxy spawn pool + gate ramming probe (capture `ilhqk6`) |
| `9dcde68` | perf(effects): pool EngineEmitter particles + entry records (capture `8y3njt`) |
| `(latest)` | chore(diag): commit smoke captures from EOD session |

All four feature branches merged via plan `i-want-you-to-fuzzy-gray.md` (planning + hostile-review hardening). Two follow-up bug fixes shipped after on-device smoke surfaced regressions the integration didn't catch.

## Smoke timeline (today's captures)

Each row is the on-device session that surfaced the next layer of the onion.

| Capture | Length | Outcome |
|---|---|---|
| `ilhqk6` (pre-fix) | ~91 s | Crossguard / el drones leaked into Sol Prime; ramming probe firing every frame; 3988 combat events; 30 longtasks; recv_gap up to 557 ms; 150 u correction snap |
| `8y3njt` (after fix b7b18d1) | ~40 s + WS disconnect | Engineering kinds gone (✅); ramming probe silent (✅); reconciler steady (ticksAhead 7-16); heap still climbing 2.2 MB/s; 4 raf_gaps clustered before code-1006 disconnect |
| `yvv0z7` (after fix 9dcde68) | ~66 s | Heap growth halved to ~1 MB/s; longtasks 64 → 5; max stall 462 → 397 ms (and that's join-warmup); 12 raf_stutters all <70 ms |

## Where to pick up tomorrow

### The remaining problem

Heap still grows ~1 MB/s during gameplay even after the EngineEmitter pool. Pre-pool was 2.2 MB/s; post-pool is 1.0 MB/s. The visuals branch shipped **four other per-effect modules** with no allocation discipline:

- [src/client/effects/perEffect/LaserGlow.ts](../src/client/effects/perEffect/LaserGlow.ts) — GlowFilter attach/detach state per beam (the user was firing 43 times in `yvv0z7`)
- [src/client/effects/perEffect/ShieldAura.ts](../src/client/effects/perEffect/ShieldAura.ts) — per-ship Container creation
- [src/client/effects/perEffect/ImpactSparks.ts](../src/client/effects/perEffect/ImpactSparks.ts) — only fires on hit (low traffic this session)
- [src/client/effects/perEffect/DestructionFx.ts](../src/client/effects/perEffect/DestructionFx.ts) — only fires on ship destroy

Pattern to apply to each: failing heap-delta test first (the `EngineEmitter.heapDelta.test.ts` is the template), then pool / generation-counter / class-field scratch fix, then commit together. Each is ~30-60 min including tests.

### Priority order (recommended)

1. **LaserGlow heap-delta lock + pool**. Highest impact — fires on every beam frame for both local and remote shooters. The `yvv0z7` capture had 43 fires (1 every 1.5 s). On a more active combat session the rate is much higher.
2. **ShieldAura heap-delta lock + pool**. Triggered by shield-down state — every ship that takes damage. Sustained allocation when multiple ships are in combat.
3. **ImpactSparks + DestructionFx heap-delta locks**. Lower steady-state but still worth covering for the process invariant (M1-M11 all need locks).
4. **`bench:effects` budget gate**. A node-level loop that runs 30 s of simulated gameplay against the effects subsystem and asserts heap delta. Closes the "no spec is long enough to catch 1 MB/s drift" gap.

### Two smaller follow-ups (independent of above)

- **`el.radius` data error**. Polygon points are `[±100, ±100] × scale 10 = ±1000`, bounding circle ~1414, but `radius: 190`. The engineering-only filter prevents this from being seen in galaxy sectors, but `?shipKind=el` direct spawns still render a square that overflows its shield bubble. Fix: bump `radius` to ~1414 (or compute from points). Add a `polygon bounding circle ≤ kind.radius` invariant test for all kinds.
- **`-0` damage number**. [src/client/render/DamageNumbers.ts:68](../src/client/render/DamageNumbers.ts) formats `text: \`-${damage}\``. `damage = 0` renders as `-0`. Gate the spawn at `damage > 0` or change format.

### Process gap — E2E doesn't catch alloc drift

Discussed in conversation; the **honest** summary of why we shipped a 2.2 MB/s leak:

1. Visuals branch (M1-M11) shipped zero heap-delta tests for any effects module. GC discipline (Invariant #14) landed in the same merge wave that included violations of it. **The two should have been coupled.**
2. Integration plan deliberately scoped out `pnpm e2e` + `pnpm e2e:netgate`. Neither was run before main-merge of this branch.
3. Mobile-perf budget tests (`tests/mobile-perf/heap-budget-baseline.spec.ts`) exist but are local-only and weren't run.
4. Most E2E specs are 1-30 s — too short to surface 1 MB/s drift.
5. `TODO: alloc-debt` markers are unenforced strings.

### Suggested process changes

- Any effects-subsystem PR ships a `heapDelta.test.ts` in the same PR (mirror Invariant #9's E2E-with-physics-change rule).
- Add `pnpm bench:effects` — node-level 30 s loop, similar shape to `pnpm bench:gc`.
- CI grep for net-new `TODO: alloc-debt` markers (fail if count grows vs baseline).
- Add a quick desktop-Chromium `e2e:mobile-perf-quick` smoke that runs the baseline heap test (real device stays local).

## How to resume tomorrow

```
# 1. Quick state check
git checkout integration/four-branches
git log --oneline -5
git status                    # expect clean

# 2. Re-read today's captures + this doc
ls -lt diag/captures/ | head -5
cat docs/HANDOFF-integration-2026-05-28.md

# 3. Kick servers
pnpm install --frozen-lockfile
pnpm dev:server > /tmp/dev-server.log 2>&1 &
pnpm dev:client > /tmp/dev-client.log 2>&1 &

# 4. Inner-loop sanity before starting work
pnpm typecheck && pnpm lint && pnpm test -- --run
pnpm test:gc
```

## Open questions for tomorrow's session

1. Tackle the four remaining effects modules in priority order, or build the `bench:effects` budget gate first (catches future regressions, not just current ones)?
2. Is the heap growth threshold for "ship it to main" 0 MB/s, or is some drift acceptable as long as GC pauses stay sub-50 ms?
3. After the effects pool sweep, run `pnpm e2e:netgate` to confirm the integration is netcode-healthy before promoting to main?
4. Pin the `el.radius` fix and the `-0` damage fix into this round or defer further?

## Reference

- **Plan file**: `C:\Users\alecv\.claude\plans\i-want-you-to-fuzzy-gray.md` (integration plan with hostile-review hardening)
- **Smoke captures**: `diag/captures/2026-05-28T20-14-49Z-ilhqk6/`, `2026-05-28T20-45-45Z-8y3njt/`, `2026-05-28T21-04-45Z-yvv0z7/`
- **Template for heap-delta locks**: `src/client/effects/perEffect/EngineEmitter.heapDelta.test.ts`
- **Pre-existing test failures on main** (do not fix in this branch): `TickBudgetTelemetry.test.ts` (6 — `startTick()` vs `beginTick()` API mismatch); `spiral-ondevice-replay.test.ts` (2 — host-load sensitive).
