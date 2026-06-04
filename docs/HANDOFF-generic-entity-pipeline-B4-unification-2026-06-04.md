# HANDOFF — Generic Entity Pipeline B4: the entity-system unification

**Date:** 2026-06-04
**Branch:** `feat/generic-entity-pipeline` (14 commits ahead of `origin/main`, unpushed/unmerged)
**Status:** B1–B3 + the B4 rename are **SHIPPED, green, byte-identical, committed**. The remaining B4 (the server `EntitySyncRouter` + client `entityFactory` unification) and B5 (re-prove `structure` through the layer) REMAIN. This handoff exists so the next session starts from the **completed spike verdict** below — do NOT re-run the spike.

> Companion: `docs/HANDOFF-generic-entity-pipeline-OOP-2026-06-04.md` (the original OOP-rebuild handoff; B1–B3 of it are now done). The plan is `docs/plans/generic-entity-pipeline-hardened.md`.

---

## 1. What shipped this session (committed on `feat/generic-entity-pipeline`)

| Commit | Phase | What | Gates passed |
|---|---|---|---|
| `a806cdc` | **B1** | Real OOP leaf classes in `src/server/entity/leaves/` (`ShipEntity` [active+lingering], `WreckEntity`, `DroneEntity`, `StructureEntity` damageable; `AsteroidEntity` non-damageable; `Projectile`/`MissileEntity` sync-only). Each COMPOSES its `HealthBinding`/`PerHitEffect`/`DeathPolicy`/sync/render as data. | typecheck, lint, full suite, leaf-parity 12/12 |
| `6011fd6` | **B2** | `src/server/entity/EntityResolver.ts` + monomorphic `DamageRouter.applyInteraction`; the data-driven `strategies[kind]` table DELETED. `benchmarks/damageDispatch.bench.ts` (no megamorphic cliff). | golden-master 12/12 **byte-identical**, **netgate PASS=true**, bench, boot, **4-lens adversarial workflow ALL PASS** |
| `196c4d0` | **B3** | `src/core/combat/weapons/` (`Weapon` base + `HitscanWeapon`/`ProjectileWeapon`/`MissileWeapon` flyweights). Both fire resolvers' `if (mode===…)` if-tree → one `getWeaponObject(id).resolveFire(ctx, this)`; the resolver IS the `WeaponFireSink` (server bodies relocated VERBATIM). | weapons parity, full suite, `weaponBoundToMount` integration, `swarm-hit-detected` combat E2E, boot |
| `c8c6ac1` | **B4 (rename)** | `resolveDroneDisplayPose → resolveEntityDisplayPose` (entity-generic rename, per the directive). | typecheck, `swarmPoseConsistency`/`droneOnePoseAcrossFrames`/`LocalBeam` locks |

**Pre-existing-RED note (NOT a regression):** `tests/integration/sectorRoom/hitAckContract.test.ts` has 2 failures — verified baseline-identical (B3 resolvers stashed → same 2 failures). It's the documented `client_ready`/`connectActive` gap (see `src/server/CLAUDE.md`), not the GEP work.

---

## 2. THE DIRECTIVE (load-bearing — overrides the plan's "swarm-only" framing)

The user's words this session:

> *"I notice it keeps talking about the swarm, it should really be changed to be an entity system, as now not just drones but everything should route through."*

So B4 must be **entity-generic**: EVERY entity type (ships, wrecks, drones, asteroids, structures, projectiles, missiles) routes through ONE entity system — `EntitySyncRouter` (server) + `entityFactory` (client) — each by its leaf's `syncProfile().transport`. **Do NOT** ship a swarm-only scope (the user explicitly rejected that). **Do** keep the WIRE byte-identical so the netgate stays green; if byte-identity can't hold, **STOP and flag** (don't ship a netcode regression, don't silently narrow). See memory `gep-entity-system-directive`.

---

## 3. THE SPIKE VERDICT (done — do NOT re-run; from two read-only agents 2026-06-04)

**HC#4 — interestScratch reuse: ✅ CONFIRMED REUSE.** Exactly one `query9` per (client,tick), built in `SwarmBroadcaster.broadcast()` (~line 72), stored in `SnapshotBroadcaster.interestScratch`, reused by both the binary swarm send AND the snapshot drone slice. A new router CAN reuse it — **no second `query9`**.

