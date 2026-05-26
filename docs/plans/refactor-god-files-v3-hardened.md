# EQX Peri God-File Refactor — Hardened v3 (post-hostile-review)

## Context

The v2 plan (`docs/plans/refactor-god-files.md` on branch `claude/refactor-god-files-plan-Hcoap`) is broadly sound: 11 god files, 6 new DI contracts, ~27 commits, single mega-PR. A hostile review against the working tree found several falsifiable claims and three god files it missed. This v3 keeps the v2's single-mega-PR ambition (per user direction) but plugs the leaks before any further decomposition commits land.

State of the prep branch (16 commits ahead of `main` = `8ab9946`):

- Shipped: docs persistence (1), DI contracts + FIELD_OWNERSHIP.md (1), `messages.ts` split (2ba5d7e), `shipKinds.ts` split (1905407), 1 helper extraction each from `World.ts` (9502ee8), `store.ts` (388e428), `HaloRadar.ts` (5a0ce0a), `WorkerRendererClient.ts` (83d6b87), `diagRouter.ts` (a1bedb1), 2 helper extractions from `PixiRenderer.ts` (f782f29, 467e1f5), 2 helper extractions each from `ColyseusClient.ts` (463b6db, 14b051d) and `SectorRoom.ts` (04f2aa7, d29b5a9), plus a LESSONS ledger entry.
- Deferred per the LESSONS ledger: commits 2, 5 (full World split), 10–14 (full PixiRenderer split), 15–19 (ColyseusClient class split + WreckLifecycleCoordinator), 20–23 (SectorRoom class split), 24 (App.tsx), 25–27 (perf-baseline, CI, docs).
- ColyseusClient: 4237 → 4138 LOC (−99). SectorRoom: 4348 → 4321 LOC (−27). Both still 4000+; the real decomposition is still ahead.
- The prep commits left **wrapper-method debt**: e.g. `mountGeometry.ts` extracted but `SectorRoom.resolveSlotMounts`/`mountWorldOrigin` still exist as thin delegating wrappers (LESSONS ledger admits "wrapper can be deleted in commit 21"). The v3 makes that cleanup explicit, per-extraction.

## Hostile-review findings the v3 fixes

| v2 claim | Reality | v3 fix |
|---|---|---|
| `testTimeScale` is an existing JoinOption usable in E2Es (cited in commits 12, 15, 17 + root CLAUDE.md update) | Not in `SectorRoom.JoinOptionsSchema`. `test-sector-fast` room described in CLAUDE.md but never implemented. | **New commit 1.5** lands `testTimeScale` JoinOption + `test-sector-fast` room before any E2E uses it. |
| "Re-point existing `snapshotCoalesce.test.ts` (200 LOC)" | No file by that name in the repo (grep returns zero). | Pre-flight grep in commit 16; if missing, write the lock as net-new (still cheap) and document the v2 fabrication. |
| Single mega-PR completable in one session | Prep branch already exercised the "two-PR fallback" escape hatch (16/27 commits). | Keep single-PR ambition per user direction, but add **per-stage merge gates** (A/B/C below) so the PR can be force-rebased into stages if review backlog spikes. |
| Plan missed 3 god files over the 400 LOC threshold | `worker/protocol.ts` 496, `worker/Camera.ts` 470, `livingworld/LivingWorldDirector.ts` 416. | All three added to scope; new commits 8b, 8c, 23b. |
| `extendGrace(untilTick)` API described as if it exists | Direct arithmetic `forceBroadcastUntilTick = serverTick + JOIN_BROADCAST_GRACE_TICKS` at 3 write sites in SectorRoom. | v3 explicit: this is a NEW API; commit 22 enumerates all 3 call sites + writes them through `IBroadcastScheduler.extendGrace`. |
| Asteroid carve-out preserved (drones via `resolveDroneDisplayPose`, asteroids via `interpolateSwarmPose`) | Verified at `PixiRenderer.ts:1097-1098` (kind===1 branch) and `HealthBars.ts:70` (asteroid carve-out call). | v3 names `HealthBars.ts:70` as the canonical asteroid-carve-out call site; the `poseConsumption.test.ts` family asserts ONLY drone-rendering paths use `resolveDroneDisplayPose`. |
| `WeaponMountController.tickSlot` described as fictitious | Verified: comment in `WeaponMountController.ts:24` mentions it but no implementation exists. | v3 commit 18 keeps the v2's correct lock (`pickTarget` + `rotateMountToward`) AND deletes the stale documentation comment. |
| File-size enforcement is left to code review | No CI gate prevents re-growth. | New commit 26b: ESLint `max-lines` cap per zone (orchestrator ≤ 500, collaborator ≤ 400) + `scripts/audit-god-files.mjs` (CI-fail when any `src/**` file > 600 LOC without an explicit allowlist entry with rationale). |
| Netgate after every live-loop commit (8 runs × ~12 min ≈ 96 min) | Excessive CI/local cost; redundant when commits are mechanically adjacent. | v3 groups live-loop commits into "netgate epochs" (A, B, C) — netgate runs at the end of each epoch + once at PR head. ~3-4 runs instead of 8. |

