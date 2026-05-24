# HANDOFF — mobile-perf investigation (2026-05-24)

> **Status (2026-05-24 EOD):** primary spiral broken (Probes 6+7+8 shipped). Solo gameplay is smooth. Secondary residual spiral identified in 2-player heavy combat — known mechanism, NOT yet fixed. This doc hands off the full investigation for tomorrow's session.

---

## TL;DR — current state of mobile playability

| Scenario | Pre-investigation | Now |
|---|---|---|
| Solo galaxy + light combat | Unplayable, progressive degradation | **Smooth**; spiral broken; ticksAhead+RTT self-correct |
| Solo test-sector | Unplayable (per user) | **Zero issues** |
| 2-player heavy combat | (untested) | **Spirals back** but milder; recovers; secondary allocation surfaces |
| Display rate | 45fps (cap throttle bug) | **90fps native** (Pixel 6 panel rate) |

**Headline numbers from capture comparisons** (Pixel 6, Chrome 148, Android 16, same network):

| Capture | Mode | raf_gap | RTT trajectory | ticksAhead trajectory |
|---|---|---|---|---|
| `y0eo1h` | pre-fixes, galaxy + combat | 113 in 184s | 95 → 816 ms | 7 → 50 |
| `o3dx44` | Probe 6+7 | ~6 | 65 → 215 ms | 4 → 12 |
| `sv9g6p` | Probe 6+7+8, solo | **0 in 116s** | 55 → 69 (recovers) | 4 → 4 (recovers) |
| `51rvm7` | Probe 6+7+8, 2-player combat | 42 in 199s | 58 → 381 ms | 4 → 22 |

The user reports the felt experience matches: smooth solo, lag returns in 2-player heavy combat.

---

## Working style notes (for whoever picks this up)

The user explicitly directed earlier in this investigation:

1. **Be hostile to existing assumptions.** CLAUDE.md, LESSONS.md, and prior commit messages are NOT ground truth — they're prior teams' best guesses, some of which the captures falsified. Question everything; cite the data.
2. **Evidence-driven, not theory-driven.** Every claim needs a capture line or code citation. "It might be X" is not actionable; "capture Y line Z shows X" is.
3. **No premature conclusions.** I burned multiple cycles by jumping to conclusions before the data was complete. The user called this out explicitly. Wait for the data.
4. **Use the local test infrastructure.** `tests/replay/` drives the real `ColyseusGameClient` through captured event streams. We have unit tests that read captured data directly and assert against the user's actual device numbers (e.g., `tests/unit/frameRateCap.realCapture.test.ts`). **Don't ask for a smoke test when a local test can answer the question.**
5. **The user has limited smoke-test bandwidth.** Each on-device test is precious. Don't burn them on speculative probes — build instrumentation that answers multiple questions at once.

---

## The complete fix stack (shipped to branch `claude/mobile-perf-reconciliation-review-IYrfI`)

All probes are merged into `feat/perf-floor` by the user; the user's testing workflow builds from there. The full chain in commit order on this branch:

### Commits

