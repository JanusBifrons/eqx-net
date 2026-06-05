# Generic Entity Pipeline — Hardened Execution Plan (hostile-reviewed, workflow-orchestrated)

## Context

EQX Peri grows *horizontally* — the roadmap keeps adding world-object types (structures, capital
ships, debris, black holes, mines, pickups). Today, adding a type means re-implementing the **same
four concerns** (send over the wire / construct on the client / render / take damage) from scratch in
several places, because dispatch is keyed on the *shape of a target's id string* across four sites.
A teammate authored a refactor plan to fix this — **`docs/plans/generic-entity-pipeline.md`**, committed
today on branch `claude/game-object-polymorphism-BvyED`. Its goal (the user's words): *"when I add new
structures/ships/debris/black holes I'm not starting from scratch… the bugs are the leaf's gameplay
logic, not 'why can't I see it / why isn't it updating / why can't I damage it.'"* A new type should be
**a leaf + a small descriptor**; networking, construction, rendering, and damage come for free.

This file is a **hardened plan derived entirely from that one** — same goals, same three-layer
architecture, same phasing — after a 3-agent hostile review verified every claim against the live code.
The review **confirmed most of the plan**, but **falsified one central claim** and surfaced several
undefined/under-specified spots that would have bitten during execution. Those corrections are folded in
below. Execution is structured as a **deterministic multi-agent workflow** (the user invoked "workflow";
ultracode is on), run **in a fresh git worktree** so the active `feat/lingering-wreck-e2e` checkout is
undisturbed.

**User decisions (this session):** (1) Scope = **Full Phases 1–4** (Phase 4, the structure-leaf proof,
is the payoff). (2) Worktree base = **rebase onto current `origin/main`** (the plan's branch is 44
commits behind main; the 5 target files are byte-identical to main but ~44 commits of surrounding work
are missing). (3) Autonomy = **auto-run every gate (inner loop + netgate + bench), auto-commit each
green phase, HALT + report only on a RED gate or a Phase-3 escalation trigger; one clean on-device
hand-off at the end.**

---

## What the hostile review changed (the hardening deltas)

All findings verified against the tree on 2026-06-04. `HC#` = hardening constraint, threaded into the
phase tasks + verify-agent checks below.

- **HC#1 — DamageRouter's 4-branch order is LOAD-BEARING (CONFIRMED).** `DamageRouter.apply`
  (`src/server/rooms/DamageRouter.ts`, branches at lines ~113/142/183/230) dispatches by id-shape:
  `wreck-` prefix → lingering `!isActive` schema flag → active `playerId` → swarm registry. Each branch
  has *distinct, ordering-sensitive* side-effects (broadcast, bus `SHIP_DESTROYED`/`PLAYER_DAMAGED`,
  worker `DESPAWN linger-<id>`, slot-freelist push, `evictSwarmEntity`, the swarm-only `damage_applied`
  diag). ⇒ **P2 must write a golden-master test that pins each branch's exact output BEFORE the if-tree
  is deleted** (test-first, invariant #13).
- **HC#2 — "a new `kind` byte needs NO client changes" is HALF-FALSE (the one falsified claim).** The
  binary wire stride/version genuinely *don't* change (the `kind` field is a free `u8`, append-only:
  `SWARM_KIND_ASTEROID=0`, `SWARM_KIND_DRONE=1`), and `BinarySwarmDecoder` *reads* any `u8` without
  crashing — **but** the client then **mis-routes** it: `ColyseusClient.syncSwarmIntoPredWorld` branches
  `if (kind===0) asteroid else drone` (~:2639/2667/2682/2697) and the decoder's shipKind lookup is
  drone-only (`BinarySwarmDecoder.ts:114`). A `kind=2` would be silently treated as a drone (AI
  registration, dynamic-physics body, skipped shield-swap/asteroid-lock). ⇒ **P3 must add explicit
  per-kind client routing** so a non-drone kind isn't mis-routed; **P4's kind=2 leaf depends on it.**
- **HC#3 — drone health is in a PARALLEL map, not the record (CONFIRMED).**
  `CombatSubsystem.swarmHealth: Map<string,number>` (`CombatSubsystem.ts:52`, surfaced via
  `ShieldHullRouter.swarmHealth`). ⇒ the plan's "adapters over today's stores, no migration" is viable
  **only** if the drone adapter holds a **reference** to that map. This also **defines the plan's
  undefined term "HealthBinding"**: it is an *injected accessor* `{ getHealth/setHealth/getShield/… }`
  bound per type to its real store — **never a copied value** (copying would desync).
- **HC#4 — "reuse the one `interestScratch`" is UNVERIFIED.** A single `interestScratch` per
  (client,tick) exists, but whether the generalized `EntitySyncRouter` can reuse it or would incur a
  **second `query9`** is not proven in code. ⇒ **P3 starts with a read-only spike** that decides this;
  the rest of P3 branches on the verdict.
- **HC#5 — megamorphism is a real EXECUTION risk.** Collapsing dispatch is correct *only* if the call
  site stays **monomorphic**: one `EntityResolver` → a **concrete-base** `receiveInteraction` that reads
  composed `DeathPolicy` + `HealthBinding` **data**. A polymorphic `entity.receiveInteraction()` virtual
  call across 6+ hidden classes would megamorphic-deopt under ramming/projectile load. ⇒ **P2 adds a
  bench under load + an explicit guard comment** forbidding the polymorphic form.
- **HC#6 — a named test lock does not exist.** The source plan cites `missile-vs-drone.spec.ts`; it is
  **not in the repo** (nearest: `tests/e2e/missile-frigate-homing.spec.ts`). Confirmed-present locks:
  `tests/integration/sectorRoom/{missileLifecycle,shieldHull,wreckDamage,droneTargetActiveOnly}.test.ts`,
  `tests/e2e/linger/*` (7 specs), `tests/e2e/ramming-probe-armpit.spec.ts`. ⇒ **no gate keys to the
  non-existent spec; P2/P3/P4 each add their own named new test.**
- **HC#7 — `Entity` name collision.** `AiEntity` already exists (`IAiBehaviour.ts:35`, a read-only pose
  snapshot). ⇒ the new mutable `Entity` base must be a **separate type/file**, not an extension of it.
