# Generic Entity Pipeline

> **Status: shipped** (branch `feat/generic-entity-pipeline`, 4 phases). The thesis is
> demonstrated: a brand-new networked, collidable, *damageable* world-object type
> (a "structure") was added end-to-end with **zero new dispatch code** in the four
> combat/sync sites — it rides the existing seams.

## Why

EQX Peri grows *horizontally* — the roadmap keeps adding world-object types
(structures, capital ships, debris, black holes, mines, pickups). Before this
work, adding a type meant re-implementing the same four concerns from scratch in
several places, because dispatch was keyed on the **shape of a target's id
string**:

- `DamageRouter.apply` — a 4-branch if-tree (`wreck-` prefix → lingering
  `!isActive` → active `playerId` → swarm registry).
- `ProjectilePipeline` / `MissileSimulation` — the same fan-out re-implemented as
  collision passes.
- `ShieldHullRouter` — `damageShipLayered` (schema) vs `damageSwarmLayered` (maps).

The user's goal, in their words: *"when I add new structures/ships/debris/black
holes, I'm not starting from scratch… the bugs are the leaf's gameplay logic, not
'why can't I see it / why isn't it updating / why can't I damage it.'"* A new type
should be **a leaf + a small descriptor**, and networking / construction /
rendering / damage come for free.

## The three layers (genericity lives in registration + routing, NOT the wire)

1. **Pose-core wire stays homogeneous + UNCHANGED.** The 33-byte binary swarm
   record (`src/shared-types/swarmWireFormat.ts`, v3) carries the generic
   per-entity info every object has (x/y/vx/vy/angle/angvel + a `kind` byte). It
   is fast *because* it is branch-free and fixed-stride. A new pose-core-fitting
   type rides it via a **new `kind` byte value** (asteroid=0, drone=1,
   structure=2, …) with **no stride change and no `SWARM_WIRE_VERSION` bump** —
   the byte is a free `u8`. (Adding a new *continuous* field would force a
   deliberate v4 bump; a new kind value does not.)
2. **Capability extras ride OTHER channels** — the slim JSON snapshot slices or
   discrete event broadcasts.
3. **The generic part is registration + routing.** Each kind declares descriptors
   once; the dispatch/sync/render seams read the descriptor instead of branching
   on id-string shape.

## What each phase delivered