| SHA | What | Why |
|---|---|---|
| `857c62d` | docs(perf): mobile-perf-investigation Phase 1 diagnosis | Initial (now-superseded) diagnosis |
| `baf9ba3` | docs(perf): hostile review of the diagnosis | Lock the falsifications of prior claims |
| `cee34e4` | merge feat/perf-floor | Bring on-device perf instrumentation under this branch |
| `74d2847` | Probe 0 — heap@10Hz + binary-swarm timing + ?profile=1 | First instrumentation pass |
| `eb506a5` | Probe 0 capture analysis (pre-Probe-0 build, wasn't on user's branch yet) | |
| `f56011d` | Probe 0 results — 45 Hz refresh is the dominant cause (mg5rpe) | **THE PRIMARY DIAGNOSIS** |
| `e9057d5` | test(perf): cap=10 unlocks 90Hz on user's device — deterministic local proof | Locks the math against the user's measured refresh rate |
| `62ee458` | **fix(perf): lower frame-rate cap 15→10ms** | **THE CAP FIX** — unlocked 90Hz native, fixed solo smoothness |
| `edbd67c` | test(perf): characterisation lock — console.profile() teardown causes raf_gap burst | Identified the Probe 0 ?profile=1 self-induced stall |
| `4449ce6` | feat(perf): Probe 4 — three concurrent mobile-perf fixes + tests | Roster dedupe + damage event reshape + raf_stutter |
| `a158dec` | feat(diag): Probe 2 — device fingerprint + native rAF cadence calibration | Per-session device info |
| `652dffd` | feat(diag): Probe 3 — `?fpscap=N` runtime override of the 60Hz cap | A/B test toggle |
| `0bcb5f5` | feat(diag): Probe 1 — per-RAF work breakdown | Confirmed JS work ≠ 16ms |
| `f631a08` | feat(diag): Probe 5 — reconcile breakdown + recv_gap_long + ?diag=light | Locked spiral mechanism |
| `9d0c645` | **feat(net): Probe 6 — snapshot coalescing breaks the GC-driven RTT spiral** | **SPIRAL FEEDBACK BREAK** |
| `7eb859b` | **perf(client): Probe 7 — pool mirror.ships entries** | **10× allocation rate reduction** |
| `6bbfa4f` | **perf(client): Probe 8 — pool remaining mirror entries + skip snap-spread** | Residual allocation reduction |

The four **load-bearing** fixes (bold above):
- **62ee458** — cap=10 frame-rate cap. Fixed the 45Hz throttle on 90Hz devices.
- **9d0c645** — Probe 6 snapshot coalescing. Breaks the post-GC burst-RTT feedback loop.
- **7eb859b** — Probe 7 ship-entry pooling. Cut allocation rate from 1-2 MB/sec to ~0.1 MB/sec.
- **6bbfa4f** — Probe 8 wreck/projectile/lingering pooling + snap spread elimination. Further reduced.

### Diagnostic instrumentation shipped (Probes 0-5, all default-off / cheap)

Lives in `src/client/net/ColyseusClient.ts`, `src/client/debug/ClientLogger.ts`, `src/client/debug/deviceInfo.ts`, `src/client/App.tsx`. URL params:
- `?diag=1` — full diagnostic stream (existing)
- `?diag=light` — drops rafTick/local_pose_*/input_intent (Probe 5). ~60% capture-size reduction.
- `?autocapture=1` — streaming capture (existing, pre-investigation)
- `?profile=1` — Chrome `console.profile()` 60s window. **Known to cause its own raf_gap burst at teardown** — see `tests/unit/profileTeardownStall.test.ts` for the lock. Use sparingly.
- `?fpscap=N` — Probe 3 override of the cap (default is 10). `?fpscap=0` removes cap entirely. `?fpscap=15` reverts to the pre-fix throttle for A/B.
- `?coalesce=0` — Probe 6 disable. Default ON (coalescing active).
- `?worker=0/1` — pre-existing, force/disable OffscreenCanvas worker (default off on touch).

New events the captures now carry:
- `device_info`, `device_info_calibration`, `device_battery` (Probe 2) — session metadata
- `rafWork` (Probe 1) — per-RAF physics/mirror/render breakdown (only with `?diag=1`, not `?diag=light`)
- `heap_sample` (Probe 0, enhanced) — every ~100ms with swarmDecode rolling stats
- `recv_gap_long` (Probe 5) — >200ms WebSocket gaps with heap context
- `raf_stutter` (Probe 4) — 30-100ms gaps (below raf_gap threshold)
- `snapshot_applied` (Probe 5 enhanced) — now includes `reconcileMs` + `replayWindow`
- `snapshot_coalesced` (Probe 6) — fires when N snapshots were collapsed at next RAF
- `damage_number_scheduled` / `damage_number_spawned` / `damage_number_cancelled` (Probe 4) — replaces the 5-at-same-ts `damage_number_predicted` shape
- `fps_cap_override` (Probe 3) — fires once at startup if `?fpscap=N` is set
- `profile_started` / `profile_ended` (Probe 0)