- **Confirmed-clean (no change needed):** the four dispatch sites + their structures; `ShieldHull.applyLayeredDamage`
  and `Ramming.aggregateRamming` are pure and reusable; `spriteUpdateDecisions.ts` is pure + extensible;
  `swarmDisplayPose.resolveDroneDisplayPose` is *already* generic (`Pick<…,'x'|'y'|'angle'>` — rename is
  logic-free); the DI/contract seam (`src/core/contracts/*`) supports the 3 new contracts with no name
  clash; `WeaponMountController` is untouched (invariant #12); netgate budget is intact
  (`tests/netgate/netHealthBudget.ts`: rollingCorrRate 0.6 / ticksAhead 30 / maxDrift 12 / meanDrift 3 /
  droppedSnapshotsRecent 4). `@colyseus/testing` is installed-but-peer-mismatched — **forbidden** (its use
  is a Phase-3 escalation trigger).

The architecture itself (3 layers: homogeneous binary pose-core wire UNCHANGED; capability-extras on
json-slice/discrete channels; genericity in the registration+routing seam) and the explicit OUT-OF-SCOPE
(do **not** move projectile/missile collision into the physics worker — lag-comp stays main-thread) are
**adopted verbatim** from the source plan.

---

## Execution model — a gated, sequential workflow with in-phase fan-out

The four phases are **strictly sequential**; each is one coherent commit behind a full gate. *Within* a
phase, new-file and new-test-case authorship **fan out in parallel**; every edit to a pre-existing shared
function/method serializes (one author). Two phases open with a **read-only spike** that decides how the
rest of the phase proceeds. Each phase ends with an **adversarial verify-agent** that checks the HC
constraints, then runs the gate.

```
worktree off origin/main → bring in the plan doc (commit 0)
  → P1 ──gate(base)──────────────→ commit 1
  → P2 ──gate(base+netgate+bench)→ commit 2
  → SPIKE-A → P3 ──gate(base+netgate+bench)→ commit 3
  → SPIKE-B → P4 ──gate(base+netgate+bench)→ commit 4
  → HALT + report  (never auto-merge to main; one on-device hand-off)
```

**Gate (the verification sandwich), run by the phase's verify-agent:**
- Base (all phases): `pnpm typecheck && pnpm lint && pnpm test` + `timeout 8 pnpm dev:server` (clean
  boot, exit 143 OK).
- P2/P3/P4 add: `pnpm e2e:netgate` (baseline-relative **GREEN vs origin/main**, baseline pinned across
  all phases so slow P2→P4 creep is visible) **+** `pnpm bench` (no perf-budget regression).
- Plus each phase's named new integration/E2E test.
- **Auto-commit on full GREEN.** **HALT + report** on: any RED gate; a net-state-sync regression vs
  baseline; a hallucinated/forbidden API (`@colyseus/testing`); or 2 failed fix iterations on one gate.

**Worktree + commit ritual:**
1. `git worktree add .claude/worktrees/entity-pipeline -b feat/generic-entity-pipeline origin/main`
   — a **distinct** dir; do **not** reuse `.claude/worktrees/netgate-{baseline,head}` (owned/clobbered
   by `pnpm e2e:netgate`).
2. Copy `docs/plans/generic-entity-pipeline.md` (the source) + this hardened plan into the worktree as
   commit 0, so the branch carries its own plan.
3. One commit per green phase (5 commits total); messages end with the `Co-Authored-By` trailer.
4. Per phase-gate ritual, update the relevant zone `CLAUDE.md` + `docs/LESSONS.md` + add the feature
   guide `docs/architecture/generic-entity-pipeline.md` in the same commit.

**Parallel-collision serialization rule:** fan out new-file + new-test-case authorship; serialize every
edit to a pre-existing shared surface — `SectorRoom` wiring (R1), `DamageRouter.apply` (R2),
`ColyseusClient.syncSwarmIntoPredWorld` + the `swarmDisplayPose` rename fan-out (R3),
`swarmWireFormat.ts` (R4, additive), `EntityKindRegistry` (R5, append-only), `SectorRoom._internals`
pierced getters (R6).

---

## Phase 1 — Entity base + capability contracts + adapters (LOW · zero-behaviour · not netgate-gated)

**Goal:** add the zone-pure `src/core` surface and make the **7** existing types (active ship, lingering
hull, wreck, drone, asteroid, projectile, missile — the source plan says "6" but enumerates 7) implement
it via thin adapters over today's stores. No data migration; existing routers still run unchanged.

- **T1.0 [sequential, blocks all]** — scaffold `src/core/entity/`: concrete `Entity` base + `EntityKindRegistry`
  (append-only) + contracts `IDamageable`, `INetworkSynced`, `IRenderContributor` in `src/core/contracts/`.
  Define **`HealthBinding` = injected accessor** (HC#3). `Entity` is a **separate type from `AiEntity`**
  (HC#7).
- **T1.a–f [parallel]** — one adapter per type, each a thin shim over its real store (own new file, no
  collision): active-ship/lingering (`ShipState` + `isActive`), wreck (`WreckState`/`wrecksMap`), drone
  (**`HealthBinding` bound to the `CombatSubsystem.swarmHealth` map reference** — HC#3), asteroid (immune
  `null`-layered path preserved), projectile+missile (record shapes).
- **T1.wire [sequential]** — inject the adapters into `SectorRoom` (the one shared-mutable edit; R1).
- **Verify-agent V1:** no edits to any dispatch body (P1 is adapters-only); drone adapter holds a *map
  reference*, not a value snapshot (HC#3); new base does not import/alias `AiEntity` (HC#7); registry is
  append-only; `src/core/entity` purity (no colyseus/pino/node leak). **Gate: base only** (run once as
  sanity; pure typing).

## Phase 2 — Collapse the four dispatch sites (MEDIUM · behaviour-preserving · NETGATE REQUIRED)

**Goal:** route `DamageRouter`/`ProjectilePipeline`/`MissileSimulation`/`ShieldHullRouter` dispatch tails
through one `EntityResolver` + concrete-base `receiveInteraction`. **Test-first** (HC#1).

- **Stage 1 [parallel] T2.gm-1..6** — author `tests/integration/sectorRoom/interactionDispatch.test.ts`:
  one golden-master case per branch (wreck / lingering / active / drone / asteroid / projectile-missile
  tail), each asserting exact `DamageEvent` + `DestroyEvent` + **bus-event order** + worker `DESPAWN
  linger-<id>` + freelist mutation. **T2.fly [parallel]** — stateless per-mode weapon flyweights (own
  file). **Checkpoint V2a:** golden-master GREEN on the **unmodified** if-tree (else the lock is wrong).
- **Stage 2 [sequential, single author]** — T2.res `EntityResolver` + concrete `receiveInteraction`
  (composed `DeathPolicy`/`HealthBinding`, **monomorphic** call site — HC#5) → T2.del delete the if-tree
  in `DamageRouter.apply` (**keep ProjectilePipeline's 4 geometry passes**; collapse only the dispatch
  tail) → T2.route point the other 3 sites at the resolver, re-running the golden-master after each →
  T2.bench add a ramming+projectile-load bench + a **guard comment** forbidding a polymorphic
  `entity.receiveInteraction()` (HC#5).
- **Verify-agent V2b:** golden-master output old-path vs new-path **byte-identical** (HC#1); the 4
  geometry passes unchanged; call site monomorphic + guard comment present; bench shows no megamorphic
  regression. **Gate: base + netgate + bench + interactionDispatch.** Auto-commit.

## Phase 3 — Genericize send/construct/render (MEDIUM · NETGATE-CRITICAL)

**Spike-A first [read-only]:** does the generalized `EntitySyncRouter` reuse the one `interestScratch`
per (client,tick) (built in `SectorRoom.update()`) or force a second `query9`? Evidence path:
`SectorRoom.ts` interest build + `swarmInterestUpdater.ts` + `SnapshotBroadcaster.ts`. Output verdict
branches the rest of P3 (HC#4).

- **Server [parallel]** — T3.s1 `EntitySyncRouter` routing each entity by `syncProfile().transport`
  (`pose-core` binary / `json-slice` / `discrete`); **binary bytes/stride/version UNCHANGED**; if Spike-A
  = second-query9, this task owns the explicit second-interest build + a budget note. T3.s2 per-kind
  `syncProfile` declarations on the 7 adapters (each edits its own file).
- **Client [sequential, single author]** — T3.c1 rename `resolveDroneDisplayPose` →
  `resolveEntityDisplayPose` in `swarmDisplayPose.ts`, updating all consumers (one author; the
  one-pose-per-frame seam is load-bearing). T3.c2 `entityFactory` + per-kind predWorld registration, and
  **add explicit per-kind handling in `syncSwarmIntoPredWorld`** (the `kind===0 else drone` branch) so a
  future non-drone kind is not mis-routed — the **structural scaffold for HC#2** (the kind=2 leaf lands
  in P4).
- **Verify-agent V3 (net-critical):** `SWARM_WIRE_VERSION` + header + per-record stride byte-identical
  to P2; Spike-A verdict honored (reuse ⇒ no new `query9`; second-query9 ⇒ budget note + bench); one
  pose-per-frame preserved (no consumer re-interpolates post-rename); **net-state-sync regression ⇒
  escalation HALT.** **Gate: base + netgate + bench + new `tests/integration/sectorRoom/entitySyncRouter.test.ts`**
  (the server-CLAUDE.md "new visible entity ⇒ full-snapshot-path integration test" rule). Auto-commit.

## Phase 4 — A 'structure' leaf end-to-end (MEDIUM · NETGATE REQUIRED) — the proof

**Spike-B first [read-only]:** confirm `SWARM_KIND_STRUCTURE = 2` appends with no stride/version change,
and that P3's per-kind scaffold (`syncSwarmIntoPredWorld` + `BinarySwarmDecoder.ts:114`) will route
kind=2 to the **structure** path, not the drone branch (HC#2). Go/no-go + exact lines to arm.

- **[parallel]** T4.reg append `SWARM_KIND_STRUCTURE=2` + register the structure kind in
  `EntityKindRegistry` (net/construct/render/damage profiles). T4.srv server structure entity
  (`transport: pose-core`; damage routes through the **P2 EntityResolver — zero new dispatch branch**).
  T4.cli client kind=2 arm in decoder + `syncSwarmIntoPredWorld`; structure predWorld body + render
  contributor via the P3 factory. **[sequential]** T4.e2e the proof test.
- **Verify-agent V4 (proof-check):** **ZERO new dispatch branches** in the 4 sites vs P2 (the entire
  point — "for free"); wire stride/version unchanged, only the kind-byte *value* + client kind=2 arm are
  new; a kind=2 record drives through decode→factory→predWorld→render→damage and is **not** mis-routed as
  a drone; the 7 pre-existing types still pass all P1/P2/P3 locks (regression sweep). **Gate: base +
  netgate + bench + new `structure-visible-damageable.spec.ts` (E2E, crosses decode→factory→render→predWorld
  hit per invariant #13) + a `structureEntity` integration test.** Auto-commit, then **HALT + report.**

---

## Workflow tool shape (for execution after approval)

A single `Workflow()` run, phases as sequential stages; `parallel()` for the fan-out tasks and the
verify-panels; structured-output schemas for spike verdicts and verify reports so the script branches on
them. Sketch:

- `phase('P1')` → `agent(T1.0)` → `parallel([T1.a..f])` → `agent(T1.wire)` → `agent(V1, schema)` →
  if green, commit; else HALT.
- `phase('P2')` → `parallel([T2.gm-1..6, T2.fly])` → `agent(V2a)` gate → sequential
  `T2.res→del→route→bench` → `agent(V2b)` → gate(base+netgate+bench) → commit.
- `phase('P3')` → `agent(SPIKE-A, schema{verdict})` → branch → `parallel(server)` + sequential(client) →
  `agent(V3)` → gate → commit.
- `phase('P4')` → `agent(SPIKE-B, schema{go})` → branch → `parallel([T4.reg,srv,cli])` → `agent(T4.e2e)`
  → `agent(V4)` → gate → commit → HALT.

The gate steps (`pnpm …`, netgate, bench, boot smoke, `git commit`) run from the orchestrating context
inside the worktree between stages — the agents author code and adversarially verify; the harness runs
the deterministic gates and commits only on green.

---

## Verification (end-to-end)

- **Inner loop (every phase):** `pnpm typecheck && pnpm lint && pnpm test` + `timeout 8 pnpm dev:server`
  (`INFO: EQX Peri server started port: 2567`).
- **New tests:** `interactionDispatch.test.ts` (P2 golden-master), `entitySyncRouter.test.ts` (P3),
  `structureEntity` integration + `structure-visible-damageable.spec.ts` E2E (P4); plus per-leaf
  `receiveInteraction` field-parity vs the old routers.
- **Netcode (P2–P4):** `pnpm e2e:netgate` baseline-relative-GREEN vs `origin/main` (invariant #8),
  guarding rollingCorrRate/ticksAhead/maxDriftUnits/meanDriftUnits/droppedSnapshotsRecent.
- **Bench (P2+):** `pnpm bench` — `receiveInteraction` monomorphism under load + zero new hot-loop alloc
  (invariant #14).
- **Regression sweep (P4):** the confirmed existing locks
  (`missileLifecycle`/`shieldHull`/`wreckDamage`/`droneTargetActiveOnly` integration, `linger/*` +
  `ramming-probe-armpit` E2E) stay green.
- **Docs (invariants #7/#10):** zone `CLAUDE.md` updates (core contracts; server interaction-collapse +
  kind byte; client factory + generalized pose seam) + `docs/architecture/generic-entity-pipeline.md`.
- **Final hand-off:** after P4 green, one on-device smoke pass (the user holds the network-feel verdict);
  the branch is **not** auto-merged — a human reviews the 5-commit branch.

## Critical files

- `src/server/rooms/DamageRouter.ts` — P2 if-tree; HC#1 golden-master target.
- `src/server/rooms/CombatSubsystem.ts` — HC#3 `swarmHealth` parallel map; `HealthBinding` reference.
- `src/server/rooms/{ProjectilePipeline,MissileSimulation,ShieldHullRouter}.ts` — the other 3 dispatch
  sites (P2); keep ProjectilePipeline's 4 geometry passes.
- `src/client/net/ColyseusClient.ts` — HC#2 `syncSwarmIntoPredWorld` kind-branch; P3/P4 client routing.
- `src/client/net/BinarySwarmDecoder.ts` — HC#2 drone-only shipKind lookup at `:114`; P3/P4 decode routing.
- `src/shared-types/swarmWireFormat.ts` — kind-byte append site (P4 `=2`); wire stride/version invariant.
- `src/client/net/swarmDisplayPose.ts` — one-pose-per-frame seam to generalize (P3).
- `src/core/contracts/*`, `src/core/entity/*` *(new)*, `src/core/combat/{ShieldHull,Ramming}.ts`
  (pure, reused).
- Source plan being hardened: `docs/plans/generic-entity-pipeline.md` (branch
  `claude/game-object-polymorphism-BvyED`).
