# Token waste, god-files and parallel systems — review and hand-off plan

**Conducted:** 2026-11-14 · **Code reviewed at:** `origin/main` `e1311d79` (PR #576) ·
**Usage data:** 344 Claude Code session transcripts, 2026-11-08 to 2026-11-14, one machine.

**Goal.** Remove the biggest token leaks, not optimise everything. Rank where to work, and give
hand-off plans for the top areas that a cheaper agent can execute one slice at a time.

**This document changes nothing.** No code, `CLAUDE.md`, memory or settings file was edited.

## 1. Headline

1. **The instruction files are the largest leak.** The four `CLAUDE.md` files (561 KB) were
   auto-injected 599 times in a week: 64.9 M characters, more than twice all code reading combined.
2. **Long main sessions are the largest multiplier.** Main sessions averaged 452k tokens of context
   per model call; three sessions account for 1.27 B of the 2.13 B main-session tokens.
3. **God-files are a design problem more than a token problem.** `SectorRoom.ts` is the most-read
   source file (1.98 M characters in the week: 1.84 M through the shell, 0.14 M through the Read
   tool), but that is 3% of what `CLAUDE.md` injection costs. It still ranks, because it has more
   than tripled since the May refactor and nothing stops it growing.
4. **Ship definitions are single-source; ship *runtime* is not.** A ship flown by a player and the
   same ship flown by an AI pilot are different entities end to end. Hostility has six answers.

## 2. Method and places reviewed

| Pass | What | How |
|---|---|---|
| Usage | `~/.claude/projects/C--Users-alecv-Documents-Projects-eqx-net/**/*.jsonl` (16 main + 328 subagent transcripts) | Node script: per-call `usage`, tool-result sizes, `nested_memory` attachments, shell commands classified by first verb |
| Source sizes | `src/**`, `scripts/`, `tests/`, `showcase/`, `perf/`, `benchmarks/`, `diag/` | `git ls-files` + `wc`; `node scripts/audit-god-files.mjs --report`; method spans by regex |
| Instruction files | root + `src/{server,client,core}/CLAUDE.md`, `plans/CLAUDE.md`, `.claude/skills/*`, repo and user `settings*.json`, both memory dirs | byte count per `##` section, date / PR-number counts, 10 path spot-checks |
| Docs | `docs/**`, `plans/**`, `MANIFEST_*.md` | sizes, naming conventions, prior refactor plans and lessons |
| Parallel systems | ships, AI, ownership/hostility, weapons, damage, spawn, spatial, input, stores, worker protocol, RNG/angle helpers, effects, test helpers, launchers, process docs | `git grep` call-site counts, then the competing implementations read |
| External research | Claude Code token guidance; agent-friendly file size; SOLID critiques | web search, practitioner sources (section 9) |

**Checked by a hostile reviewer.** A fresh agent verified the paths, line numbers and claims in
sections 5–9 against the code; its 14 corrections are applied. It could not check section 3.

**Not reviewed:** `tests/**` content (sizes only), `showcase/` internals, CI run times, the 215
worktree folders, the 31 handoff docs' content, runtime performance. Method counts and method
lengths are regex-derived and approximate. Token estimates from characters assume 2.5–4 chars/token.

**Prior work this builds on (do not redo):** `docs/plans/refactor-god-files.md`,
`docs/plans/refactor-god-files-v3-hardened.md`, `docs/LESSONS.md` entries at lines 590, 643, 692
and 2373, `docs/reviews/2026-07-antipatterns-review.md`, `docs/architecture/sector-room-anatomy.md`.

## 3. Measured token usage

| Measure | Main sessions (16) | Subagents (328) |
|---|---|---|
| Model calls | 4,705 | 19,360 |
| Input tokens processed | 2,126 M | 4,103 M |
| …re-read from cache | 2,114 M | 4,019 M |
| …newly written to cache | 11.7 M | 83.1 M |
| Output tokens | 3.3 M | 12.6 M |
| Average context per call | 452k | 212k |
| Median context at start / peak | 54k / 576k | 38k / 214k |

99.7% of tokens are input, almost all of it the accumulated context re-read on each call. Two
things set the bill: how big the context gets, and how many calls carry it. Cached re-reads are
billed at a fraction of fresh input, so share of tokens is not share of cost.

**New content entering contexts, by source:**

| Source | Characters | Count |
|---|---|---|
| `CLAUDE.md` auto-injection | 64.9 M | 599 loads |
| Shell `grep` / `rg` output | 14.1 M | 6,467 calls |
| Shell `cat` / `sed` / `head` / `tail` output | 10.3 M | 2,421 calls |
| Other shell output (tests, git, video, `gh`) | 12.5 M | 9,584 calls |
| Read tool | 4.6 M | 3,079 calls |

**Injection by file:** root 234 loads (19.8 M chars), client 117 (17.7 M), server 104 (15.8 M),
core 115 (8.4 M).

**Effect on subagents:** 225 subagents (about two-thirds) had `CLAUDE.md` injected, median 242k characters each.
Their median peak context was 264k tokens; the rest peaked at a median of 101k. For 170 of the
225, instruction files were 25–50% of peak context (at 3 chars/token).

**Main sessions:** the three largest ran 1,011, 827 and 677 calls and processed 495 M, 423 M and
349 M tokens (1.27 B of the 2.13 B main-session total). Each averaged about 500k tokens per call,
peaked near 960k and compacted twice.

**Most-read files through the shell (characters, commands):** `SectorRoom.ts` 1.84 M / 1,037;
root `CLAUDE.md` 1.41 M / 247; `ColyseusClient.ts` 1.01 M / 479; `HostileDroneBehaviour.ts`
0.95 M / 411; `PixiRenderer.ts` 0.60 M / 321; client `CLAUDE.md` 0.51 M; server `CLAUDE.md` 0.39 M;
core `CLAUDE.md` 0.33 M. Agents re-grep 2.6 M characters of instruction files that were already
injected, which suggests the files are too long to use from context.

**Large outputs:** 269 shell outputs of 15–30k characters (1.5% of calls) carried 5.5 M characters.

**Stale root file:** every one of the 234 root injections came from the main checkout's
`eqx-net/eqx-net/CLAUDE.md`, which was 201 commits behind `origin/main` on the review date. The
worktree's own root copy never appears as an injection. Cause not established.

## 4. Ranked focus list

| # | Area | Evidence | Rough weekly saving | Effort | Risk |
|---|---|---|---|---|---|
| 1 | `CLAUDE.md` diet (section 5) | 561 KB; 64.9 M chars injected | ~0.4–0.6 B tokens re-read | M (docs only) | Low: rules move, none deleted |
| 2 | Session length and hand-off habits (section 6) | 452k average context; 3 sessions = 1.27 B | ~0.9 B if average halves | XS (working rule) | Low |
| 3 | Shell-read habits and guardrails (section 7) | 24.4 M chars of grep/cat; size gate not in CI | Small directly; stops regrowth | S | Low |
| 4 | `SectorRoom.ts`, then `ColyseusClient.ts` (section 8) | 11,596 and 7,025 lines; 6 methods hold about 6,470 lines | ~3 M chars of reads | L, sliced | Medium: live loop |
| 5 | Parallel-system quick wins (section 9.1) | 6 inline spawn sites, three mass fallbacks, old impulse path, protocol declared twice | Small; removes bugs | S each | Low–medium |
| 6 | One hostility answer, one meaning of "faction" (9.2) | 6 mechanisms | Confusion, not tokens | M/L | Medium |
| 7 | `docs/LESSONS.md` (407 KB) index or split | Referenced ~10× from `CLAUDE.md`; 158 shell reads | Small | S | None |
| 8 | `PixiRenderer.ts` `update` split | 3,509 lines | Small | M | Medium: visual |
| 9 | Wide-import type files: `IRenderer.ts` (133 importers), `structureKinds.ts` (105) | 1,150 / 1,447 lines | Small | S | Low |
| 10 | Process tidy: memories, settings, handoffs, plans, test helpers, launchers (section 10) | 5 duplicate memories, 31 handoffs, 3 plan locations | Small | S | None |
| 11 | One ship entity for player- and AI-flown ships (9.3) | Two stores, bodies, wire formats, draw paths | Structural | L | High: roadmap item |
| 12 | Classic vs new effects; 4 spatial grids; `server/index.ts` test rooms | ~1.4k lines removable later | Small | M–L | Visual / perf |

Savings for #1 and #2 are estimates from section 3 and assume the same number of calls. #1: 225
subagents × a median 47 calls × roughly 55k fewer tokens of instruction text per call, discounted
because the files load part-way through a run. #2: 4,705 calls × (452k − 250k).

## 5. Hand-off plan A — `CLAUDE.md` diet (rank 1)

**Problem.** Most of the 561 KB is history and subsystem description, not rules.

| File | Bytes now | Target | Largest sections (bytes) |
|---|---|---|---|
| `CLAUDE.md` | 91,866 | ≤ 15,000 | Test-harness philosophy 23,668 · Invariants 21,034 · Netgate 7,411 · Showcase 5,936 · Running E2E 5,728 · Pushing & PRs 5,428 |
| `src/server/CLAUDE.md` | 201,943 | ≤ 25,000 | Thresholds 107,903 (51 dates, 25 lines over 1,500 chars) · Generic Entity Pipeline 14,861 · Combat Architecture 9,898 · Fire control 9,068 |
| `src/client/CLAUDE.md` | 188,725 | ≤ 25,000 | Renderer Rules 35,038 · Layout Slot System 26,145 · Client Prediction 19,494 · Machined art 13,513 · UI Scope 13,331 · Worker boundary 11,723 · Effects 11,048 |
| `src/core/CLAUDE.md` | 78,225 | ≤ 15,000 | What belongs in src/core 19,302 · AI lockstep 8,141 · Capital fracture 7,407 · Physics Rules 6,619 · Worker message variants 6,081 |

**Sorting rule for every paragraph** (apply in this order):

1. **History** — "was", "retired", "superseded", "reverted", version-bump trails, dated incident
   stories, plan codenames, PR numbers. Move to a "History" section at the end of the matching
   guide. (`docs/LESSONS.md` is chronological and append-only, so it is not the destination.)
2. **How a subsystem works** — description rather than instruction. Move to the matching guide in
   `docs/architecture/` (invariant #10 already puts guides there). Leave a one-line pointer.
3. **Procedure for one narrow task** — netgate, showcase, perf scenes, running E2E, `gh`
   troubleshooting. Move to the existing skill (`.claude/skills/netgate`, `e2e-triage`) or a guide;
   leave a one-line pointer naming when to read it.
4. **A rule that applies to any task in the zone** — keep. Rewrite to three lines at most, present
   tense, no dates, no PR numbers.

`@` imports do not save tokens (imported files load at start), so do not use them for this.

**Slices** (one PR each; docs only unless the slice adds a guide, see below):

| Slice | Change | Destination | Saves |
|---|---|---|---|
| A0 | Amend invariant #7 and the "when in doubt, prefer CLAUDE.md" routing rule: rules go in `CLAUDE.md`; thresholds, lessons and subsystem description go in `docs/` with a one-line pointer | root `CLAUDE.md` | stops regrowth |
| A1 | Server "Thresholds": keep a table of current values only. A value is current if the constant it names still exists in `src/` (`git grep`); entries marked retired, reverted or superseded are history | `docs/architecture/server-thresholds.md` (new guide) | ~100 KB |
| A2 | Root "Test-harness philosophy" and the primitives table | `docs/architecture/e2e-framework.md` (exists) | ~22 KB |
| A3 | Root netgate, showcase, perf scenes, running E2E, `gh` sections | `.claude/skills/netgate/SKILL.md` and existing guides | ~25 KB |
| A4 | Client: Renderer Rules, Layout Slot System, Client Prediction (one slice per section) | matching `docs/architecture/` guides | ~70 KB |
| A5 | Client: Machined art, UI Scope, Worker boundary, Effects (one slice per section) | matching guides | ~45 KB |
| A6 | Server: Generic Entity Pipeline, Combat Architecture, Fire control | matching guides | ~30 KB |
| A7 | Core: What belongs in src/core, AI lockstep, Capital fracture, Physics | matching guides | ~40 KB |
| A8 | Root invariants: strip wire-version history from #11 and #12; move #13's practical-workflow bullets out; keep every rule | the guides each invariant already links | ~12 KB |
| A9 | Fix stale references and the port contradiction (below) | in place | correctness |
| A10 | Extend `scripts/audit-god-files.mjs` with a byte budget for the four files; run in CI | same script, not a new one | stops regrowth |
| A11 | Second pass: the ~30 smaller sections left in each file, same sorting rule, one PR per file | matching guides | ~135 KB |

A0 and A8 change the wording of standing owner rules. Give them to a stronger model and read the
diff. Without A0 the files regrow: invariant #7 sends every new threshold and lesson back in.

**New guides trip a unit test.** `tests/unit/showcaseCoverage.test.ts` fails for any page under
`docs/architecture/` or `docs/features/` that has no shot and no `SHOWCASE_EXEMPT` / `SHOWCASE_PENDING`
entry in `showcase/registry.ts`. Markdown-only PRs skip unit tests in CI, so a new guide merges
green and breaks the next code PR. Any slice that creates a guide must add the registry entry in
the same PR and run `pnpm test -t showcase`. Prefer an existing guide where one fits.

**Stale references for A9** (all in root unless marked): `src/server/rooms/scene/perfScenes.ts`
(now `src/shared-types/perf/perfScenes.ts`); `tests/e2e/combat-allocation-profile-hostile.spec.ts`
(now under `tests/perf/`); `tests/e2e/drawer-galaxy-map-open-close.spec.ts` (gone);
`tests/integration/sectorRoom/lingerDespawnReturnsToPool.test.ts` (gone); `diag/adb-shots/_create-*.mjs`
(gone); a pointer to a "Committing changes with git" section that does not exist; server file:
`rooms/PhysicsBridge.ts`, `PlayerSessionManager.ts`, `SwarmLifecycleManager.ts` (gone); core file:
`prediction/droneRelevance.ts` (gone). **Port contradiction:** the worktree-and-ports section says
another session's server is never yours to kill; "Stale dev servers" says anything on 2567/5173 is
safe to kill. The first is the newer rule; rewrite the second to match.

**Per-slice steps.**
1. Work in a new worktree from fresh `origin/main`.
2. Read only the section being moved (use the line range from `grep -n '^## '`) and the destination.
3. Move the text; write the kept rules; add the pointer line.
4. Check nothing was lost. For every line deleted from `CLAUDE.md` (`git diff -U0 | grep '^-'`),
   `grep -F` its first 60 characters in the destination file. List in the PR body each deleted
   line that is not found there, with the kept rule that replaces it.
5. Check line endings against `origin/main` for each touched file (CR count must not change).
6. PR; auto-merge.

**Done when.** Stage 1 (A0–A10): the four files total about 220 KB, down from 561 KB, and the
budget check is in CI. Stage 2 (A11): ≤ 80 KB, the per-file targets above. At both stages every
rule still exists somewhere findable from a pointer.

**Also needed, outside the repo files:** keep the main checkout current (it serves the root
`CLAUDE.md` that agents actually receive). Add `git -C <main checkout> pull --ff-only` to the
session-start routine, or find why the worktree copy is not the one injected.

## 6. Working rules for session length (rank 2)

No code. Three rules to add to root `CLAUDE.md` once the diet has made room:

1. **Hand off at a milestone, not at exhaustion.** When a PR merges or a stream stage closes, write
   the handoff (existing house practice) and start a fresh session. Evidence: sessions that ran
   past ~700 calls averaged ~500k tokens per call and compacted twice.
2. **Hand off when context passes ~250k tokens.** If main sessions had averaged 250k, not 452k, the
   week would have re-read about 0.9 B fewer tokens for the same number of calls.
3. **Tell each subagent which zone it works in, and to stay there.** Each zone touched adds that
   zone's `CLAUDE.md` for the rest of the agent's life (today 78–202 KB per zone).

## 7. Hand-off plan C — shell-read habits and guardrails (rank 3)

| Slice | Change | Notes |
|---|---|---|
| C1 | Add a root `.ignore` listing `pnpm-lock.yaml` and `package-lock.json` | Honoured by the Grep tool and `rg`; not by `grep -r`. Do not list `diag/captures/`: invariant #13 has agents search capture folders. `diag/` (about 660 MB tracked) is handled by the scoping rule in C4 |
| C2 | Delete `package-lock.json` (385 KB); the repo is pnpm | No Dockerfile or CI workflow references it |
| C3 | In `scripts/audit-god-files.mjs`: set the 3 existing `ALLOWLIST` caps to today's line counts and add an entry for each other violator (37 violations today, so about 34 new entries: `cap` = current lines, `target` = 600, `reason` = "over ceiling at the 2026-11-14 review; ratchet only"). Add a step named "File-size ratchet" running `node scripts/audit-god-files.mjs` to the `verify` job in `.github/workflows/ci.yml`, after the `depcruise` step | The script already has the ratchet; it was never run in CI. Fix its "Inv #13" label, which clashes with root invariant #13 |
| C4 | Add three lines to root `CLAUDE.md`: search with the Grep tool or `git grep` scoped to `src/ docs/ tests/ scripts/`, never the repo root; read files over 600 lines by range after `grep -n`; cap shell output with `| head -40` | 269 outputs of 15–30k characters carried 5.5 M characters |

**Order: D1, then C3, then D2–D8.** `SectorRoom.ts` grew about 5,700 lines since 31 October.
Turning the ratchet on blocks any PR that adds to it, so land D1 first; then new handlers have a
home. From C3 onward each D slice lowers the file's cap in the same PR.

**Done when:** `pnpm audit:god-files` passes on `main` and fails a PR that grows a capped file.

## 8. Hand-off plan D — `SectorRoom.ts`, then `ColyseusClient.ts` (rank 4)

**Shape of the problem.**

| File | Lines | Methods | Giant methods (start line : length) |
|---|---|---|---|
| `src/server/rooms/SectorRoom.ts` | 11,596 | ~247 | `onCreate` 1602 : 2,711 · `onJoin` 8494 : 805 · `update` 11308 : ~289 · `get _internals()` 1364 : ~242 |
| `src/client/net/ColyseusClient.ts` | 7,025 | ~106 | `connect` 1450 : 1,259 · `updateMirror` 4191 : 691 · `tickPhysics` 4996 : 554 · `handleSnapshot` 3256 : 453 · `sendFire` 6658 : 264 |

The six largest methods hold about 6,470 lines. This is a single-responsibility failure inside a
few methods, not hundreds of small ones: most of SectorRoom's methods are under 50 lines (about
210 by a regex count).

**History.** The May refactor took `SectorRoom.ts` to 3,437 lines (`docs/LESSONS.md` line 590); it
is now 11,596. The size gate was written and never enforced. Hence C3, in the order given in
section 7.

**Pattern to extend (do not invent a new one).** `RespawnHandler.ts` and `LeaveHandler.ts` in
`src/server/rooms/` are handler classes; `onCreate` constructs each with a literal of the
dependencies it needs (`new RespawnHandler({ … })` near line 2162). Use that class form. There is
no shared room-wide dependency object, and none should be added. Inside `onCreate`, helper
closures such as `tpMessage` and `tradeRequest` already wrap schema-parse and ownership checks;
move them with the handlers they serve.

**The 65 message handlers** sit in `onCreate` between lines 3152 and ~4160, grouped as:

| Slice | Handlers | Lines (approx.) | Module |
|---|---|---|---|
| D1 | `test_aggro`, `test_reload_turrets`, `test_kill_capitals`, `test_fleet_warp` | 3168–3229 | `TestMessageHandlers.ts` |
| D2 | `webrtc_offer`, `webrtc_ice`, `webrtc_fallback` | 4114–4160 | `WebRtcSignalHandlers.ts` |
| D3 | `lock_request`, `lock_track`, `lock_cancel`, `set_group_mode`, `select_entity`, `deselect_entity` | 4059–4113 | register from `LockSubsystem` / `SelectionStatsSubsystem` |
| D4 | 10 `teleport_*` and 2 `set_teleport_*` handlers (with `tpMessage`, `ownTeleporter`) | 3479–3594 | `TeleporterMessageHandlers.ts` |
| D5 | `place_structure`, `remove_structure`, `structure_action`, `upgrade_structure`, `set_recipe`, `load_blueprint`, `unload_blueprint` | 3281–3478 | `StructureMessageHandlers.ts` |
| D6 | `refine_salvage`, trade (`accept_offer`, `cancel_deal`, `send_gift`), `install_blueprint`, `lab_*`, `bp_*`, `packed_stock_query`, `unpack_hull` | 3624–3858 | `EconomyMessageHandlers.ts` |
| D7 | `break_in`, `break_in_cancel`, `set_freight_orders`, `cargo_query`, `cargo_move`, `place_bounty`, `set_faction_policy`, `set_gate_access` | 3595–3623, 3859–3930 | `AccessMessageHandlers.ts` |
| D8 | `pilot_ship`, `spectate`, `apply_ship_upgrade`, `respec_ship`, `repair_ship`, `activate_mount` | 3931–4058 | `ShipMessageHandlers.ts` |
| — | `engage_transit`, `cancel_transit`, `input`, `fire`, `respawn`, `client_ready` | 3152–3280 | leave in place |

**Honest size of the win.** D1–D8 move about 1,000 lines, 9% of the file. The rest of `onCreate`
(lines 1602–3150) is collaborator construction, and `onJoin` is 828 lines. Those need their own
inventory before slicing; this review did not do it. Treat D1–D8 as the mechanical first wave.

**Per-slice steps.**
1. New worktree from fresh `origin/main`. Read only the handler line range, `RespawnHandler.ts` as
   the pattern, and `tests/integration/sectorRoom/harness.ts`.
2. Find the tests that send these message types (`git grep -n "'<message>'" -- tests src`). If a
   handler has none, write a failing integration test first (166 files in
   `tests/integration/sectorRoom/` show the style).
3. Create the class; `onCreate` constructs it and registers its handlers. Move bodies unchanged:
   keep each handler's `testMode` gate, its zod parse and `malformed.record` call (invariant #3),
   and add no allocation (invariant #14). No behaviour edits in the same PR.
4. Apply the recorded lessons (`docs/LESSONS.md` line 692): route test access through
   `room._internals`; move state ownership before method bodies; build a collaborator only after
   the collaborators it depends on exist.
5. Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:integration`, then
   `timeout 8 pnpm dev:server` (exit 143 is clean). D3 and D8 touch the live loop: run netgate.
6. `ColyseusClient.ts` mixes CRLF and LF lines (over 400 CRLF); compare its CR count with
   `origin/main` before pushing any slice that touches it.
7. Once C3 has landed, lower the file's cap in `scripts/audit-god-files.mjs` to the new size in
   the same PR.

**`ColyseusClient.ts` follows the same plan:** `connect` registers 50 `room.onMessage` handlers
inline; group them by the same domains. `updateMirror`, `tickPhysics` and `handleSnapshot` match the
collaborator names already chosen in the v3 plan (MirrorUpdater, PredictionStateManager,
SnapshotApplier). Inventory before slicing.

## 9. Parallel systems

Checked against `CLAUDE.md` "NEVER build a parallel system" (PR #576). Sanctioned splits are marked.

**What is already single-source:** ship definitions (`src/shared-types/shipKinds/*` via
`defineShipKind`), weapons (`WeaponCatalogue.ts`), damage application (`DamageRouter`), UI stores.

### 9.1 Quick wins (rank 5) — hand-off slices

| Slice | Duplicate | Evidence | Change |
|---|---|---|---|
| E1 | Three mass fallbacks for one ship | Player body: `World.ts:238` `massOf(kind, 1)`. AI body on the server: `NPC_MASS_FALLBACK = 2` (`tuning.ts:203`, used at `SwarmSpawner.ts:87`, `HostileDroneBehaviour.ts:329`, `SectorRoom.ts:2961`). The client's copy of an AI body: `DRONE_FALLBACK_MASS = 3` (`droneClientLeaf.ts:30`), which also breaks invariant #15. Thrust is an impulse not scaled by mass (`applyShipInput.ts:82`), so the same kind accelerates at half the rate under an AI pilot. Only `crossguard`, `lShape` and capitals author a mass | Test first (same kind, all three bodies, equal mass), then one fallback in `tuning.ts`. Changes feel: see decision 1 |
| E2 | Seven AI-ship spawn sites seed vitals by hand | `LivingWorldBotHooks.ts:110` is the shared route; `SectorRoom.ts` calls `swarmSpawner.spawnDrone` directly at 1497, 2952, 3061, 5807, 7558, 10744, each setting health and shield itself (1497 and 5807 want shield 0; 3061 and 10744 want full shield) | `spawnLivingWorldBot` is not a drop-in: it also broadcasts `warp_in` and emits `BOT_SPAWNED`. Extract one "spawn and seed vitals" helper that takes the shield intent, and call it from all seven sites, `spawnLivingWorldBot` included. One site per slice |
| E3 | Old impulse path beside the pilot path | `AI_INTENT` in `worker.ts:82,313`, `PhysicsWorkerProxy.ts:41`, `SectorRoom.ts:1944–1953`; `src/core/CLAUDE.md:287` says "Do NOT add an AI-only actuation path" | Port `ScriptedPathBehaviour` to pilot inputs, then delete `AI_INTENT` |
| E4 | AI files with no production importer | `core/ai/formation.ts`, `DriftingAsteroidBehaviour.ts`, `contextSteering.ts`, `tactics/morale.ts` | No deletion. `formation.ts` is shelved work (`docs/SHELF.md:90`); `DriftingAsteroidBehaviour.ts` is a fixture for two test suites; the last two are staged for unmerged branches. Optional: move the fixture next to `pilotTestKit.ts` |
| E5 | Worker command types declared twice | `worker.ts` has an unexported `WorkerCommand` union (line 141); `PhysicsWorkerProxy.ts` keeps its own `WorkerCmd` union by hand. `src/core/CLAUDE.md:140` asks for three lists to be kept in sync | Needs a short design step first: `worker.ts` is a worker entry file that nothing imports. Move the union to a types-only module both sides import, and pick one name. The pool-host commands (`ADD_WORLD`, `REMOVE_WORLD`, `GC`, sent by `PhysicsWorkerPool.ts`) are a separate set |
| E6 | Copied test helpers | `joinClient` in 6 e2e specs; `waitForLocalShip` in 4 e2e and 2 `tests/diag` specs | Replace with the existing `launchTestClient` in `tests/e2e/helpers/gameScenario.ts` where it fits; add a helper only for what it lacks |

Checks for every E slice: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:integration`;
E1 and E3 also need `timeout 8 pnpm dev:server` and netgate.

### 9.2 Hostility and "faction" (rank 6) — needs decisions, not agents yet

Six mechanisms answer "is this hostile?":

| Mechanism | File | Used for |
|---|---|---|
| `relationOf` — header calls it "the ONE answer" | `shared-types/relations.ts` | gates, turrets, cargo, break-ins, patrols |
| Stance table | `shared-types/allegiances.ts` | AI side vs side; friendly fire |
| Standings and policy | `shared-types/factions.ts` | inside `relationOf` only |
| Per-ship retaliation set | `HostileDroneBehaviour.hostileTo`, `AiController.isEntityHostileToPlayer` | AI ship vs player; radar colour |
| Wave-war state | `core/faction/Faction.ts`, `server/faction/FactionLedger.ts` | player and structures vs drones |
| Robot truce | `AiPlayerView.truce` | bypasses on-sight hostility |

- AI ships never ask `relationOf` about players; they use their own set plus the stance table.
- `PatrolSubsystem.factionOf` (line 99) returns an NPC faction id; `FactionLedger.factionOf`
  (line 76) returns the owning player's id. Same name, different meaning.
- `allegiances.ts:37–39` and `factions.ts:84–86` repeat drones, robots and traders with the same
  names and colours.
- The client builds a full `HostileDroneBehaviour` per AI ship (`droneClientLeaf.ts:55`) and uses it
  only for `markHostile`, `purgeHostility` and `isEntityHostileToPlayer`; it never ticks it.

Direction: make retaliation an input to `relationOf`, merge the allegiance table into
`factions.ts`, rename `core/faction` to describe what it is (a wave-war state). See decision 2.

### 9.3 One ship entity (rank 11) — roadmap, not a hand-off

| Layer | Player-flown | AI-flown |
|---|---|---|
| Server state | `ShipState` schema (`health`, `energy`) | `SwarmEntityRecord` + `swarmHealth` / `swarmShield` maps |
| Physics body | `World.spawnShip` | `World.spawnObstacle`, patched by `applyAiInput` |
| Wire | Colyseus schema + snapshot | binary swarm records |
| Drawing | `shipSpriteUpdater.ts` | `swarmSpriteUpdater.ts`; parked hulls a third path in `PixiRenderer.ts` |
| Energy | spent by weapons and boost | boost only; AI weapons spend none |
| Lock | `LockSubsystem.ts` | `NpcLockSubsystem.ts` |
| Fire | `PlayerFireResolver.ts` (685) | `AiFireResolver.ts` (424) — sanctioned by invariant #12 |

This split is behind E1 and E2, and it is the kind of sibling system PR #576 forbids. It is already
half-recorded as the "5 separate stores" note in the B4 unification handoff. It is large and
high-risk; it needs its own plan with a hostile review before any code.

### 9.4 Lower priority

Classic effects (`client/effects/perEffect/*`, ~1.4k lines) vs `?fx=new` (`render/art/fx/*`):
automated browsers default to classic, so tests check one look and players see the other. Four
hand-written spatial grids. RNG and angle helpers re-implemented (`mulberry32` ×2, four angle
wraps). Legacy constants in `Weapons.ts` still live (`HITSCAN_RANGE` in 4 files). Three port-offset
variables and several self-starting launchers beside `showcase/servers.ts`.

## 10. Process tidy (rank 10)

- **Memories** (`~/.claude/projects/C--…-eqx-net/memory/`): five feedback memories repeat rules now
  in `CLAUDE.md` (`no_idle_on_ci`, `no_merge_questions`, `no_parallel_systems`, `record_as_is`,
  `worktree_and_ports`); `project_time_scale_stream` is stale (PR #527 merged);
  `project_rts_command.md` has no index line; `MEMORY.md` lines 3–14 hold content, not pointers.
- **Legacy memory dir** (`c--…-eqx-net-eqx-net/memory/`): `feedback_netgate_ci_only.md` contradicts
  `CLAUDE.md`; `project_phase.md` is 19.5 KB of May–June status.
- **Settings:** user `settings.json` has 25 allow entries that are mostly one-off commands, and says
  the repo has no git remote. No deny rules anywhere.
- **Docs:** 31 `docs/HANDOFF-*.md` (25 from May–June); plans live in `plans/`, `docs/plans/` and
  `~/.claude/plans/`; `plans/archive/` is named in `plans/CLAUDE.md` but does not exist;
  `docs/Advanced Game Dev Stack Cheat Sheet.md` (54 KB) is unreferenced.
- **Folders:** about 40 unregistered worktree folders; the orphaned `eqx-net-hud` checkout still
  injects its own 72 KB `CLAUDE.md`.

## 11. Decisions for the owner

1. **A fighter flown by an AI pilot accelerates and brakes at half the rate it does when you fly
   it, and your own game predicts it heavier still.** Recommended: make the AI match the player. The alternative makes player ships heavier.
2. **When an AI ship decides whether you are an enemy, it uses its own grudge list, not the rule
   book the gates and turrets use.** Recommended: one rule book, with grudges feeding into it.
3. **`CLAUDE.md` keeps rules only; thresholds, history and how-it-works text move to the guides,
   and the standing rule that says "when in doubt, put it in CLAUDE.md" changes to match.**
   Recommended; say if any section must stay in `CLAUDE.md` verbatim.
4. **Turning on the file-size check will block PRs that add lines to the big files.** Recommended:
   turn it on right after slice D1 lands.
5. **Sessions should hand off at about 250k tokens of context.** Recommended; the number is a
   starting point.

## 12. Research notes

Practitioner sources; the numbers are single-setup reports, not controlled studies.

- Always-loaded instruction text is paid on every call; narrow procedures belong in on-demand skills
  or path-scoped rules; `@` imports save nothing because imports load at session start.
- Large files cost through over-reading, not through existing. One report: about 83% fewer input
  tokens for the same change after splitting a 17,000-line file. This repo's own data shows the
  effect is real but smaller than the instruction-file cost.
- SOLID's common failure is over-fragmentation. Split by cohesion ("one reason to change"), and
  pass dependencies as arguments, which the existing handler modules already do.

Sources: [composio.dev](https://composio.dev/blog/ways-to-cut-token-consumption-in-claude-code) ·
[vantaige.io](https://vantaige.io/blog/claude-code-token-waste-9-patterns-fixes-2026) ·
[claude-dev.tools](https://claude-dev.tools/docs/token-saving-lessons) ·
[fullstack.com](https://www.fullstack.com/labs/resources/blog/seven-ways-to-spend-fewer-tokens) ·
[sweep.dev](https://blog.sweep.dev/posts/read-file) ·
[baarse.substack.com](https://baarse.substack.com/p/what-i-learned-after-burning-33b) ·
[dev.to/mdenda](https://dev.to/mdenda/solid-isnt-overrated-its-misapplied-41lm) ·
[arrangeactassert.com](https://arrangeactassert.com/posts/fn-args-deps-and-solid-principles/)