---

## The story compressed (timeline of what was tried + falsified)

**The user's symptom:** "progressively unplayable" on mobile. Same local WiFi every time. Cycled through fix attempts that all "passed tests but broke on-device" (the project had a documented pattern of this).

**False starts (saved here so they're not retried):**
1. **OffscreenCanvas worker theory** — earlier work concluded worker IPC caused 110ms stalls (commit `45400f3` on perf-floor). The hostile review of capture data found this was **probably misattributed**; the 110ms cluster was actually the cap-induced 7-frame stalls, not IPC. Worker is still disabled on touch by default but the rationale shifted.
2. **"Spiral is in reconciler-replay growth"** — falsified by sub-second probes; the SPIRAL trigger was below-JS, the reconcile growth was downstream.
3. **"It's GPU sync / compositor"** — falsified by Probe 1 measuring per-RAF work at 1ms median (massive headroom).
4. **"It's OS/thermal/device-imposed 45Hz"** — falsified by Probe 2's `device_info_calibration` measuring true 90Hz native.
5. **"Living World is the cause"** — partially true (heavier in galaxy) but the actual mechanism was the cap throttle + GC pacing, not Living World per se.

**The actual root causes (in causal order):**
1. **`DEFAULT_MIN_FRAME_INTERVAL_MS = 15`** in `src/client/perf/frameRateCap.ts` was throttling 90Hz devices to 45fps every-other-RAF by design. This was the dominant felt-bad. Fixed by `62ee458`.
2. **GC-driven RTT spiral**: GC pauses queue WebSocket snapshots; the post-burst processing fires multiple `onMessage` callbacks each measuring `now - inputSentAt`, inflating Welford RTT, which drives ticksAhead up, which grows reconcile cost, which makes the main thread busier, which makes GC more frequent. Fixed by Probe 6 coalescing (breaks feedback loop) + Probe 7+8 pooling (reduces GC frequency).

---

## Key captures (all on `origin/feat/perf-floor`, under `diag/captures/`)

The full historical chain is preserved. Most relevant:

| Capture | Date / Time | Purpose | Key finding |
|---|---|---|---|
| `y0eo1h` | 2026-05-24 16:25Z | The unplayable baseline (galaxy + combat, full diag) | RTT 95→816, ticksAhead 7→50, 113 raf_gaps |
| `mg5rpe` | 2026-05-24 13:56Z | Probe 0 with `?worker=0` only | 22ms cadence proved cap was throttling 90Hz native to 45Hz |
| `4qm14l` | 2026-05-24 15:17Z | Probe 2 device calibration | `device_info_calibration.medianIntervalMs: 11.1, effectiveHz: 90.1` — definitive proof of 90Hz panel |
| `dmh5wn` | 2026-05-24 15:35Z | Probe 0 with `?profile=1` | Found console.profile() teardown stalls; led to locking those out |
| `bb3al3` | 2026-05-24 16:52Z | test-sector, `?fpscap=10`, no combat, no Living World | **Zero issues** — proved primary spiral was galaxy-induced |
| `2kn41x` | 2026-05-24 17:02Z | Galaxy, no firing | **THE PIVOTAL CAPTURE** — proved GC-driven spiral mechanism; heap climbed 41→81 MB, dropped 35MB in GC, recv_gap_long fired |
| `o3dx44` | 2026-05-24 17:22Z | Probe 6+7 first smoke | Massive improvement, allocation 10× reduction |
| `sv9g6p` | 2026-05-24 17:42Z | Probe 6+7+8 first smoke (solo) | **Spiral broken** — zero raf_gaps, ticksAhead+RTT recovered |
| `51rvm7` | 2026-05-24 17:52Z | Probe 6+7+8, 2-player heavy combat | **Secondary spiral** — milder, recovers, ~5MB/sec allocation rate during peaks |

To analyze any capture: `git show origin/feat/perf-floor:diag/captures/<id>/<channel>.ndjson`

Channels per capture: `raf.ndjson`, `perf.ndjson`, `snapshots.ndjson`, `combat.ndjson`, `lifecycle.ndjson`, `other.ndjson`, `corrections.ndjson` (sometimes `population.ndjson`, `summary.json`).

---

## Tests that lock the findings

All in `src/client/` or `tests/unit/`:

| Test file | Locks |
|---|---|
| `tests/unit/frameRateCap.test.ts` | Cap math at default 10ms — 60/90/120Hz cadences |
| `tests/unit/frameRateCap.realCapture.test.ts` | Cap behaviour against user's actual measured Pixel 6 rate (loads `4qm14l`) |
| `tests/unit/profileTeardownStall.test.ts` | The `?profile=1` teardown burst pattern (loads `dmh5wn`) |
| `src/client/net/rafStutter.test.ts` | raf_stutter event band (30-100ms) |
| `src/client/net/damageNumberEvents.test.ts` | Probe 4 damage event shapes |
| `src/client/net/snapshotCoalesce.test.ts` | Probe 6 coalescing behaviour (8 tests, jsdom env) |
| `src/client/net/mirrorEntryPooling.test.ts` | Probe 7 ship pooling invariants (6 tests) |
| `src/client/net/probe8Pooling.test.ts` | Probe 8 wreck/projectile/lingering pooling (10 tests) |
| `src/client/components/rosterPoller.test.ts` | Probe 4 roster polling dedupe (12 tests, jsdom env) |
| `src/client/debug/ClientLogger.diagLight.test.ts` | Probe 5 `?diag=light` mode (8 tests, jsdom env) |
| `tests/e2e/mobile-perf-probe4.spec.ts` | Probe 4 E2E (in `feature` project, not run locally — sandbox blocks chromium download) |

Suite status: **1300/1302 unit tests pass** (2 pre-existing failures in `tests/scenarios/spiral-ondevice-replay.test.ts` — legacy non-real-client harness, unrelated to this investigation, documented in `docs/LESSONS.md` 2026-05-21).

---

## Open issues / known residuals

### 1. Secondary spiral in 2-player heavy combat — NOT FIXED

Capture `51rvm7` shows it. Analysis:

- Per-tick reconcile cost is unchanged (~0.03 ms/tick) — Probe 7+8 work was correct
- **Heap allocation rate during heavy combat peaks at ~5 MB/sec** (vs ~0.1 MB/sec solo no-combat)
- 50× increase in allocation rate scales with combat intensity + player count
- Causes more frequent GC pauses → more frequent snapshot bursts
- Probe 6 fires 92 times (vs 10 in `sv9g6p`) — actively absorbing bursts but not enough
- ticksAhead climbs to ~22-24 and recovers (vs runaway to 50+ pre-fix)

**Suspect allocation sources** (need probe to confirm which dominates):
- Ghost projectile creation per fire (263 fires in `51rvm7`)
- `pendingDamageNumbers.push({x,y,damage,tag})` — small object per damage instance
- `pendingHealthBarHits.push(...)` — same pattern
- Remote player input handling in `applyRemoteInputs` (called per remote per replay tick)
- React/Zustand re-renders from HUD updates (`hullPct`, `shieldPct`, `ammo`) firing per hit
- `_remoteShipOffsets` Map entries, `remoteHistory` Array pushes

### 2. Damage inconsistency (flagged by user as separate from lag)

User noted: "still unrelated issues with damage but the feel is getting there"

Probe 4's instrumentation now in captures. To diagnose:
- Pull `damage_number_scheduled` count from `combat.ndjson`
- Pull `damage_number_spawned` count
- Pull `damage_number_cancelled.cancelledScheduled` sum
- Expected: spawned + cancelled ≈ scheduled × 5 (since SMOOTH_BEAM_SPLITS=5)
- If spawned + cancelled << scheduled × 5 → spawns getting silently dropped

Not yet investigated. Could be next session.

### 3. Heap cycling 34-80+ MB still happens

Probe 7+8 reduced FREQUENCY but didn't eliminate. Each major GC is still a 200-500ms pause. They're just rarer.

To investigate further, Probe 9 candidates listed below.

---

## Recommended next steps (menu, in rough priority order)

### Option A: Probe 9a — pool damage event pipeline (low risk, ~1hr)
- Pool `pendingDamageNumbers` array entries (push pre-allocated `{x,y,damage,tag}` objects from a free-list instead of literal allocation)
- Same for `pendingHealthBarHits`
- Expected impact: cuts per-hit allocation cost. With 2 players exchanging damage at high rate, this could halve heap allocation rate during combat.
- Pattern: identical to Probe 7+8 — locked by mirror entry pooling tests as the precedent

### Option B: Audit Zustand subscribers for combat re-render storm (medium risk, ~2hr)
- Find every `useUIStore(s => s.hullPct)` / `s.shieldPct` / `s.ammo` subscriber
- Measure React render frequency during 2-player combat
- Throttle HUD updates to 10Hz via Zustand selector subscription
- Risk: changes React render behaviour, could affect HUD smoothness

### Option C: Investigate damage inconsistency separately
- Read Probe 4 events from `51rvm7` or new capture
- Find the scheduled/spawned/cancelled imbalance
- Pure investigation, no code changes initially

### Option D: Accept current state, document it as a milestone
- Update `docs/architecture/mobile-perf-investigation.md` with the full story
- Close the milestone; treat 2-player heavy combat as a known-bounded residual
- Move on to other work

### Option E (NOT recommended): Architectural pivots
- The earlier investigation had reverted to questioning the snapshot-interpolation pivot for drones, going to a hybrid lockstep approach, etc.
- The user's data shows none of those are needed — the spiral is fixed at the JS/allocation level. Don't reopen unless evidence forces it.

---

## Where to start tomorrow

1. **Read this doc end-to-end first.** The journey context matters.
2. **Read `tests/replay/NOTES.md`** to understand the local replay infrastructure.
3. **Read `src/client/CLAUDE.md`** but be aware it documents historical decisions, some of which the captures revised. Specifically: the "Internal work-loop cap" entry now reflects the post-fix value (10ms); the rest is unchanged.
4. Pick an option from the menu above (or get the user's direction).
5. **Before any new on-device test:** check if a local test can answer the question first. The `tests/replay/` and `tests/unit/*RealCapture*` patterns work — use them.

If picking option A (Probe 9a), the exact pattern to follow is already in `src/client/net/ColyseusClient.ts` Probe 7+8 sites (search for "Probe 7" or "Probe 8" comments). Mirror entries are pooled; just extend to damage event entries.

If picking option B (Zustand audit), start at `src/client/state/store.ts` and grep for `hullPct`/`shieldPct` subscribers across `src/client/components/` and `src/client/layout/`.

---

## Communication with the user

The user has invested ~100 hours and was at existential-risk frustration earlier in this investigation. The investigation moved their assessment from "this just feels insurmountable" to "the primary spiral is fixed, that's a huge win regardless." Treat them accordingly:

- Be brief. Long responses got pushback.
- Show numbers, not narrative.
- Don't over-claim. The primary spiral is broken; the secondary is bounded but real. Don't say "fixed" when "improved" is accurate.
- Don't ask for smoke tests speculatively. They have limited bandwidth for on-device testing.
- If a finding rules out a previously-shipped hypothesis, say so directly. The user values evidence > consistency-with-prior-claims.

---

## Inventory of artefacts created in this investigation

Test files: see "Tests" table above (11 files).

Doc files:
- `docs/architecture/mobile-perf-investigation.md` — earliest diagnosis (now historical)
- `docs/architecture/mobile-perf-investigation-review.md` — hostile review of the diagnosis
- `docs/HANDOFF-mobile-perf-2026-05-24.md` — this file (the canonical handoff)

Capture artefacts (in `origin/feat/perf-floor:diag/captures/`):
- ~30 captures from 2026-05-22 through 2026-05-24
- See "Key captures" table above for the relevant subset