## Module structure additions (on top of v2 §"Module structure")

### `src/client/render/worker/protocol.ts` (496 → ~80 barrel + family files) — NEW

`src/client/render/worker/protocol/` — `index.ts` (~80, `AnyWorkerMessage` discriminated union + version constant), `mainToWorkerMessages.ts` (~180, `INIT`, `RESIZE`, `INPUT`, `MOUNT_AIM`, `SET_HULL_EXPOSED`, etc.), `workerToMainMessages.ts` (~140, `READY`, `FRAME_STATS`, `POINTER_EVENT_FORWARDED`, etc.), `protocolValidators.ts` (~100, zod parsers for each variant). Locked by `protocol.test.ts` (which already exists) + new `protocol/roundtrip.test.ts` exercising `structuredClone` across every variant.

### `src/client/render/worker/Camera.ts` (470 → ~120 orchestrator + controllers) — NEW

`src/client/render/worker/camera/` — `Camera.ts` (~120, orchestrator + pan/zoom state), `DragGestureController.ts` (~100), `PinchGestureController.ts` (~120), `WheelZoomController.ts` (~80), `MomentumDecay.ts` (~60), `TapVsDragDiscriminator.ts` (~60). Locked by existing `Camera.test.ts` + new `camera/MomentumDecay.test.ts` (deterministic decay curve) + new `camera/TapVsDragDiscriminator.test.ts` (threshold table).

### `src/server/livingworld/LivingWorldDirector.ts` (416 → ~150 orchestrator) — NEW

`src/server/livingworld/director/` — `LivingWorldDirector.ts` (~150, lifecycle + tick fan-out), `HunterBotPool.ts` (~120, spawn / despawn / pool counts), `HunterBotDistribution.ts` (~100, per-sector distribution policy), `HunterBotWarpController.ts` (~80, warp scheduling). Locked by existing `population.test.ts`, `livingWorldHooks.test.ts`, `livingWorldDirector.test.ts`, `tests/e2e/living-world.spec.ts`.

## New invariant additions

12 v2 invariants stay. v3 adds:

- **Inv #13 (file-size budget).** No file in `src/**` may exceed **600 LOC** without an entry in `scripts/audit-god-files.mjs`'s allowlist with a justification comment. Orchestrators target ≤ 500 LOC; collaborators target ≤ 400 LOC. Lint via `max-lines` per zone (zone glob in `eslint.config.js`). CI-enforced from commit 26b.
- **Inv #14 (wrapper-debt is forbidden).** When an extraction moves a method out of a class, the original method MUST be either (a) deleted in the same commit OR (b) marked `@deprecated` with a TODO referencing the commit that will delete it; the deletion commit MUST land in the same PR. The prep commits' lingering thin wrappers (`SectorRoom.resolveSlotMounts`, `SectorRoom.mountWorldOrigin`) are cleaned up in commit 21.

## Revised commit sequence (29 functional + 2 CI + 1 docs = 32 commits, single PR)

v2 commits 1–27 plus four insertions and one cleanup:

- **Commit 1.5 (new)** — `feat(server): testTimeScale JoinOption + test-sector-fast room`. Adds `testTimeScale: z.number().int().min(1).max(10).optional()` to `SectorRoom.JoinOptionsSchema` (testMode-only, validated against tampering), implements the 10× physics-tick multiplier inside the room's fixed-timestep loop, registers `test-sector-fast` with `filterBy(['testId'])`. Unit test: `tests/unit/testTimeScale.test.ts` asserts `state.clockRate` UNCHANGED (only `world.step` dt is scaled — audio + TiDi UI untouched). Without this commit, every E2E in commits 12, 15, 17 silently uses real-time and either times out or hides the bug it's meant to catch.
- **Commit 8b (new)** — `refactor(client/render/worker): split protocol.ts into protocol/`. See module structure above. Re-points existing `protocol.test.ts` imports.
- **Commit 8c (new)** — `refactor(client/render/worker): split Camera.ts into camera/`. See module structure above. Re-points existing `Camera.test.ts` imports.
- **Commit 21b (new, immediately after 21)** — `refactor(server/rooms): delete mountGeometry + droneKindHelpers wrappers from SectorRoom`. The prep commits (04f2aa7, d29b5a9) left `private resolveSlotMounts`/`private mountWorldOrigin`/`private droneKindIndex` as thin delegating wrappers. Commit 21 introduces `WeaponMountTicker` (new owner); 21b deletes the wrappers and re-points every caller to the new owner. Enforced by `scripts/audit-thin-wrappers.mjs` (greps for `return mountGeometry.X(...)`-shape one-liners in SectorRoom).
- **Commit 23b (new, immediately after 23)** — `refactor(server/livingworld): split LivingWorldDirector.ts into director/`. See module structure above.
- **Commit 26b (new, replaces commit 26's CI-only scope)** — `ci: file-size CI gate + wrapper-debt audit`. Adds `scripts/audit-god-files.mjs` (fail if any `src/**` file > 600 LOC unallowlisted), `scripts/audit-thin-wrappers.mjs`, and `eslint max-lines` per-zone caps. The audit's allowlist starts EMPTY — the PR proves every file fits the budget.

The v2's commits 1–27 keep their numbers; the inserted commits are A.5, B.5, etc., to preserve diff-readability when comparing v3 to v2.

### Netgate epochs (replaces v2's "netgate after every commit 16-23")

Live-loop-touching commits group into three epochs. Netgate (`pnpm e2e:netgate`, ~10-12 min) runs at the end of each epoch:

- **Epoch A** — commits 5 (World.ts physics split), 15 (WreckLifecycleCoordinator), 16 (SnapshotApplier + MirrorUpdater), 17 (PredictionStateManager + collaborators). Net: snapshot decode/interpolate + prediction core. **Netgate ✓ after commit 17.**
- **Epoch B** — commits 18 (LocalMountAimer + InputDispatcher + GhostProjectileManager + CombatFeedbackBridge), 19 (WarpClientOrchestrator + RemotePredictionBridge + ColyseusClientDiagnostics). Net: mount aim + combat feedback + warp client. **Netgate ✓ after commit 19.**
- **Epoch C** — commits 20 (PhysicsWorkerProxy + PlayerSlotMap + SwarmRegistry), 21 (CombatResolver + LagCompRing + WeaponMountTicker), 21b (wrapper cleanup), 22 (BroadcastScheduler + ShieldHullStateTracker + WreckTracker), 23 (AiSectorController + SectorTransitAdapter + LivingWorldBridge + SectorDiagnostics), 23b (LivingWorldDirector split), 24 (App.tsx final wire-up). Net: full server-side + final client. **Netgate ✓ after commit 24.**
- **Final** — netgate at PR head before merge (covers any cumulative drift).

Total netgate runs: **4** (vs v2's implied 8+). Each epoch's last commit cannot push without netgate baseline-relative-green. The deterministic inner loop (`pnpm typecheck && pnpm lint && pnpm test && pnpm bench`) still runs after every commit.

## Per-commit test-coverage matrix additions

Adds to the v2 §"Per-commit test-coverage matrix":

| # | Existing locks | Gap | New test(s) in this commit | Post-commit run |
|---|---|---|---|---|
| 1.5 | n/a | `testTimeScale` JoinOption doesn't exist yet | `tests/unit/testTimeScale.test.ts` (scales physics dt only, leaves `state.clockRate` and broadcast cadence untouched); `tests/integration/sectorRoom/testTimeScaleTampering.test.ts` (asserts non-testMode joins reject `testTimeScale`) | typecheck + lint + test + bench + boot smoke |
| 8b | `protocol.test.ts` | `structuredClone` round-trip not covered per variant | `protocol/roundtrip.test.ts` parameterised over every `AnyWorkerMessage` variant | typecheck + lint + test + bench |
| 8c | `Camera.test.ts` | Momentum decay + tap/drag thresholds embedded in monolith | `camera/MomentumDecay.test.ts` + `camera/TapVsDragDiscriminator.test.ts` | typecheck + lint + test + bench |
| 21b | n/a | Thin wrappers re-grow as zombies | `scripts/audit-thin-wrappers.mjs` + `tests/unit/sectorRoom.noThinWrappers.test.ts` (CI grep) | typecheck + lint + test + bench |
| 23b | `population.test.ts`, `livingWorldHooks.test.ts`, `livingWorldDirector.test.ts`, `tests/e2e/living-world.spec.ts` | Hunter-bot pool lifecycle isolation untested | `director/HunterBotPool.lifecycle.test.ts` + `director/HunterBotDistribution.test.ts` | typecheck + lint + test + integration + bench + boot smoke + **e2e:living-world** |
| 26b | n/a | No file-size gate | `scripts/audit-god-files.mjs` (CI step) + `tests/unit/godFileBudgetGuard.test.ts` (asserts current `src/**` snapshot ≤ 600 LOC, allowlist enumerated with rationales) | full CI run |

## Highest-risk extractions + invariant mapping (v3 additions)

| Risk | Invariant | Existing lock | New lock (v3) |
|---|---|---|---|
| `testTimeScale` tampering / non-testMode bypass | n/a (new) | n/a | `tests/integration/sectorRoom/testTimeScaleTampering.test.ts` |
| File-size re-growth | Inv #13 (new) | n/a | `scripts/audit-god-files.mjs` + `eslint max-lines` per zone |
| Thin-wrapper resurrection | Inv #14 (new) | n/a | `scripts/audit-thin-wrappers.mjs` |
| Worker protocol `structuredClone` round-trip per variant | n/a | `protocol.test.ts` partial | `protocol/roundtrip.test.ts` (parameterised) |
| Worker camera momentum + tap/drag thresholds | n/a | `Camera.test.ts` | `camera/MomentumDecay.test.ts` + `camera/TapVsDragDiscriminator.test.ts` |
| Hunter-bot pool lifecycle | n/a | `population.test.ts`, `livingWorldDirector.test.ts` | `director/HunterBotPool.lifecycle.test.ts` |

## Critical files to read before implementation

- The v2 plan at `docs/plans/refactor-god-files.md` on branch `origin/claude/refactor-god-files-plan-Hcoap` (293 lines; this v3 is a patch on top, not a replacement)
- `src/client/net/colyseus/FIELD_OWNERSHIP.md` on the same branch (shipped by commit f02423f)
- The 16 prep commits' actual diffs (especially the wrapper-debt left by 04f2aa7 + d29b5a9)
- `src/server/rooms/SectorRoom.ts` lines 139–151 (JoinOptionsSchema — where `testTimeScale` lands)
- `src/server/index.ts` (where the `test-sector` room is registered — `test-sector-fast` joins it)
- `src/client/net/ColyseusClient.ts:739-741, 1116-1130, 1869-1903` (snapshot coalesce inline path the v2 plan claims as a module)
- `src/core/ai/WeaponMountController.ts:24` (stale `tickSlot` documentation comment to delete in commit 18)
- `src/client/render/worker/protocol.ts` (entire — 496 LOC, target for commit 8b)
- `src/client/render/worker/Camera.ts` (entire — 470 LOC, target for commit 8c)
- `src/server/livingworld/LivingWorldDirector.ts` (entire — 416 LOC, target for commit 23b)
- Root `CLAUDE.md` "Test-harness philosophy" section (must be updated in commit 27 to remove the `testTimeScale` cite if commit 1.5 doesn't ship — but it does)

## Verification

After every commit (inner loop):
```
pnpm typecheck && pnpm lint && pnpm test && pnpm bench
```
After server-touching commits (1.5, 5, 9, 15, 20–23, 23b):
```
timeout 8 pnpm dev:server   # asserts a clean Colyseus boot
pnpm test:integration -- sectorRoom
```
At end of each netgate epoch (commits 17, 19, 24) AND at PR head:
```
pnpm e2e:netgate   # baseline-relative-green; ~10-12 min wall-clock
```
File-size + wrapper-debt audits (run from commit 26b onward, also on every PR push):
```
node scripts/audit-god-files.mjs
node scripts/audit-thin-wrappers.mjs
```
Final pre-merge sweep:
```
pnpm e2e --project=chromium --reporter=line   # full suite
pnpm e2e:netgate                              # baseline-relative-green
node scripts/audit-mechanical-move.mjs        # confirms pure-move ratio
node scripts/audit-claude-md-anchors.mjs      # no dangling file:line refs
node scripts/audit-mount-angle-writes.mjs     # single mount-angle writer
```

Manual playtest (single-host two-tab; per v2 §"Verification protocol" step 12) PLUS one new check: **open `test-sector-fast` via `?room=test-sector-fast&testTimeScale=10`** and confirm physics ticks 10× while broadcast cadence stays at 20 Hz and TiDi UI stays at real-time (otherwise commit 1.5 is broken in a way unit tests can't catch).

## Token-savings estimate (v3 vs v2)

v2's estimate (12120 LOC orchestrator footprint → ~1440 LOC) holds for the four primary god files. v3 adds:

| File | Before | After | Reduction |
|---|---|---|---|
| `worker/protocol.ts` | 496 | ~80 (barrel) | ~84% |
| `worker/Camera.ts` | 470 | ~120 (orchestrator) | ~74% |
| `livingworld/LivingWorldDirector.ts` | 416 | ~150 (orchestrator) | ~64% |

Cumulative: ~13502 LOC monolith footprint → ~1790 LOC after, ~87% reduction.