**Server send shape:**
- The **pose-core binary send is ALREADY fully generic** — `BinarySwarmBroadcast.encode()` writes `rec.kind` as-is with ZERO per-kind branching (a new pose-core kind sends for free). `shipKind` byte only populated for kind===1.
- Entities live in **5 SEPARATE stores, no unified iterable:** `state.ships` (active+lingering), `state.wrecks`, `swarmRegistry` (drone/asteroid/structure), `projectiles.liveProjectiles`, `missileSim.live()`.
- The two sends are **separate blocks** in `SectorRoom.update()`: `swarmBroadcaster.broadcast()` (~line 3267, binary, per-client interest) and `snapshotBroadcaster.broadcast()` (~line 3313, json-slice; a global ship digest + a per-client loop building states/projectiles/drones/wrecks/missiles — ~271 LOC, the tuned 20 Hz hot path).
- ⇒ A literal "iterate the active entity set, route by transport" router means **unifying 5 store-loops inside the proven 20 Hz send** (the spike's "Tier 2/3" — high risk). The pose-core path needs no change; the json-slice unification is the risky part.

**Client construct shape:**
- `swarmKindClientProfile(kind)` (`src/client/net/swarmKindProfile.ts`) is ALREADY the data-driven factory (`{staticBody, hasAiBehaviour, hasShield}`); HC#2 guard returns `null` for unknown kinds (SKIP, never the drone path).
- `syncSwarmIntoPredWorld` (`ColyseusClient.ts` ~2622) reads the profile + does per-kind construction (asteroid vertices, drone mass, lock, AI register, shield swap). The construction caches **`predSwarmKeys` / `_swarmBodyKeyCache` / `_aiRegisteredIds` are shared across `syncSwarmIntoPredWorld`, `updateMirror` (~3343, kinematic loop), and teardown (~923, ~4701)** inside the 4700-line `ColyseusClient` — an `entityFactory` extraction must thread all of that without moving prediction.
- The rename (`resolveDroneDisplayPose → resolveEntityDisplayPose`) is DONE (`c8c6ac1`).

---

## 4. THE TRACTABLE DESIGN for the next session (byte-identical, netgate-gated)

**Server `EntitySyncRouter`** — make the leaves' `syncProfile().transport` LOAD-BEARING (today nothing consumes it; that's the "missing extraction layer"). Build the router as the single per-client send orchestrator that iterates each of the 5 stores, resolves each entity's transport via the registry/leaf `syncProfile()`, and routes:
- `pose-core` → the existing `BinarySwarmBroadcast` (UNCHANGED — `SWARM_WIRE_VERSION` byte-identical; the netgate catches a stride/version regression).
- `json-slice` → the same slim slices (`states`/`wrecks`/`projectiles`/`missiles`/`drones`) in the **same grouping + order** (byte-identity!).
- `discrete` → events (none of these types today).
Keep the iteration order + slice structure identical to today so the wire bytes don't move. Reuse `interestScratch` (HC#4). The hardest part: refactoring `SnapshotBroadcaster`'s per-client loop into "for each entity, route by transport" while preserving the exact JSON. **If you can't keep it byte-identical / netgate-green, STOP and flag** — a thin router that the existing broadcasters delegate to (router owns the transport DECISION, broadcasters keep the encoding) is the safe fallback, but confirm with the user it satisfies "everything routes through."

**Client `entityFactory`** — extract `syncSwarmIntoPredWorld`'s per-kind construction into an `EntityFactory` that reads the registry/profile + `renderContribution()`. The caches are coupled across 3 methods → either the factory owns them (and `updateMirror`/teardown call the factory) or it takes a reused context (no per-call alloc, #14). Locks: `droneRenderSmoothness`, `swarmPoseConsistency`, `droneOnePoseAcrossFrames`, `tests/e2e/robustness.spec.ts` (the `data-obstacle-positions`/`data-ship-positions` hooks), + netgate.

**Gates (both):** inner loop + `timeout 8 pnpm dev:server` + **`pnpm e2e:netgate` (must stay PASS vs origin/main)** + `pnpm bench` + a new `tests/integration/sectorRoom/entitySyncRouter.test.ts` (full-snapshot-path). Update zone CLAUDE.md + `docs/architecture/generic-entity-pipeline.md` (mark B4 done) + `docs/LESSONS.md`.

**Then B5** — re-prove the kind=2 `structure` flows decode → `entityFactory` → predWorld → render → damage with ZERO new dispatch branches (the existing `structure-test` room + E2E/integration/mobile specs stay green; the point is it now rides the GENERIC factory/router, not the hand-wired path).

---

## 5. Process discipline (why we're here)

- **Never deviate from the plan silently.** The whole rebuild happened because the first build silently swapped the planned OOP for data tables. B1–B3 were checked in at the seams; the B4 unification scope was surfaced + decided WITH the user (this checkpoint). Keep that.
- **Byte-identical or stop.** The damage path (B2) + the send (B4) are netcode-adjacent. The netgate's PASS/FAIL IS the verdict — never predict "doesn't touch netcode." Run it on a quiet host.
- **One clean handoff, never a loop.** This is a clean checkpoint: committed, green, no stale servers. The fresh session reads §3 (spike) + §4 (design) and starts building — no re-spike.

---

## 6. Git / environment

- `feat/generic-entity-pipeline`: 14 ahead of `origin/main`, **unpushed/unmerged** (user's call to push/merge). HEAD = `c8c6ac1`.
- Tree clean (only `diag/` + the diagram png + the two HANDOFF docs are untracked; commit this handoff).
- No stale dev servers on 2567/5173. Boot smoke clean at HEAD.
- Relevant memory: `gep-refactor-status`, `gep-entity-system-directive`, `feedback-never-deviate-from-plan-silently`, `feedback-green-not-playable`, `feedback-e2e-baseline-in-same-env`.