| Phase | Deliverable | Key files |
|---|---|---|
| **P1** | Zone-pure `Entity` base + capability contracts (`IDamageable`, `INetworkSynced`, `IRenderContributor`) + append-only `EntityKindRegistry`. Server `HealthBinding` singletons over the real stores. | `src/core/entity/`, `src/core/contracts/IDamageable.ts`, `src/server/entity/healthBindings.ts` |
| **P2** | Collapsed `DamageRouter.apply`'s if-tree → **table-driven** (`resolve(targetId) → DamageKind`, then a per-kind `{ health, perHit?, death }` strategy). Byte-identical, locked by a 12-case golden-master. | `src/server/rooms/DamageRouter.ts`, `DamageRouter.dispatch.test.ts` |
| **P3** | Client `swarmKindProfile` — explicit per-kind predWorld routing (`staticBody` / `hasAiBehaviour` / `hasShield`). Unknown kinds **skip** instead of being mis-routed as drones (HC#2). | `src/client/net/swarmKindProfile.ts`, `ColyseusClient.syncSwarmIntoPredWorld` |
| **P4** | A static, damageable **STRUCTURE** (`SWARM_KIND_STRUCTURE = 2`) end-to-end as the proof. | `swarmWireFormat.ts`, `SwarmSpawner.spawnStructure`, the `structurePoses` trigger, the `STRUCTURE` profile case, `structureEntity.test.ts`, `structure-visible-damageable.spec.ts` |

## The "structure for free" proof — what it actually cost

Adding the structure touched only:

- **SEND**: one constant (`SWARM_KIND_STRUCTURE = 2`). It rides
  `BinarySwarmBroadcast` (writes `rec.kind` as-is) + the interest grid (a
  structure reuses the single `interestScratch` per (client,tick) — verified, no
  new `query9`) **unchanged**.
- **DAMAGE**: *nothing*. `DamageRouter` routes any swarm-registry entity with a
  `swarmHealth` entry through its 'swarm' strategy. Seeding `swarmHealth` on spawn
  is the only structure-specific damage line; the four dispatch sites are
  byte-untouched.
- **CONSTRUCT / RENDER**: one `case` in `swarmKindClientProfile` (STRUCTURE =
  static, no-AI, no-shield). The P3 scaffold then locks + poses it like an
  asteroid via the existing predWorld + sprite path.
- **SPAWN**: a `SwarmSpawner.spawnStructure` helper (`spawnOne` was already
  generic — its `kind===0/1` guards naturally exclude kind 2) + a `structurePoses`
  testMode trigger.
- **REGISTRY**: appended `'structure'` to the `EntityKindRegistry` (pose-core 2)
  and widened `SwarmKind` to `0|1|2`.

## Hardening (from the hostile review)

- **HC#1 — load-bearing dispatch order.** `DamageRouter`'s branch order +
  per-branch side-effects (broadcast / bus / worker `DESPAWN linger-<id>` /
  slot-freelist / `evictSwarmEntity` / the swarm-only `damage_applied` diag) are
  asymmetric and ordering-sensitive. The P2 collapse is locked by a golden-master
  written **before** the if-tree was deleted (test-first).
- **HC#2 — "a new kind byte needs no client changes" was HALF-FALSE.** The binary
  decoder reads any `u8`, but `syncSwarmIntoPredWorld` used `kind===0 ? asteroid :
  else-is-drone`, so a kind=2 would have been mis-registered as a
  `HostileDroneBehaviour`. P3's `swarmKindProfile` makes routing explicit:
  unknown kinds skip; a wired kind routes by descriptor.
- **HC#3 — drone HP lives in a parallel map** (`CombatSubsystem.swarmHealth`), so
  `HealthBinding` holds a *reference* to the live store, never a value copy.
- **HC#5 — monomorphic dispatch.** The damage call site stays one method reading a
  4-key strategy record (not a virtual `entity.receiveInteraction()` across N
  hidden classes, which would megamorphic-deopt under ramming/projectile load).

## Deliberately NOT done

- **No server `EntitySyncRouter` rewrite.** Pose-core SEND is already generic via
  the kind byte; rewriting the proven broadcast for the structure case would be
  risk without functional gain.
- **No projectile/missile collision moved into the physics worker.** The
  main-thread lag-comp split is strategic; only the *dispatch tail* collapsed.
- `resolveDroneDisplayPose → resolveEntityDisplayPose` rename — non-load-bearing
  generalization, deferred.

## Verification

- Deterministic: `pnpm typecheck && pnpm lint && pnpm test` (1781 unit) + full
  integration suite green (incl. `structureEntity.test.ts`).
- Functional E2E: `structure-visible-damageable.spec.ts` (chromium) — the
  structure renders + is shootable.
- Performance: `pnpm e2e:netgate` PASS — net-feel comparable to `origin/main`
  (rollingCorrRate identical, ticksAhead better, drift/drop within the
  noise-tolerant AND-gate margins).
- On-device: the game boots + plays on a real Android phone, and the kind=2
  structure renders there (`tests/mobile-perf/phone-structure.spec.ts`).

## Adding the next pose-core type (the recipe this bought you)

1. Append `SWARM_KIND_<X> = N` to `swarmWireFormat.ts` (no stride/version bump).
2. Append the kind to `EntityKindRegistry` (core) + a `swarmKindClientProfile`
   case (client) with its static/AI/shield descriptor.
3. A `SwarmSpawner.spawn<X>` entry point + a spawn trigger; seed `swarmHealth` if
   it should be damageable.
4. (If it needs a distinct collider/sprite) its vertices/mass at the kind-explicit
   construction site + a sprite arm. A circle + the asteroid sprite is the
   zero-effort default.
5. Add the "new visible entity ⇒ full-snapshot-path integration test" (server
   CLAUDE.md mandate) + an E2E if it's player-facing.

The four combat/sync dispatch sites do **not** change.
