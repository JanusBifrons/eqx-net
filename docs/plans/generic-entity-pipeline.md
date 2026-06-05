# Generic Entity Pipeline — a base GameObject/Entity model where new types auto-wire send + construct + render + damage

> Status: **planned, not started.** Authored for hand-off — another agent can pick this up and execute
> Phase 1. Develop on branch `claude/game-object-polymorphism-BvyED`.

## Context

EQX Peri grows *horizontally*: the roadmap adds structures, capital ships, debris, black holes, mines,
pickups. Today, adding a world-object type means re-implementing the same four concerns from scratch in
several places, because there is **no uniform entity interface** — dispatch is keyed on the *shape of a
target's id string*:

- `src/server/rooms/DamageRouter.ts:109-282` — `apply()` is a **4-branch if-tree** (`wreck-*` prefix →
  lingering schema `isActive=false` → active `playerId` → swarm registry).
- `src/server/rooms/ProjectilePipeline.ts:142-230` — the same fan-out re-implemented as **4 collision
  passes** (player lag-comp sweep / swarm SAB sphere / wrecks / lingering).
- `src/server/rooms/MissileSimulation.ts:258-685` — `SplashKind 'ship'|'swarm'` lock-on + sweep + splash.
- `src/server/rooms/ShieldHullRouter.ts:92-221` — `damageShipLayered` (schema) vs `damageSwarmLayered` (maps).

**The user's goal (their words):** *"when I build the game out and add new structures, ships, debris, black
holes, I'm not starting from scratch… the bugs are the leaf's gameplay logic, not 'why can't I see it / why
isn't it updating / why can't I damage it.'"* A new entity type should be **a leaf + a small descriptor**,
and networking / client-construction / rendering / damage come for free.

### The decided architecture — three layers; genericity lives in the REGISTRATION+ROUTING seam, NOT the wire

The wire and the local (client/server) objects are separate; local objects are constructed/updated *from*
the wire. The unification belongs in the **server-sim / interaction layer and the registration seam** — it
must stop **above the wire bytes** and **beside the collision split**:

1. **Pose-core wire stays homogeneous and UNCHANGED.** The 33-byte binary swarm record
   (`src/shared-types/swarmWireFormat.ts`, v3) keeps carrying the generic per-entity info every object has
   (x/y/vx/vy/angle/angvel + `kind` byte + small fixed payload). It is fast *because* it is homogeneous and
   branch-free; the netgate guards its decode cost. A new pose-core-fitting type rides it via a **new `kind`
   byte value** — the byte already extends to 2,3,… with **no stride change, no version bump** (precedent:
   `SWARM_RECORD_FLAG_SHIELD_DOWN` was added as a spare bit with an explicit "NO stride change, NO
   `SWARM_WIRE_VERSION` bump" note). Adding a new *continuous* field to the record is the lone exception
   that forces a deliberate **v4 bump** — flagged as an explicit user decision, never silent.
2. **Capability extras ride OTHER channels** — the slim JSON snapshot slices
   (`SnapshotMessage.drones[]/wrecks[]`) or discrete event broadcasts. This is the user's *"basic generic
   info still sent the same way, other methods for other data."*
3. **The generic part is registration + routing.** The server iterates its active entity set; each leaf
   declares a **sync profile** (which transport + which fields) by implementing a contract; the broadcast
   loop auto-routes it and interest-culls uniformly. The client decode → per-kind factory auto-constructs
   the local object + its render-mirror entry.

### Explicitly OUT OF SCOPE

- **Do NOT move main-thread projectile/missile collision into the physics worker.** An earlier framing
  considered this ("unify all collision in the worker"); research falsified it. The split is **strategic,
  not accidental**: projectile collision is main-thread because the lag-comp rewind buffer (`SnapshotRing`,
  `src/server/lagcomp/`) is main-thread, and client prediction is bit-identical *because* the main thread
  pre-validates hits against the shooter's claimed tick. Moving it worker-side breaks lag-comp and thrashes
  prediction. The two-detector split (worker-Rapier ramming + main-thread projectile sweep) is
  **preserved**; only the *dispatch tail* of each collapses to `Entity.receiveInteraction`.
- A read-only `entities-within-radius` spatial range-query (for future black-hole / area-force features) is
  **noted as a future Phase 5**, not designed here. It layers cleanly on Phase 3 and needs no lag-comp change.

---

## Design

### Entity base + narrow capability contracts (all in `src/core`, zone-pure — invariant #1)

Behaviour/abstractions live in `src/core`; concretions (Colyseus schema binding, SAB slot, render mirror)
are implemented by `src/server`/`src/client` via DI, mirroring existing `IRenderer`/`ISwarmRegistry`.

- `src/core/entity/Entity.ts` — `Entity { entityKind; entityId; pose(out): PoseOut }` (scratch-filling, no
  alloc — invariant #14).
- `src/core/contracts/IDamageable.ts` — `receiveInteraction(it: Interaction, out: InteractionResultMut)`.
  The collapse target. **Concrete-on-base / composed-data**: reads an injected `HealthBinding` (which
  existing layered call — `damageShipLayered(ship,…,playerId|null)` / `damageSwarmLayered(rec,…)` / wreck
  health) + a `DeathPolicy` (what to do at 0). The damage call site stays **monomorphic**; per-type
  variation is composed data, not a 7-way override (avoids V8 megamorphism).
- `src/core/contracts/INetworkSynced.ts` — `syncProfile(): { transport: 'pose-core'|'json-slice'|'discrete'
  |'none'; poseCoreKind?; interpolated; jsonSliceTag? }` + optional `writeJsonSlice(out)`. The routing key.
- `src/core/contracts/IRenderContributor.ts` — `renderContribution(): { bucket; preservedFields;
  interpolated }`. Descriptor-driven field-preservation defuses the invisible-hull trap generically.
- `src/core/entity/EntityKindRegistry.ts` — pure **append-only** leaf registry mapping each `EntityKindTag`
  to its descriptors. The "declare a leaf once" seam.

Leaves: `ShipEntity` (active vs lingering = ACTIVE flag + which HealthBinding), `DroneEntity` (AI +
`evictSwarmEntity` death + markHostile), `AsteroidEntity` (STATIC, immune **and** non-targetable),
`WreckEntity`, `ProjectileEntity`, `MissileEntity`. Construction config enters only at the leaf.

### Weapon class hierarchy (instantiated flyweight)

`WeaponCatalogue.ts` stays the pure append-only data source. Add `src/core/combat/weapons/Weapon.ts` —
`HitscanWeapon`/`ProjectileWeapon`/`MissileWeapon` with a virtual `resolveHit(ctx,out)` wrapping the
per-mode bodies currently in `PlayerFireResolver`/`AiFireResolver`. **Stateless flyweights** — one per
`WeaponId` at module load; per-mount cooldown stays in the existing primitive arrays.
`WeaponMountController` is untouched (it owns aim, not the hit hook — invariant #12).

---

## Phasing (each phase independently shippable + green-bar-able)

### Phase 1 — Entity base + capability contracts (pure refactor, ZERO behaviour change) · LOW
Add the `src/core` base + contracts + `EntityKindRegistry`. Make the **6 existing types** implement them via
**adapters over today's stores** (no migration): free-function adapters over `ShipState`/`WreckState`
(`SectorState.ts`, no new `@type`), per-`SwarmKind` profile accessor on `SwarmEntityRegistry.ts` (drone =
pose-core kind 1 interpolated; asteroid = pose-core kind 0 static immune), record-adapter views over
`ProjectileRecord`/`MissileRecord`. Existing routers still run; this phase only adds the surface. Reuse
`ShieldHull.applyLayeredDamage` / `Ramming.aggregateRamming` — adapters delegate, no new math.
**Netgate:** not gated (pure typing); run once as a no-regression sanity. **Tests:** `EntityKindRegistry`
(every tag resolves; pose-core kinds unique/append-only), `IDamageable.adapter` (drone adapter byte-identical
to `damageSwarmLayered`; asteroid → `applied:false`).

### Phase 2 — Collapse the four interaction sites (+ weapon hierarchy) · MEDIUM · behaviour-preserving
Route `DamageRouter`/`ProjectilePipeline`/`MissileSimulation`/`ShieldHullRouter` through one
`EntityResolver` + `Entity.receiveInteraction`. Delete the `targetId`-shape if-tree; per-branch
broadcast/destroy/bus logic moves into each leaf's `DeathPolicy` (preserve verbatim: active-vs-lingering,
`damage_skipped_pending_join`, `linger-${id}` DESPAWN). **Keep the 4 geometry passes in `ProjectilePipeline`
** — merging polygon-player-sweep with sphere-swarm/wreck would change hits and break netgate; only the
*dispatch tail* collapses. `ShieldHullRouter` stays the shared mitigation service (owns swarm shield maps,
0-cross `SET_HULL_EXPOSED`, `SHIELD_BROKEN`); adapters delegate in. Weapon flyweights land here.
**Netgate: REQUIRED.** **Tests (test-first, invariant #9/#13):** `interactionDispatch` golden-master (each
of 6 types → identical `DamageEvent`/`DestroyEvent`/bus output) written BEFORE deleting the if-tree; extend
`wreckDamage`/`ramming`/`shieldHull`/`missileLifecycle`; `Weapon` units; keep `missile-vs-drone.spec.ts`
green.

### Phase 3 — Genericize send/construct/render via the registration+routing seam · MEDIUM · netgate-critical
**Server:** add `EntitySyncRouter.ts` — iterates the active entity set within the client's interest window
(reusing the ONE `interestScratch` set already built per (client,tick) — no extra `query9`), routes each by
`syncProfile().transport`: `pose-core` → existing binary encoder (a new kind byte is just data, zero encoder
code); `json-slice` → `writeJsonSlice` into the named `SnapshotMessage` array; `discrete` → event. **Binary
encoder + `swarmWireFormat.ts` bytes UNCHANGED** (assert byte-identical). **Client:** generalize
`resolveDroneDisplayPose` → `resolveEntityDisplayPose` (the one-pose-per-frame seam — invariant #12; the
2026-05-19 jitter lock), and add `entityFactory.ts` — per-kind factory that on decode (a) builds/updates the
correct render-mirror bucket applying descriptor `preservedFields`, and (b) lazily spawns + poses the
predWorld body with a per-kind id prefix (the *"every collidable entity must be in predWorld"* ritual:
prefix → lazy spawn → `setShipState` → despawn → `predXIds` Set). Per-entity decision logic goes in
`spriteUpdateDecisions.ts` (never inlined). **v4 decision point flagged here** (new continuous pose-core
field → v4 + decoder hard-fail; default routes extras to json-slice/discrete first). **Netgate: REQUIRED**
(interleaved A/B + decoder byte-identity golden). **Tests:** `entitySyncRouting` (each type → expected
transport, byte-identical), generalized `entityFactory` + `swarmPoseConsistency`/`droneOnePoseAcrossFrames`,
v3 decoder round-trip golden.

### Phase 4 — Validation leaf: a STRUCTURE (the "not from scratch" proof) · MEDIUM · netgate
Add a static `'structure'` type: new pose-core `SWARM_KIND_STRUCTURE = 2` (no v4 bump), one descriptor
(`pose-core`, kind 2, static, bucket `'structures'`, `preservedFields:['kind']`), a thin `StructureSpawner`
(reuses slot-pool / `SPAWN_OBSTACLE`, locked body like asteroids), a damageable adapter reusing
`ShieldHull.applyLayeredDamage`, and `decideStructureSpriteAction` + a sprite + a `structures` mirror bucket.
**The proof = what is NOT touched:** `DamageRouter` (resolves any registry entity), `ProjectilePipeline`
(already sweeps `swarmRegistry.all()`), the binary encoder, `EntitySyncRouter`, the factory core — all
auto-handle kind 2. Send + construct + render + damage come for free. **Tests (test-first feature):**
`structureEntity` integration (binary channel kind=2; projectile hit → `DamageEvent` with structure
`hullMax`; health-0 → destroy — the server CLAUDE.md "new visible entity ⇒ integration test through the full
snapshot path" mandate); `structure-visible-damageable.spec.ts` E2E (sprite renders, local player can shoot
it via the predWorld body, health bar appears — crosses decode→factory→render per invariant #13);
`decideStructureSpriteAction` branch test (never skip-to-invisible).

### Phase 5 (future, NOT designed here)
Read-only `entities-within-radius` query over the unified entity iterator + interest grid, for
black-hole / area-force features. No lag-comp change.

Each phase: `pnpm typecheck && pnpm lint && pnpm test` green + `timeout 8 pnpm dev:server` clean boot
(`INFO: EQX Peri server started port: 2567`), one coherent commit. Update the relevant zone CLAUDE.md +
`docs/LESSONS.md` + a `docs/architecture/generic-entity-pipeline.md` guide per the phase-gate ritual.

---

## Risk register (the YELLOW traps → how each phase defuses them)

| Risk | Red line | Mitigation |
|---|---|---|
| **One-pose-per-frame** (2026-05-19 jitter) | `interpolateSwarmPose` resolved exactly once/frame in `updateMirror` | Single `resolveEntityDisplayPose` seam; static leaves opt out; locked by `swarmPoseConsistency`/`droneOnePoseAcrossFrames`. |
| **Render-mirror field preservation** (2026-05-27 invisible hull) | Non-spatial fields survive 60Hz rebuilds | `preservedFields` descriptor-driven at both rebuild sites — no per-leaf list to forget. |
| **predWorld keying** for new namespaces | Every collidable entity has a predWorld body | Per-kind id prefix + per-kind spawned-id `Set` (generalizes `predSwarmKeys`); teardown sweeps each; Phase-4 test asserts the body is hittable. |
| **Wire homogeneity / netgate** | Binary bytes byte-identical; decode cost flat | New kind byte is data only; encoder untouched; netgate required Phases 2–4; byte-identity golden. |
| **Silent v4 bump** | New continuous pose-core field is an explicit user decision | Default routes extras to json-slice/discrete; decoder hard-fails on version; kind values documented append-only. |
| **Interest-grid CPU** for new entity arrays | No new spatial query | `EntitySyncRouter` reuses the one `interestScratch` per (client,tick); routing is a profile read; structures ride the existing swarm interest pass. |
| **Lag-comp split erosion** | Projectile collision stays main-thread | OUT OF SCOPE every phase; only the dispatch tail collapses. |
| **Behaviour drift during collapse** | Phases 1/2 behaviour-preserving | `interactionDispatch` golden-master written before the if-tree is deleted (test-first). |
| **V8 megamorphism** | Monomorphic `receiveInteraction` call site | Concrete base method + composed `HealthBinding`/`DeathPolicy`; bench under ramming + projectile load. |

---

## Verification

- **Inner loop (every phase):** `pnpm typecheck && pnpm lint && pnpm test` + `timeout 8 pnpm dev:server`.
- **New unit tests:** `EntityKindRegistry`, per-leaf `receiveInteraction` field-parity, `Weapon.resolveHit`,
  `entitySyncRouting` transport-routing + byte-identity, generalized `entityFactory`.
- **Integration (new visible entity mandate):** `tests/integration/sectorRoom/structureEntity` drives the
  full snapshot path (visible + updating + damageable); per-leaf `receiveInteraction` parity vs the old
  routers.
- **E2E:** `structure-visible-damageable.spec.ts` (decode→factory→render→predWorld hit, per invariant #13).
- **Netcode (Phases 2–4):** `pnpm e2e:netgate` baseline-relative-green (invariant #8) — guards
  `rollingCorrRate`/`ticksAhead`/`maxDriftUnits`/`meanDriftUnits`/`droppedSnapshotsRecent`.
- **Bench (Phase 2+):** `pnpm bench` — `receiveInteraction` megamorphism check + zero new hot-loop alloc.
- **CLAUDE.md currency (inv. #7/#10):** update `src/core/CLAUDE.md` (new contracts), `src/server/CLAUDE.md`
  (Combat Architecture — interaction collapse; new kind byte), `src/client/CLAUDE.md` (entity factory +
  generalized pose seam); add `docs/architecture/generic-entity-pipeline.md`.

---

## Source-of-truth references (verified during planning)

- Four dispatch sites: `DamageRouter.ts:109-282`, `ProjectilePipeline.ts:142-230`,
  `MissileSimulation.ts:258-685`, `ShieldHullRouter.ts:92-221`.
- Pose-core wire + kind-byte extension precedent: `src/shared-types/swarmWireFormat.ts`
  (`SWARM_KIND_ASTEROID=0`/`SWARM_KIND_DRONE=1`; `SWARM_RECORD_FLAG_SHIELD_DOWN` spare-bit note).
- One-pose-per-frame seam: `src/client/net/swarmDisplayPose.ts` (`resolveDroneDisplayPose`).
- predWorld registration ritual + sprite decision module: `src/client/CLAUDE.md` ("Every collidable entity
  must be in predWorld"; `spriteUpdateDecisions.ts`).
- New-visible-entity test mandate: `src/server/CLAUDE.md` ("When introducing a new visible entity type").
- Pure combat logic to reuse: `src/core/combat/ShieldHull.ts:80-116`, `src/core/combat/Ramming.ts:61-86`.
