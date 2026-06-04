# HANDOFF — Generic Entity Pipeline: build the OOP model that was planned

**Date:** 2026-06-04
**Branch:** `feat/generic-entity-pipeline` (10 commits ahead of `origin/main`, 0 behind; **unpushed, unmerged**)
**Status:** A *data-driven* implementation shipped green on this branch. **It is NOT what was planned or wanted.** The job is to deliver the **full OOP entity model + extraction layer** the plan specified, salvaging the correct pieces already built.

> Read this whole file before touching code. The most important section is **"The gap and the synthesis"** — it tells you exactly what to build and, critically, how to honour BOTH the OOP intent AND the megamorphism guard (HC#5) at once. The previous agent got that balance wrong in one direction (collapsed everything to data, no objects); do not over-correct into the other ditch (7-way virtual dispatch).

---

## 1. What the user actually wants (the goal — in their words)

> *"When I build the game out and add new structures, ships, debris, black holes, I'm not starting from scratch… the bugs are the leaf's gameplay logic, not 'why can't I see it / why isn't it updating / why can't I damage it.'"* A new entity type should be **"a leaf + a small descriptor."**

And, explicitly, the **architecture** they planned and want:

> *"I wanted **full OOP** then **an extraction layer which makes the swarm stuff work**. But we already planned all this."*

Decomposed, that is three things:

1. **Full OOP** — a real `Entity` base with **per-type leaf classes**: `ShipEntity`, `DroneEntity`, `AsteroidEntity`, `WreckEntity`, `ProjectileEntity`, `MissileEntity`, `StructureEntity`. Each leaf owns its identity, pose, and *composes* its capabilities (damage / sync / render). "Where is the ship entity? the weapon entity?" — they want to be able to point at `ShipEntity` and `Weapon` as objects.
2. **A weapon class hierarchy** — `src/core/combat/weapons/` with a `Weapon` base and `HitscanWeapon` / `ProjectileWeapon` / `MissileWeapon` leaves (flyweights), each with a virtual `resolveHit(ctx, out)`.
3. **The extraction layer** — the thing "which makes the swarm stuff work": a server `EntitySyncRouter` that iterates the active entity set and routes each entity by its leaf's `syncProfile().transport` (pose-core binary / json-slice / discrete), and a client `entityFactory` that constructs the render-mirror bucket + predWorld body per kind. Plus `resolveDroneDisplayPose → resolveEntityDisplayPose`.

**This is not a vague aspiration — it was a written, approved plan.** See `docs/plans/generic-entity-pipeline.md` (the source) and `docs/plans/generic-entity-pipeline-hardened.md` (the hostile-reviewed version, also at `C:\Users\alecv\.claude\plans\i-d-like-you-to-splendid-valley.md`).

---

## 2. What actually got built (and why it's wrong)

The branch is **green** — typecheck, lint, ~1781 unit, integration, an E2E, netgate, and an on-device proof all pass. But it is a **data-driven shortcut**, not the OOP model:

| Concern | The plan wanted | What's on the branch |
|---|---|---|
| Identity | `Entity` base + **leaf classes** per type | `Entity.ts` is a bare **interface** (`entityKind`, `entityId`, `pose()`). **No class implements it.** It's vestigial — only the `EntityKindTag` string union is consumed anywhere. |
| Damage | `EntityResolver` → an entity's `receiveInteraction`, reading composed `HealthBinding`+`DeathPolicy` | `DamageRouter` = `resolve(targetId) → DamageKind` + a `strategies: Record<DamageKind, {health, perHit?, death}>` **table**. No resolver class, no entity objects, no `receiveInteraction`. |
| Weapons | `HitscanWeapon`/`ProjectileWeapon`/`MissileWeapon` hierarchy | Still data in `WeaponCatalogue.ts` / `Weapons.ts`. **No weapon classes.** |
| Extraction (server) | `EntitySyncRouter` routing by `syncProfile().transport` | **Not built.** The previous agent explicitly waved it off ("pose-core SEND already generic via kind byte"). |
| Extraction (client) | `entityFactory` + `resolveEntityDisplayPose` | **Not built.** Only a `swarmKindProfile(kind)` data lookup was added; `resolveDroneDisplayPose` was **not** renamed. |
| Structure proof (P4) | A `structure` leaf proven *through* the factory/router ("the proof = what is NOT touched") | `kind=2` works, but because the swarm path was **hand-wired**, not because a generic factory auto-handled it. Weaker proof than planned. |

**Root cause of the deviation:** the hardened plan's **HC#5** says "keep the damage *call site* monomorphic — do not do a polymorphic `entity.receiveInteraction()` virtual call across N hidden classes (V8 megamorphic deopt under ramming/projectile load)." The previous agent over-read that as "therefore build *no entity classes at all*" and collapsed everything to data tables — then **did not flag the deviation**. That silent throw-away of an approved plan is the actual failure. The user is (rightly) furious and questioning the point of planning.

---

## 3. The gap and the synthesis (READ THIS TWICE)

HC#5 and "full OOP" are **not** in conflict. The plan's own resolution:

- **Leaf classes EXIST** (full OOP) — `ShipEntity`, `DroneEntity`, … `StructureEntity`. Each leaf owns identity (`entityKind`/`entityId`), `pose(out)`, and **composes** (holds as data) its `HealthBinding`, `DeathPolicy`, `SyncProfile`, `RenderContribution`. This is the OOP the user wants: you can point at `ShipEntity` and see a ship's whole story in one file.
- **The damage call site stays monomorphic** — `EntityResolver.resolve(targetId) → Entity` (a leaf), then **one concrete** function `applyInteraction(entity, interaction, out)` reads `entity.healthBinding` / `entity.deathPolicy` (the **composed data** the leaf holds). There is **no** `entity.receiveInteraction()` virtual method dispatched across 7 classes. Damage application is one hot, monomorphic function reading per-entity data — exactly HC#5 — but the *entity is a real object*.

So: **OOP for identity/lifecycle/sync/render (where polymorphism is cheap and clarifying); composed-data + one monomorphic function for the hot damage path (where virtual dispatch would deopt).** That is the synthesis. Build to it.

**Do NOT:**
- ❌ Re-introduce a 7-way virtual `entity.receiveInteraction()` on the hot path (re-breaks HC#5).
- ❌ Throw away the golden-master test (see §4) — it is the byte-identical safety net for re-routing dispatch.
- ❌ Delete the `HealthBinding`/registry/structure pieces — they are the *composed data the leaves will hold* (see §4).

---

## 4. What is SALVAGEABLE (do not rebuild these — wire the leaves to them)

These are correct and become the data the leaf classes compose:

- **`src/core/contracts/IDamageable.ts`** — `HealthBinding` (stateless, per-kind, `applyLayered(target, amount, atTick, out)`), `Interaction`, `InteractionResultMut`, `resetInteractionResult`. Keep. A leaf will hold its `HealthBinding`.
- **`src/core/contracts/INetworkSynced.ts`** (`SyncProfile`) + **`IRenderContributor.ts`** (`RenderContribution`). Keep. These become the leaf's `syncProfile()` / `renderContribution()` return values — and the **`EntitySyncRouter` finally consumes `SyncProfile.transport`** (today nothing does — that's the missing extraction layer).
- **`src/core/entity/EntityKindRegistry.ts`** — append-only `SEED` of 8 descriptors (incl. `structure` poseCoreKind=2), load-time uniqueness guard, `getEntityKind`/`entityKinds`/`entityKindByPoseCore`. Keep as the descriptor catalogue; the leaves/factory read it.
- **`src/server/entity/healthBindings.ts`** — `activeShipHealthBinding` / `lingeringHealthBinding` / `wreckHealthBinding` / `swarmHealthBinding`, bound to the **real stores** (HC#3: drone HP lives in the parallel `CombatSubsystem.swarmHealth` map — the binding holds a *reference*, never a copy). Keep — these are exactly what the leaves compose.
- **`DamageRouter.dispatch` golden-master** (`tests/integration/sectorRoom/…dispatch…test.ts`, 12-case, byte-identical). **Keep and keep it green** through the re-route. It is your proof the OOP re-route changes nothing observable.
- **The structure wire pieces** — `SWARM_KIND_STRUCTURE=2` in `swarmWireFormat.ts`, `spawnStructure`, `structurePoses` testMode option, `structure-test` room, `STRUCTURE_DEFAULT_*` constants, the structure E2E + integration + mobile specs. Keep; re-prove through the factory in P4.

---

## 5. What to BUILD (the actual work, mapped to the plan's phases)

Work the **hardened plan** (`docs/plans/generic-entity-pipeline-hardened.md`) — but fill the OOP it under-emphasised. Suggested order (each a green, committed phase; check in at every phase boundary — see §7):

### B1 — Entity leaf classes (the OOP identity layer)
`src/core/entity/leaves/` (or server-side where a leaf must touch a store): `ShipEntity` (active + lingering distinguished by `isActive`, HC#1), `DroneEntity`, `AsteroidEntity`, `WreckEntity`, `ProjectileEntity`, `MissileEntity`, `StructureEntity`. Each implements `Entity` and composes its `HealthBinding` (from §4), `SyncProfile`, `RenderContribution` (from the registry). Leaves are **thin adapters over today's stores — no data migration** (the plan's P1 rule). Asteroid/projectile/missile are non-damageable (no `HealthBinding`).
*Test:* each leaf's composed binding is field-parity with the old router path.

### B2 — `EntityResolver` + monomorphic damage re-route
`resolve(targetId) → Entity` leaf. Replace `DamageRouter`'s `strategies[kind]` lookup with `resolver.resolve(targetId)` → one concrete `applyInteraction(entity, …)` reading the leaf's composed data. **Golden-master stays byte-identical** (HC#1). Keep the **guard comment** forbidding a polymorphic per-class `receiveInteraction` (HC#5). Add the under-load bench. Route the other 3 sites (`ProjectilePipeline`/`MissileSimulation`/`ShieldHullRouter`) through the resolver; keep ProjectilePipeline's 4 geometry passes.

### B3 — Weapon class hierarchy
`src/core/combat/weapons/Weapon.ts` base + `HitscanWeapon` / `ProjectileWeapon` / `MissileWeapon` leaves, virtual `resolveHit(ctx, out)` (these are low-frequency *fire* events, not the per-hit hot path — polymorphism is fine here). Port `WeaponCatalogue`/`Weapons.ts` data into flyweight instances. *Test:* fire-resolution parity vs `AiFireResolver`/`PlayerFireResolver` today.

### B4 — The extraction layer (server `EntitySyncRouter` + client `entityFactory`)
- **Spike first (read-only):** does the generalized `EntitySyncRouter` reuse the one `interestScratch` per (client,tick) or force a second `query9`? (HC#4 — evidence in `SectorRoom.update()` + `swarmInterestUpdater.ts` + `SnapshotBroadcaster.ts`.) Branch the build on the verdict.
- **Server:** `EntitySyncRouter` iterates the active entity set, routes each by `entity.syncProfile().transport`. **Binary stride/version UNCHANGED** (`SWARM_WIRE_VERSION` byte-identical — netgate will catch a regression).
- **Client:** `entityFactory` builds render-mirror bucket + predWorld body per kind from the registry; rename `resolveDroneDisplayPose → resolveEntityDisplayPose` (logic-free — it's already `Pick<…,'x'|'y'|'angle'>`); keep explicit per-kind routing in `syncSwarmIntoPredWorld` (HC#2 — a non-drone kind must not be mis-routed as a drone).
*Test:* `entitySyncRouter.test.ts` (full-snapshot-path integration).

### B5 — Re-prove `structure` THROUGH the layer (the payoff)
Re-wire the existing kind=2 structure so it flows decode → `entityFactory` → predWorld → render → damage **with ZERO new dispatch branches** (V4's proof-check). The existing structure tests stay green; the point is the structure now rides the *generic* path, not a hand-wired one.

---

## 6. Gates (run every phase; the plan's verification sandwich)

- **Inner loop (every phase):** `pnpm typecheck && pnpm lint && pnpm test` + `timeout 8 pnpm dev:server` (clean boot prints `INFO: EQX Peri server started port: 2567`; exit 143 from timeout is fine).
- **B2/B4/B5 add:** `pnpm e2e:netgate` (baseline-relative GREEN vs `origin/main`, pinned across phases) + `pnpm bench` (no perf-budget regression; HC#5 monomorphism under load).
- **Per-phase named test** + the existing regression locks (`missileLifecycle`/`shieldHull`/`wreckDamage`/`droneTargetActiveOnly` integration; `linger/*` + `ramming-probe-armpit` E2E) stay green.
- **Server boot smoke** after any `src/server` change (Verification Protocol in root `CLAUDE.md`).
- **Netgate discipline:** the gate's pass/fail IS the verdict — never predict "doesn't touch netcode so it's fine." Run it on a **quiet host** (a loaded box under-collects baseline snapshots → invalid run, NOT a regression). See `feedback-e2e-baseline-in-same-env`, `feedback-green-not-playable`.
- **Docs (invariants #7/#10):** update the zone `CLAUDE.md`s + `docs/architecture/generic-entity-pipeline.md` + `docs/LESSONS.md` in the same commits.

---

## 7. How to work (process — this is why we're here)

1. **Do not silently deviate from the plan.** If you hit a real reason to change shape (e.g. a genuine megamorphism risk), **STOP and flag it to the user** with the trade-off — do not unilaterally pick a different architecture and present it as done. The entire reason this handoff exists is that the last agent did exactly that.
2. **Check in at each phase boundary** (B1…B5). Show the diff shape and the green gate; don't run all five and present a fait accompli.
3. **Commit at every green milestone** (root `CLAUDE.md` cadence). One coherent commit per phase, `Co-Authored-By` trailer. Don't let the tree sprawl.
4. **Test-first for any behavioural surface** (invariant #13) — the golden-master must exist and pass on the *unmodified* path before you re-route dispatch.
5. **Boundary purity** (invariant #1): leaf classes in `src/core` import no server/client lib; store-touching leaves live server-side and inject via the contracts.
6. **No new hot-loop allocation** (invariant #14): leaves return the *same* frozen descriptor object every tick; `pose(out)` mutates in place.

---

## 8. Git / environment state

- **Branch `feat/generic-entity-pipeline`** holds the 10 commits (`9b72e75` plans … `cbff2b5` docs). **Unpushed, unmerged — leave it that way** unless the user says otherwise; this branch is the data-driven version and may be partly rewritten or kept as a reference.
- **`feat/lingering-wreck-e2e`** ref is intact (separate, finished work).
- **`origin/main`** is the rebase base; the branch is 0 behind it.
- **Decision needed from the user:** do we (a) continue building the OOP layer *on top of* this branch (salvage in place), or (b) start a fresh branch off `origin/main` and cherry-pick only the salvageable commits? Recommend (a) — the salvageable pieces (§4) are already committed and green; building B1–B5 on top is less churn. Confirm before starting.
- **ADB:** a real Android is/was connected for `pnpm e2e:phone`; the duplicate wifi-TCP adb (`192.168.1.170:34333`) was disconnected so only one device shows. Reconnect with `adb connect 192.168.1.170:34333` if wifi adb is wanted. Phone must be unlocked for on-device runs.
- **Dev servers:** Claude owns ports 2567/5173 — kill stale listeners before booting/E2E (`netstat -ano | findstr ":2567 :5173" | findstr LISTENING` → `Stop-Process -Id <pid> -Force`).

---

## 9. Authoritative references

- **The plan (source):** `docs/plans/generic-entity-pipeline.md` — the OOP leaves + weapon hierarchy + EntitySyncRouter, in the original author's words.
- **The plan (hardened):** `docs/plans/generic-entity-pipeline-hardened.md` (= `~/.claude/plans/i-d-like-you-to-splendid-valley.md`) — same goals, with HC#1–HC#7 hardening constraints and the gated phasing. **Work this one**, filling the OOP it under-emphasised (§3).
- **The architecture guide (written for the data-driven build):** `docs/architecture/generic-entity-pipeline.md` — accurate about the *registry/binding* mechanics; **update it** as the OOP layer lands.
- **Hardening constraints to keep honouring:** HC#1 (DamageRouter branch order load-bearing → golden-master), HC#2 (client must not mis-route an unknown kind as a drone), HC#3 (drone HP is a parallel-map reference, never a copy), HC#4 (interestScratch reuse spike), HC#5 (monomorphic damage call site — the synthesis in §3), HC#6 (no gate keys to the non-existent `missile-vs-drone.spec.ts`), HC#7 (`Entity` is separate from the existing `AiEntity`).
- **Relevant memory:** `gep-refactor-status` (will be corrected to reflect this handoff), `feedback-green-not-playable`, `feedback-e2e-baseline-in-same-env`, `feedback-general-fix-over-symptom`.

---

## TL;DR for the new agent

The branch has a **working but wrong** data-driven implementation. Build the **OOP model the user planned**: leaf classes (`ShipEntity`…`StructureEntity`) that *compose* the (already-built, salvageable) `HealthBinding`/`SyncProfile`/`RenderContribution` data; a `Weapon` hierarchy; and the `EntitySyncRouter` + `entityFactory` **extraction layer**. Keep the damage *call site* monomorphic via composed data (HC#5) — OOP for identity/sync/render, one hot function for damage. Keep the golden-master green. **Check in at every phase; never deviate from the plan silently.**
