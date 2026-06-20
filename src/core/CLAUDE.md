# CLAUDE.md — src/core (The Blind Simulation Zone)

`src/core` is the **blind** zone: it knows about physics, events, and pure logic, and nothing else. It has no idea whether it is running on a server, in a browser, or in a worker thread. That blindness is what lets the same code run authoritatively on the server and predictively on the client.

Start here before editing anything under `src/core/`. The root [CLAUDE.md](../../CLAUDE.md) covers project-wide invariants.

---

## Forbidden Imports (CI-enforced)

Never import any of these from inside `src/core/`:

- UI / rendering: `pixi.js`, `pixi.js/*`, `pixi-viewport`, `react`, `react-dom`, `@mui/*`, `@emotion/*`, `howler`, `zustand`
- Networking concretions: `colyseus`, `colyseus.js`
- Persistence: `better-sqlite3`
- HTTP: `express`, `pino`, `node:http`, `node:https`, `http`, `https`
- Filesystem: `node:fs`, `fs`
- Anything under `src/server/**` or `src/client/**`

The allowed runtime libs are: `@dimforge/rapier2d-compat`, `eventemitter3`, `zod` (types), plus the TS stdlib.

The canary at [\_\_fixtures\_\_/leak.ts.disabled](__fixtures__/leak.ts.disabled) exists to prove the rule is live. If you ever find yourself weakening the forbidden list in `eslint.config.js`, stop — you are breaking the "no web leaks" guarantee that the whole architecture depends on.

---

## Dependency Inversion — The Contracts Catalogue

`src/core` never instantiates a renderer, audio sink, network sink, or persistence handle. Instead, it declares interfaces in `src/core/contracts/` and accepts implementations via constructor injection.

### Current contracts (grows as phases land)

- `IRenderer` — the draw surface. Phase 1 introduces this.
- `IAudio` — the sound surface. Phase 4/6 hydrate this.
- `INetworkSink` — the outbound network surface. Phase 1 introduces this.
- `IPersistenceSink` — the persistence surface. Phase 7 introduces this. Op union is closed-set; CRITICAL/VOLATILE lanes; concretion in `src/server/db/`.

### Galaxy graph (Phase 8)

The persistent galaxy lives at [galaxy/galaxy.ts](galaxy/galaxy.ts) — a pure module exporting `GALAXY_SECTORS` (Living Galaxy P1: a ~21-sector galaxy — a home **core** region plus 3 **frontier regions** _Verdant Reach / Crimson Expanse / Azure Deep_, each reachable from the core through a single **chokepoint** gateway; replaced the 7-sector sunflower). Each `GalaxySector` carries a `region` (== faction id; **cosmetic/static v1**, capable of real ownership later) and a static `features` list (map glyphs: `asteroid|nebula|minerals|blackhole|station`). `GALAXY_FACTIONS` is the id→`displayName` registry; `ENTRY_SECTOR_KEYS` is the **baked** drone-warp-in edge set (was max-hex-distance-derived — wrong for a multi-region shape; `getEntrySectors()`/`isEntrySector()` now read the baked set, signatures UNCHANGED so `population.ts` + the director are untouched). **The `GALAXY_SECTORS` / `GALAXY_FACTIONS` / `ENTRY_SECTOR_KEYS` literals are GENERATED** by [scripts/generate-galaxy.ts](../../scripts/generate-galaxy.ts) (`pnpm tsx scripts/generate-galaxy.ts > src/core/galaxy/galaxy.ts`), which validates every invariant at bake time — do NOT hand-edit them (edit the spec in the generator + re-run); the types + helper functions are hand-maintained. Both the server (room registration in `index.ts`, neighbour validation) and the client (galaxy map) consume this. Pure: no I/O, no imports outside the TS stdlib. The unit test [galaxy/galaxy.test.ts](galaxy/galaxy.test.ts) enforces the structural invariants (edge symmetry, no dangling neighbours, connected graph, **each faction graph-contiguous** — load-bearing for the P4 contiguous-territory hover-shrink — **exactly one chokepoint edge per frontier region**, ≥1 entry sector per region, never the core, all 7 legacy keys preserved as persistence identities). See [docs/architecture/galaxy-graph.md](../../docs/architecture/galaxy-graph.md) and [docs/architecture/living-galaxy.md](../../docs/architecture/living-galaxy.md).

When a new phase needs a new concretion (e.g., persistence), add it as a new contract here — never by reaching from core into the server or client zones.

### Generic Entity Pipeline contracts (2026-06-04)

`src/core/entity/` + the `IDamageable` / `INetworkSynced` / `IRenderContributor` contracts make a new world-object type "a leaf + a descriptor". The append-only `EntityKindRegistry` ([entity/EntityKindRegistry.ts](entity/EntityKindRegistry.ts)) maps each `EntityKindTag` → its sync + render + damageable descriptors; `IDamageable` declares the zone-pure damage surface (`HealthBinding` — a stateless per-kind accessor over the live store, NEVER a value copy, + the reused `Interaction`/`InteractionResultMut`). The kind-specific orchestration (broadcast/bus/worker side-effects) is a SERVER concern: the leaf classes in `src/server/entity/leaves/` (`ShipEntity` / `DroneEntity` / `StructureEntity`) implement `Entity` and COMPOSE these contracts as data; `DamageRouter` routes a hit via `EntityResolver` → the leaf → one monomorphic `applyInteraction` (HC#5 — never a per-class virtual `receiveInteraction`). Core stays blind to the wire. `Entity` is a SEPARATE type from `AiEntity` (`IAiBehaviour.ts`) — don't conflate. Kinds + pose-core bytes are append-only (mirrors invariant #11). Full story: [docs/architecture/generic-entity-pipeline.md](../../docs/architecture/generic-entity-pipeline.md).

---

## Event Bus Rules (core owns the bus)

- The bus lives at `src/core/events/Bus.ts` as a strongly-typed `eventemitter3` facade.
- All event variants live in a single discriminated union. Adding one = adding a variant.
- **Discrete events only.** Never add `POSITION_UPDATED`, `VELOCITY_CHANGED`, `TICK_ADVANCED`, or anything per-frame. Continuous data flows via polling, not emits.
- If you are tempted to emit in a tight loop, stop — use direct state mutation / SAB writes.

---

## Physics Rules

- `world.step(1/60)` inside a `while (accumulator >= fixedDt)` accumulator loop. No variable-dt stepping, ever.
- Rapier bodies / colliders are pooled; do not allocate per-tick.
- Sleep callbacks are meaningful: Phase 5 uses them to drive `ENTITY_SLEPT` / `ENTITY_WOKE` — do not suppress or re-enter them without thinking about the handshake.
- **Drone bodies get per-kind `linearDamping`; asteroids/structures stay ballistic (WS-11 / R2.25, 2026-06-12).** `World.spawnObstacle(..., linearDamping = 0)` takes a per-spawn damping. `SwarmSpawner.spawnOne` passes `shipKind.linearDamping` for DRONES (kind 1) — exactly like `spawnShip` (World.ts:152) — and `0` for ASTEROIDS (kind 0) + STRUCTURES (kind 2). Threaded through `SPAWN_OBSTACLE` (worker.ts cmd + `PhysicsWorkerProxy.WorkerCmd`). WHY: drones move via the AI `applyImpulse` path, which BYPASSES the player's `applyShipInput` max-speed clamp + grip; with damping 0 a drone that overshoot its target coasted away at constant velocity FOREVER (the standoff brake at `HostileDroneBehaviour.ts:498` goes to thrust=0 once `closingSpeed` flips negative, and nothing dissipated the residual speed) — the "flies past / floats / never approaches" bug. The damping VALUE is the kind's own catalogue field (not a guessed constant). The CLIENT predWorld drone body (same spawn path) is a kinematic follower of the interpolated snapshot pose, so its damping is inert — only the authoritative server body moves drones. 🔴 netgate (drone motion → snapshot). Locks: `World.test.ts` (a body with damping sheds coasting velocity; damping 0 coasts) + `SwarmSpawner.test.ts` (drone → kind damping, asteroid → 0). **Candidate value pending on-device feel sign-off (the user bundled it knowingly).**
- **STRUCTURES (kind 2) are LOCKED on spawn — immovable (P3.10, 2026-06-13).** "ballistic" above is now moot for structures: `SwarmSpawner.spawnOne` flags kind-2 spawns `staticBody`, threaded through `SPAWN_OBSTACLE` (worker.ts cmd + `PhysicsWorkerProxy.WorkerCmd`) so the worker calls `physics.lockBody(obstacleId)` after spawn — mirroring the client predWorld, which already did `spawnObstacle` + `lockBody` for structures (`structureClientLeaf`). WHY: the authoritative structure body lived UNLOCKED in the worker, so a ram (or the WS-1 mass-differential impulse) imparted velocity and the damping-0 body coasted away FOREVER — the "I hit a pylon and it started MOVING" bug. A locked body still blocks dynamic bodies (the ship bounces off it; `structure-ram-blocked.spec.ts`) and keeps its dynamic MASS, so the ram-damage model is unchanged — it just can't be translated. Drones + asteroids stay dynamic (drones fly; asteroids are bump-able, R2.33). 🔴 netgate (body lifecycle on the snapshot path). Locks: `SwarmSpawner.test.ts` (kind 2 → `staticBody:true`, drone/asteroid falsy) + `World.test.ts` (a locked obstacle holds position when rammed, an unlocked one is shoved) + `structure-ram-blocked.spec.ts` (rendered structure drift ≈ 0 under a ram).
- **Stiff contact resolution (2026-05-28).** `PhysicsWorld.create` sets `world.integrationParameters.numSolverIterations = 16` (default 4) and calls `switchToSmallStepsPgsSolver()` BEFORE returning. Rapier 2D defaults (`contact_erp = 0.2`, `numSolverIterations = 4`) are tuned for general gameplay and let a ship's continuous-thrust impulse press a ball collider 50-160 u into a polygon edge (capture `2026-05-28T15-13-11Z-vqm6y1` — the "I flew half-way into the drone" symptom). The stiffer params drive steady-state penetration to < 5 u median / < 30 u peak. The regression lock is [`tests/e2e/ramming-probe-armpit.spec.ts`](../../tests/e2e/ramming-probe-armpit.spec.ts) — flies a fighter into an L-shape engineering chassis at full thrust and asserts body-local penetration into the L's polygon arms. **Do NOT revert these to Rapier defaults without measuring the ramming probe** — the failing test will catch a regression but only on the ramming scenario; other gameplay surfaces (drone-drone contact, projectile-ship hit) still tolerate the looser defaults but feel WORSE under continuous force, which the user reports as "the ship goes inside the drone."

---

## Physics Worker — Input Queue Contract

Per-slot input handling lives in [physics/inputQueue.ts](physics/inputQueue.ts) and is invoked once per slot per physics step from [physics/worker.ts](physics/worker.ts). The contract has three equally-load-bearing rules:

1. **Tick-gated dequeue. Queue non-empty AND `head.tick ≤ currentTick` → dequeue head, apply, advance ack to `max(message.tick, prior ack)`.** The gate is the structural alignment: the client locally applies input I_X at clientTick X to produce state s_(X+1); the server must apply I_X at simTick X to produce its own s_(X+1) so reconciliation converges. Pre-2026-05-09 the queue drained greedily without the gate, and a client predicting forward (claimedTick > simTick at receive time) saw its inputs applied early — every snapshot reported `ackedTick > serverTick` and drift accumulated at ~10 u per snapshot. Stale claims (`head.tick < currentTick`, e.g. a delayed retransmit) are still drained — the input is better applied late than dropped, and out-of-order ack regression is already prevented by the `max()` clause.
2. **Queue non-empty BUT `head.tick > currentTick` → hold (treat as queue-empty).** The future-claim input stays queued until sim tick catches up. The slot continues on the held input via rule #3.
3. **Queue empty (or gated above) + held input present → re-apply held AND advance ack by 1.** The ack synthesises an "implicit re-send" matching what the throttled client (`INPUT_HEARTBEAT_MS` in `ColyseusClient.tickPhysics()`) would have sent at that tick under the old send-every-tick model.

Rule #3 is what newcomers will be tempted to "fix" by leaving the ack pinned to the last received message — don't. The original code did exactly that, with the comment `// Don't update appliedTicks — ackedTick stays at last-dequeued tick.`. It worked because the client used to send every tick, so the held branch never fired in practice. Once client-side input throttling landed (network-discipline P4), the held branch fires for ~94 % of ticks while a key is held, and a stale `ackedTick` causes the client's reconciler to **double-apply** every input the worker has just silently re-held — see [docs/LESSONS.md](../../docs/LESSONS.md) (2026-05-06).

Rule #1's gate is the 2026-05-09 fix. Without it, reconcile vs replay diverges by exactly one input application worth of velocity (~10 u of position) on every snapshot whose `ackedTick` exceeds `serverTick`. If you find yourself wanting to "drain greedily for lower latency," remember: the application latency cost (~RTT/2 ticks of held input on the server) is exactly what client-side prediction is buffering against, so the round-trip cost is zero — but skipping the gate breaks reconciliation alignment, which is much worse than a few ticks of authoritative-side latency.

Test coverage at [physics/inputQueue.test.ts](physics/inputQueue.test.ts) locks all three rules in. If the held-ack-advance rule is reverted, the "advances ack across many held ticks" assertion fails. If the tick gate is removed, the "holds dequeue when head.tick > currentTick" and "steady state: ack tracks currentTick" assertions fail.

---

## SimulationClock (Phase 6 — TiDi)

- Lives at `src/core/clock/SimulationClock.ts`. Pure: no I/O, takes only an optional `Bus` for `TIDI_RATE_CHANGED` emits.
- `rate ∈ [0.7, 1.0]`. The server constructs and owns the clock; `src/core` never instantiates it (DI invariant #5).
- The worker reads the rate from the SAB header (`CLOCK_RATE_IDX`) at the start of each tick and scales the **accumulator input** — `physics.tick(FIXED_DT * rate)` — NOT Rapier's per-step dt. Scaling Rapier's dt would change collision behaviour; scaling the accumulator keeps every step deterministic and just makes some wall-clock ticks step zero times.
- Bus emits `TIDI_RATE_CHANGED` only when the rate moves at least `RAMP_PER_TICK` since the last emit, so the bus isn't spammed with sub-epsilon noise.
- Phase 6 bus variants: `TIDI_RATE_CHANGED` (rate ramp), `ENTITY_SHED` (LoadShedder evicted a far drone — distinct from `ENTITY_DESTROYED` so persistence/telemetry can distinguish "killed in combat" from "evicted for budget").

---

## Physics Worker — Worker→Main Message Variants

The worker posts three discrete message types to the main thread:

- **`READY`** — emitted once at boot after Rapier init completes. The main-thread `SectorRoom` resolves its `start()` promise on this.
- **`SLEEP_TRANSITION { entityId, sleeping, tick }`** — emitted whenever a body's effective sleep state crosses the `SLEEP_HYSTERESIS_TICKS` boundary (Phase 5). The main thread re-emits as `ENTITY_SLEPT` / `ENTITY_WOKE` on the local Bus.
- **`CONTACT_BATCH { tick, contacts: Contact[] }`** — emitted per tick when Rapier's `EventQueue` produced contact-force events above `CONTACT_FORCE_FLOOR` (Stage 2 of the network-feel roadmap). Each `Contact` carries `{ aId, bId, vAxPost, vAyPost, vBxPost, vByPost, forceMagnitude, impactSpeed?, aMass?, bMass? }`. `impactSpeed` (2026-06-07) is the closing speed at impact — magnitude of the relative velocity from the bodies' PRE-step velocities (the worker keeps a `prevVel` snapshot = last tick's post-step velocities and passes it to `drainContacts`). `aMass`/`bMass` (2026-06-12, WS-1/R2.31) are the folded Rapier body masses (`World.getBodyMass`, read alloc-free in `drainContacts`) — the input to the ASYMMETRIC mass-differential ramming model (`core/combat/Ramming.ts` `aggregateRamming` → `ramDamageTo` = `RAM_DAMAGE_MAX × ramSpeedFactor(closing)² × ramMassDifferentialFactor(mSelf, mOther)`): a collision below `RAM_MIN_IMPACT_SPEED` deals 0 (slow tap is free), and damage needs BOTH a high closing speed AND a large mass gap — the lighter body is crushed, the heavier takes ~0, equal masses deal nothing (`RamPair.damageA`/`damageB` per side). Post-step velocity is NOT a usable impact measure (a ship that head-on-stops against a static structure has `vPost≈0` yet a hard impact). The main thread re-emits each as `COLLISION_RESOLVED` on the Bus and broadcasts a `collision_resolved` network message. Skipped (no message) when the tick produced no qualifying contacts.

Adding a fourth variant: extend the worker's `parentPort!.postMessage` site, the SectorRoom message handler's discriminator (`msg.type`), and update this list. The main→worker direction has its own discriminated union (`WorkerCommand`); the reverse direction is informally typed because the message handler does explicit type narrowing on receive.

**Main → Worker commands (current set):** `SPAWN`, `DESPAWN`, `INPUT`, `SPAWN_OBSTACLE`, `AI_INTENT`, `CLOCK_RATE`, `SET_POSITION`, `REKEY_SHIP`, `SET_HULL_EXPOSED`, `SET_STAT_MUL`, `MISSILE_IMPULSE`, `SPAWN_WALL`, `SET_WALL_ACTIVE`, `REMOVE_WALL`. `SET_HULL_EXPOSED { id, exposed, kindId, tick }` (shield/hull refactor) swaps a body between its cheap circle collider and its exact hull-polygon compound on the shield 0-cross; `kindId` is carried in the command (server-authoritative — no worker-side kind map). `SET_STAT_MUL { id, topSpeed?, turnRate? }` (Equinox Phase 4 WS-B2) sets a ship instance's per-instance PHYSICS stat multipliers on its worker body so `applyShipInput` scales movement by the upgraded factors; both undefined ⇒ reset. The client predWorld runs the SAME `World.setStatMultipliers` directly, so prediction stays in lockstep (risk #1). `SPAWN_WALL { id, ax, ay, bx, by, thickness }` / `SET_WALL_ACTIVE { id, active }` / `REMOVE_WALL { id }` (shield-fence plan) manage a **shield-wall span** — a STATIC cuboid between two pylon poses that blocks ships; `SET_WALL_ACTIVE` toggles its collider (`setEnabled`) on stun / power loss without churning the body. The wall is NOT a swarm entity (no SAB slot) — it's a derived collider; the same `PhysicsWorld.spawnWall` runs in the client predWorld so local-player blocking is predicted. The authoritative list is the `WorkerCommand` union + the header docstring in [physics/worker.ts](physics/worker.ts); keep all three (worker union, `SectorRoom.WorkerCmd`, this note) in sync.

## WeaponMountController contract (Phase 4, 2026-05-11)

Pure module at [src/core/ai/WeaponMountController.ts](ai/WeaponMountController.ts) — zero zone awareness, zero I/O, zero allocation in the hot path. Same inputs ⇒ same outputs on server and client (the foundation of mount-angle lockstep).

**Exports:**

- `pickTarget(shipX, shipY, targets, prevTargetId, isHostile, options?)` — sticky target picking. Iterates `targets`; nearest hostile within `options.maxDistance` wins UNLESS the previous target is within `STICKY_HYSTERESIS_FACTOR * d(nearest)`. Returns `MountTargetView | null`.
- `rotateMountToward(currentMountAngle, desiredBearing, mount, dtSec)` — clamp the target into `[arcMin, arcMax]`, then slew toward it by at most `rotationSpeed * dtSec` per call. Returns the new mount angle, ship-relative, arc-local (`0` = barrel at rest).
- `wrapPi`, `clampToArc` — primitives exposed for tests / future composition.

**Lockstep determinism rules:**

1. **Tie-break by iteration order.** When two hostiles are exactly equidistant, the one appearing first in `targets` wins (`<` comparison rejects ties). Server and client MUST iterate `targets` in the same order. The upstream AI controller is responsible.
2. **Per-instance state owned by the caller.** `prevTargetId` lives on the caller (drone behaviour, player slot). Not in the controller. Reset purely by `markHostile`/`purgeHostility`/time-decay — both sides fire these symmetrically.
3. **Hostility filter is `(id) => boolean`.** Drone callers pass `id => hostileTo.has(id)`. Player turret callers pass `id => id.startsWith('swarm-')` (any drone hostile to the player). Same filter semantics on both sides; never read from a per-side data source that diverges.

**Sticky hysteresis factor** (`STICKY_HYSTERESIS_FACTOR = 1.1`) — keep the previous target while it's within 10 % distance of the nearest alternative. Below this, swarm-density edges cause flapping; above, the player feels the turret "miss obvious closer targets". 1.1 is the empirical sweet spot from drone-AI sticky-targeting smoke tests.

If you find yourself adding a "smarter" target-pick policy (lead-aim, predicted closing rate, threat tier), do it BY EXTENDING `MountTargetView` and `PickTargetOptions` — not by reaching into the call sites. The pure-module contract is what makes lockstep auditable.

**Smarter selection (Part C, weapon-autofire-boost-mechanics).** `pickTarget` was extended (per the rule above — fields, not call-site branches) with: `healthWeight` (score `= d²·(1 + w·health/maxHealth)`, biasing toward low-HP targets — "finish the wounded"), `switchMargin` (commitment in score space — resists target-flapping; default `stickyHysteresisFactor²` ⇒ byte-identical to the old squared-distance hysteresis), `dwellTicks`/`ticksSincePrevTarget` (hard switch-DELAY, server-AI only — deterministic server tick), and a per-target `hostile?` field that, when defined, OVERRIDES the `isHostile(id)` callback. **The `hostile` flag is the single-viewer alloc-free path** (the client's local player carries hostility on each `LocalAimTarget`); the per-viewer callback stays for the server (hostility is per-player). Both yield the same boolean for the same (target, viewer), so client/server picks stay in lockstep. **Absent options ⇒ behaviour is byte-identical to pre-Part-C** (locked by `WeaponMountController.test.ts`). Shared player-aim tuning lives in `PLAYER_AIM_HEALTH_WEIGHT` / `PLAYER_AIM_SWITCH_MARGIN` (exported) — the client `tickLocalMountAim` and the server `WeaponMountTicker.tickPlayer` MUST pass identical options (mount-angle lockstep, Invariant #12). The drone-AI body target (`HostileDroneBehaviour`) uses `healthWeight` + a real `dwellTicks` (server-only). Player health-weighting needs drone HP on the client — synced via the slim `SnapshotMessage.drones[].hp` percent (Part C3).

**`AiController` pending-hostility buffer (Part C).** `markHostile` for a not-yet-registered entity is now BUFFERED and applied on `register` (cleared by `unregister`/`purgeHostility`/`clear`). Fixes the `startHostile`-at-join / aggro-before-interest race where client hostility was silently dropped (the `bot_aggro` arrived before the client's first swarm packet registered the drone). Server-side it's inert (drones register at spawn before any `markHostile`), so the live loop is byte-identical.

See [docs/architecture/weapon-mounts.md](../../docs/architecture/weapon-mounts.md) for the full call-graph and the "do not add a second correction path" rule, and [docs/features/auto-fire-and-boost.md](../../docs/features/auto-fire-and-boost.md) for the player-facing behaviour.

## AI lockstep — Input Symmetry Rule (chapter 2, 2026-05-09)

> **⚠️ SUPERSEDED FOR DRONES (2026-05-18, drone-snapshot-interpolation
> pivot).** The client no longer runs `AiController`/`HostileDroneBehaviour`
> for drones at all — drones are pure snapshot-interpolated from the
> binary wire (see [docs/architecture/drone-snapshot-interpolation.md](../../docs/architecture/drone-snapshot-interpolation.md)).
> The Input-Symmetry Rule below is therefore **moot for drones** (there is
> no client drone brain whose inputs could diverge) but remains the
> governing principle for any *future* shared client/server brain and for
> the `damage`/`bot_aggro` → `markHostile` server→client mirror (the
> surviving hostility ledger). **The "Corollary — replay re-sim is
> relevance-CULLED (Option A)" section below is fully RETIRED**: the
> replay re-sim, `droneRelevance.ts`, `DRONE_RESIM_BUDGET`,
> `AiController.tickOnly`, and the `replaySeed` drone anchor were all
> deleted. `AiController.tick` is now server-authoritative-only. Player
> prediction is unaffected by all of this.

`src/core/ai/HostileDroneBehaviour.tick(self, view)` is pure: same arguments produce the same `(fx, fy, torque)` impulse on both sides. The same instance of this code runs on the server (under `AiController` in `SectorRoom`) and on the client (under the same `AiController` in `ColyseusClient`). The brain is shared; for client-side prediction to match server reality, **the brain's sensory inputs must match too**.

**The rule**: any field consumed by `IAiBehaviour` MUST flow on the same channel and at the same cadence on both sides. Adding a behaviour-visible field requires a wire-format bump, not "we'll wire it up later." The 2026-05-09 chapter-2 work shipped wire-format v3 specifically to add `angvel` after discovering the AI's `1.5·ω` damping term was reading SAB-authoritative ω on the server and unsynced predWorld ω on the client — drone bearing diverged every tick because of one missing field.

**Concrete inputs the AI reads, with where each must come from on each side:**

| field | server | client |
|---|---|---|
| `self.x, y, vx, vy, angle` | SAB at `SLOT_*_OFF` | predWorld via `setShipState` from snapshot's `drones[]` slice |
| `self.angvel` | SAB at `SLOT_ANGVEL_OFF` | **wire-format v3 carries it; `setShipState` propagates** |
| `view.players[].x, y, vx, vy` | `shipPoseCache` from SAB at `serverTick` | predWorld; remote ships are reset to `snap.states[remoteId]` pre-replay |
| `view.tick` | `serverTick` | `inputTick` (different reference frame; only used for fire cooldown) |
| `view.dtSec` | 1/60 | 1/60 |
| `kind` (per-drone tuning from catalogue) | catalogue lookup at register | catalogue lookup at register, with `entry.shipKind` from packet |

**The diagnostic signature when this rule is violated**: per-event metrics like `swarm_snap_diagnostics.snapDistance` get *worse* after a fix that "should help structurally," not better. That's the diagnostic for two-correction-paths-fighting (chapter 2 capture `2026-05-09T17-25-27-695Z-82ncsd` is the canonical example).

**One correction path per state surface**: don't run a second reset path on top of an existing one. Phase C added the snapshot drone anchor; the load-bearing follow-up (commit `d1e7ecf`) was to GATE the binary-packet `setShipState` path for in-snapshot drones so the two paths don't fight. See [docs/architecture/ai-lockstep.md](../../docs/architecture/ai-lockstep.md) for the full walkthrough.

The regression lock for this is [`tests/e2e/feel-test-lockstep.spec.ts`](../../tests/e2e/feel-test-lockstep.spec.ts) — its p50 thresholds will fail the moment a dual-correction-path bug reappears.

### Corollary — Living World "hunters" reuse `markHostile`, never a new behaviour (2026-05-16)

A Living World hunter bot is **just a drone made hostile to a player it
wasn't shot by** — it runs the *unchanged* `HostileDroneBehaviour`
`COMBAT` branch. The `LivingWorldDirector` drives the *existing*
`markHostile`/`purgeHostility` channel (server) and the server broadcasts
one discrete `bot_aggro` the client feeds into its own
`_aiController.markHostile` — the exact server→client twin of the proven
`damage`→`markHostile` mirror. **Do NOT add a `proactive` (or any new)
`HostileDroneBehaviour` branch, and do NOT add a per-drone behaviour flag
to the binary swarm wire.** Reason: the client constructs + ticks its own
`HostileDroneBehaviour` for in-interest drones, so a server-only
behaviour difference is exactly the dual-path divergence the Input
Symmetry Rule above forbids — whereas `markHostile` already fires
symmetrically on both sides, so hunting needs zero new lockstep surface
and zero `SWARM_WIRE_VERSION` bump. This was a deliberate design fork
(the rejected alternative — a `proactive` branch + a `drones[]`-slice
flag — is recorded in [docs/architecture/living-world.md](../../docs/architecture/living-world.md)).

### Corollary — replay re-sim is relevance-CULLED, and that is prediction-only (Option A, 2026-05-17)

Tick-accurate N-drone client lockstep is **intrinsically O(ticksAhead × N)**
— the per-replay-tick re-sim *is* the Phase C mechanism, not an accident
(48 ms at N=500/ticksAhead=48 → the 116–266 ms sector-change stall, diag
`a3f5na`). The fix ([`prediction/droneRelevance.ts`](prediction/droneRelevance.ts)
+ [`AiController.tickOnly`](ai/AiController.ts)) brain-re-sims only the NEAR
set (hostile / within `HITSCAN_RANGE×2` / recently large-corrected); the FAR
majority is **dead-reckoned, NOT frozen** — `replaySeed` re-anchors it and
the unfrozen replay `world.tick()` integrates it ballistically. Replay
*brain* cost → O(k × ticksAhead), k ≪ N. (Freezing FAR was tried and
reverted: it regressed the quiet-host canary `swarmSnapP50` 11→20; dead-reckon
→ 1.6, *better* than `main`. `Reconciler.ts`/`World.ts` stay identical to
`main` — no `freeze` param. See `docs/architecture/reconciler-replay-scaling.md`
§9.)

Two rules this must not break:

1. **Culling is CLIENT-PREDICTION-ONLY. The server's `AiController.tick`
   still ticks every drone authoritatively — `tickOnly` is a client-replay
   path only.** Never cull the server's authoritative tick to "match": that
   would change authority, not just prediction, and is exactly the
   server-only-divergence the Input Symmetry Rule forbids. Authority stays
   whole; only the client's *prediction fidelity* is spent selectively.
2. **The relevance predicate must read the same server-authoritative anchor
   the re-sim will read** (the snapshot `drones[]` pose / `replaySeed`), NOT
   a free-evolving predWorld pose — otherwise NEAR/FAR membership itself
   diverges from what the server would compute, reintroducing a
   per-side-divergent input. `partitionDronesByRelevance` takes the anchor
   pose for this reason; keep it that way.

`tickOnly` iterates the NEAR set, NEVER a predicate over the full registry
(a predicate-over-`tick` keeps the O(ticksAhead × N) scan even when it culls
the brain work — measured + rejected, `docs/LESSONS.md` 2026-05-17). This is
NOT a second correction path: the SAME `AiController` path advances NEAR
drones, only scoped.

**The cull is radius AND budget (2026-05-17, diag m6rq2t).** Radius alone
gives zero relief when the player is *inside* the bot pack (NEAR≈ALL) — the
progressive in-fight reconcile-cost spiral. `partitionDronesByRelevance`
also enforces a hard per-snapshot `DRONE_RESIM_BUDGET` (default 12): keep
only the K most-relevant (hostile → closest → id), demote the overflow to
FAR/dead-reckon, so per-snapshot brain cost is O(replayWindow × K), K
bounded regardless of pack size. Default-ON (unbounded in-pack re-sim *is*
the bug); byte-identical when NEAR ≤ K (steady-state + canary untouched).
Do NOT remove the budget to "re-sim more for accuracy" — that
reintroduces the spiral the 500-target cannot afford. Full story:
[docs/architecture/reconciler-replay-scaling.md](../../docs/architecture/reconciler-replay-scaling.md).

## Rapier `castRay` API (Phase 4 — do not look these up again)

- `world.castRay(ray, maxDist, solid, filter, filterMask, filterGroups, filterExcludeRigidBody)` — the exclude parameter takes a `RigidBody` object (from `bodies.get(id)`), not a handle number.
- `hit.collider` is already a `Collider` object; do NOT wrap it in `world.getCollider()` (that takes a number).
- `hit.timeOfImpact` — there is no `hit.toi` property.
- **Query pipeline lag**: `castRay` queries the Rapier broadphase/narrowphase, which is only updated inside `world.step()`. Bodies spawned after the last `step()` are invisible to `castRay`. In unit tests, call `world.tick(1/60)` in `beforeEach` after spawning bodies, before any hitscan calls.

---

## What belongs in src/core

- Pure simulation: physics, AI behaviour trees, combat math, reconciliation.
- AI steering + flocking + formation primitives (`src/core/ai/steering.ts`, `src/core/ai/flocking.ts`, `src/core/ai/formation.ts`): pure `arrive`/`seek` (heading + a thrust scale that ramps to 0 within a slow radius so per-kind damping brakes the body to a stop); **flocking/boids** (`flocking.ts`, 2026-06-18) — `addCohesion` (toward the leader, with an ARRIVAL ramp so the pull fades to 0 within `FLOCK_FOLLOW_DISTANCE` = "slow down once close")/`addAlignment`/`addSeparation` accumulate into a caller-owned `FlockAccumulator`, `resolveFlock` → unit dir + thrust scale (capped at 1 = calm cruise, NO boost), all alloc-free, the FEEL constants (`FLOCK_*`) exported; and wedge/line/column slot geometry (`formation.ts`, leader-frame rotation, ship-angle convention `(-sin θ, cos θ)` — now UNUSED, kept for a future rigid-formation mode). Scalar in / caller-owned out (alloc-free). The non-combat roaming squads use `flocking.ts` via `HostileDroneBehaviour.tickFlock` (leader-led herd at cruise; the leader THROTTLES/WAITS so followers tighten — no boost; squads spawn CLUSTERED so the herd is tight from birth); see `src/server/CLAUDE.md` "In-sector squad herding — leader + FLOCKING".
- Event bus definition.
- DI contracts.
- Shared math utilities.
- Deterministic state machines (e.g., Phase 8 `TransitStateMachine`).
- Ship XP curve (`src/core/leveling/shipXp.ts`, Equinox Phase 4 WS-B1): pure, zone-blind. `xpForKill(victimMaxHealth)` (round(maxHealth / `XP_PER_KILL_DIVISOR`), floored at 1 — tougher victim = more, D10), `xpToNext(level)` (round(`XP_CURVE_BASE` · level^1.5), `Infinity` at/above `LEVEL_CAP=10`), `applyKillXp(level, xp, gained)` → `{ level, xp, levelsGained }` (one level per threshold, remainder carried, pinned to 0 at cap). The server is the only authority that runs it (`SectorRoom.awardKillXp`), but it lives in core for testability + a future client preview. Tunables are exported balance knobs — adjust on-device, the architecture is unchanged. The matching discrete bus event is `SHIP_LEVEL_UP { shipInstanceId, newLevel }`. See [docs/architecture/leveling-and-upgrades.md](../../docs/architecture/leveling-and-upgrades.md).
- Ship stat upgrades (`src/core/leveling/shipStats.ts`, Equinox Phase 4 WS-B2): pure, zone-blind. The single source of the stat POOL (`STAT_IDS` = `hull|energy|damage|topSpeed|turnRate|shield`, append-only order — modal row order + persisted-`StatAlloc` keys), `STAT_POINT_FRAC` (5 %/point), `pointBudget(level) = level-1`, `isAllocValid(alloc, level)` (the SERVER's authoritative budget-can't-be-exceeded gate), and `deriveStatMultipliers(alloc) → ShipStatMultipliers` (empty/undefined ⇒ every factor 1, byte-identical to un-upgraded). **CRITICAL (risk #1): the PHYSICS pair (`topSpeed`/`turnRate`) feeds the ONE seam the per-tick movement clamps live — `applyShipInput(body, kind, input, mul?)`** (`topSpeed` scales `thrustImpulse` + the `maxSpeed` clamp; `turnRate` scales `maxAngvel`). `World.applyInput` reads the per-instance `mul` off the body record (`World.setStatMultipliers(id, mul)`); BOTH the server worker (`SET_STAT_MUL` cmd) and the client predWorld drive that ONE seam with multipliers derived identically — so prediction reconciliation stays clean (invariants #4/#12). Absent `mul` ⇒ factors of 1 ⇒ legacy callers byte-identical. The non-physics factors (`maxHull`/`energy`/`damage`/`shield`) are server-authoritative (damage/shield/energy calcs, NOT here). Locks: `shipStats.test.ts` (curve/budget/derivation), `applyShipInput.levelMultiplier.test.ts` (two independent `PhysicsWorld`s reach byte-identical velocity/turn under the same alloc). See [docs/architecture/leveling-and-upgrades.md](../../docs/architecture/leveling-and-upgrades.md).
- Structure leveling (`src/core/leveling/structureLevel.ts`, Equinox Phase 4 WS-B4): pure, zone-blind — the structure analogue of `shipStats.ts` but resource-cost driven (no XP). The single source of `STRUCTURE_LEVEL_CAP` (5), `STRUCTURE_LEVEL_FRAC` (0.25/level), `STRUCTURE_UPGRADE_COST_FRAC` (1.0), `canUpgradeStructure(level)` (the cap gate), `structureUpgradeCost(baseConstructionCost, level)` (escalating; 0 at the cap), `structureLevelMultipliers/Factor(level)` = `1 + (level-1)·FRAC` applied to the kind's KEY stats (maxHealth/weaponRange/weaponDamage/powerOutput; level 1 ⇒ every factor 1, byte-identical to un-upgraded), and `effectiveStructureMaxHealth(base, level)` (the ONE helper the server's HP seed AND the snapshot `hpPct` denominator share). The server is the only authority that reads it (`StructureGridSubsystem.upgradeStructure` + `tickTurrets` + `structureToGridNode` + `rebuildStructuresSlice`); it lives in core for testability + a future client preview. Tunables are exported balance knobs. Lock: `structureLevel.test.ts`. See [docs/architecture/leveling-and-upgrades.md](../../docs/architecture/leveling-and-upgrades.md).
- Structure power-grid logic (`src/core/structures/`, structures plan Phase 3): `Connection` (undirected intra-sector link), `Grid` (`canConnect` hub model + BFS components + A* routing + route cache), `structureGridConstants`. Zone-pure + injected — operates over an abstract `GridNode` view, never reaching into the server `StructureRegistry`. **Dead-end rule**: an unbuilt node is a transfer destination but NOT traversable (BFS/A* won't relay through a half-built node) — this is load-bearing for the construction flow economy's outward expansion. `Grid` exposes `componentMembers(id)` + `forEachComponent(cb)` (the iterate-a-whole-component primitive) for the battery pass + the shield-wall drain; `Grid.powerSummaryFor` stays **instantaneous/raw** (generation-only `powered`) so its golden tests hold — the battery-backed effective power lives in the server subsystem, not here. **Batteries** (`batteryPower.ts`, batteries plan): pure scalar `chargeStep` / `dischargeStep` / `drainPower` helpers; the server orchestrates which batteries charge/discharge per pulse. See [docs/architecture/structures-and-power-grid.md](../../docs/architecture/structures-and-power-grid.md).
- Combat constants and pure geometry helpers (`src/core/combat/Weapons.ts`): `HITSCAN_DAMAGE`, `PROJECTILE_DAMAGE`, `HITSCAN_RANGE`, `PROJECTILE_SPEED`, `WEAPON_COOLDOWN_TICKS`, `rayHitsSphere()`. These constants are now **derived** from the data-driven catalogue — see below.
- Energy pool math (`src/core/combat/Energy.ts`, weapons/energy/AI overhaul 2026-06-02): pure scalar helpers `spendEnergy` / `regenEnergyStep` / `canAfford` + `resolveSlotEnergyCost` (per-slot `energyCost` override wins, else MAX over the slot's mounts' weapon `energyCost` = drain-once-per-slot). **SHARED brain** (unlike `ShieldHull.ts`): energy is driven by the player's own fire/boost input, so the server owns the value and the client predicts via the SAME helpers (`ColyseusClient.predEnergy`). Allocation-free (scalar in/out, `mount.find` not array build) — safe in the per-tick hot loop. Drones are NOT energy-gated. `BOOST_TICK_COST` is the per-tick boost drain.
- Weapon catalogue (`src/core/combat/WeaponCatalogue.ts`): the single source of truth for weapon definitions. Each `WeaponDef` now also carries `energyCost` (per-slot-trigger). The data-driven loadout binds weapons to mounts (`mount.weaponId`); the server fires `getWeapon(mount.weaponId)` per barrel and IGNORES the client's claimed `weapon` field (see `PlayerFireResolver` / `AiFireResolver`). Each entry is a discriminated `WeaponDef = HitscanWeaponDef | ProjectileWeaponDef` describing damage, cooldown, and mode-specific params (range for hitscan; speed/radius/maxTicks for projectile). Lookup via `getWeapon(id)`. The catalogue is **append-only and pure** — no DI, no I/O. Adding a new weapon = adding a record + listing its id in `WEAPON_IDS`. The server resolves a `WeaponDef` per fire and parameterises `spawnServerProjectile` from it; the client uses the same lookup for ghost spawn speed and the renderer-side bolt visual. **Do not branch on weapon id in `src/core` paths** — read fields off the `WeaponDef` instead. The Open/Closed boundary is the catalogue, not a switch statement.
  - **Hitscan falloff is "optimal + beyond", LINEAR (Equinox laser issue, 2026-06-14; supersedes the P3.13 reverse-square, which itself superseded R2.29's taper-within-range).** A `HitscanWeaponDef.range` is the OPTIMAL range — FULL `damage` out to it. `falloff: { minDamageFrac, maxRangeMul }` adds a LINEAR fringe BEYOND optimal: the ray casts to `range × maxRangeMul` (the beam weapon: 250 → **325**; `maxRangeMul` tightened 1.5 → 1.3 so the beyond-optimal tail is short + clearly terminating, not the screen-edge-reaching "renders infinitely" beam) and `hitscanFalloffFrac(dist, optimalRange, maxRange, minDamageFrac)` scales damage LINEARLY from full at `range` to `minDamageFrac` at `maxRange`. The user chose linear over reverse-square: a constant fall per unit reads as a smooth, predictable taper that matches the visual beam taper (the reverse-square's convex "slow-then-cliff" felt like damage "drops to 0 instantly beyond range"). `maxRangeMul` absent/≤1 ⇒ flat full damage in range (back-compat). The aim-line + auto-fire still use `range` (optimal), so the guide stays at the reliable reach (no R2.14 regression); only the ray + damage extend. The curve is SERVER-AUTHORITATIVE — the `WeaponFireSink.hitscan(ctx, range, damage, falloffMinDamageFrac?, maxRange?)` 5th param threads maxRange into BOTH resolvers; the client reads the scaled damage off the `DamageEvent`, never predicts it. The matching CLIENT beam VISUAL taper draws solid to optimal then fades to nothing across optimal→maxRange (`BeamSpritePool`), so the visible taper == the damage band. 🔴 netgate (live combat path). Locks: `hitscanFalloff.test.ts` (full-to-optimal, LINEAR beyond — equal sub-bands drop equally), `weapons.test.ts` (maxRange threaded to the sink), `tests/e2e/laser-falloff-probe.spec.ts` (no-hit beam terminates + tapers, screenshot artefact).
- Weapon class hierarchy (`src/core/combat/weapons/`, GEP B3): the catalogue stays the pure DATA source; this layer wraps each `WeaponDef` in a stateless flyweight (`HitscanWeapon` / `ProjectileWeapon` / `MissileWeapon` over the `Weapon` base) that owns its per-mode FIRE DECISION via a virtual `resolveFire(ctx, sink)`. Both fire resolvers used to carry a duplicated `if (mode === 'projectile') … else hitscan` branch; both now collapse to one `getWeaponObject(mount.weaponId).resolveFire(ctx, this)` call (the resolver IS the `WeaponFireSink`). Fire is LOW-frequency, so the virtual dispatch is cheap + clarifying (UNLIKE the per-hit damage path, which stays monomorphic — HC#5). The server work (lag-comp sweep / spawn / `laser_fired` broadcast) lives behind the zone-pure `WeaponFireSink` abstraction, injected per resolver (so player-vs-AI hitscan differences live in the sink, not the weapon). Adding a weapon = a catalogue row (its `mode` picks the leaf in `weapons/index.ts`); no resolver edit. Parity locked by `weapons/weapons.test.ts`.

## What does NOT belong in src/core

- Anything that reads/writes files.
- Anything that knows about WebSockets.
- Anything that draws pixels or plays sound.
- Anything that calls React or MUI.
- Anything that depends on `performance.now()` vs `process.hrtime()` — abstract time via an injected clock.

## Shield/Hull collider model (2026-05-16)

- `src/core/combat/ShieldHull.ts` is **SERVER-AUTHORITY-ONLY** — unlike
  the shared `HostileDroneBehaviour` brain, the client must NEVER run
  its damage/regen functions (predicting the 0-cross flaps the collider
  every RTT). It lives in core only for testability; a banner says so.
- `src/core/geometry/shipHullDecomp.ts` decomposes each ship polygon
  into convex parts via `poly-decomp` (Bayazit's algorithm; MIT, ~3 KB,
  deterministic). Replaced the in-house ear-clipper (`triangulate.ts`)
  on 2026-05-28. Each part is convex by construction so `rayHitsConvex-
  Polygon` consumers (hitscan / projectile sweep) loop them directly.
  Per-kind parts precomputed once at module load — never per-tick.
- **`World.setHullExposed` emits `RAPIER.ColliderDesc.triangle` (NOT
  `convexHull`)** colliders, fan-triangulating each convex part from
  vertex 0. Why: in Rapier 2D, `convexHull` and `cuboid` shapes DO NOT
  fire `CONTACT_FORCE_EVENTS` for two interpenetrating bodies at zero
  closing velocity (positional-correction impulse ≠ contact force, even
  with threshold 0). Only `triangle` shapes emit events for static
  overlap. Stationary-ship collision telemetry and the
  `hull-collision-test` regression spec depend on this. The per-shape
  contact-event comparison is locked in
  `src/core/physics/hullCollisionNoTouch.test.ts` DIAGNOSTIC. If a
  future PR replaces triangles with `convexHull`, the diagnostic + the
  E2E positive-control will fail loudly.
- `World.setHullExposed`: ALL ship/drone colliders are density 0; mass
  is a pinned `setAdditionalMassProperties`. `recomputeMassProperties-
  FromColliders()` IS called after every collider change and is
  REQUIRED + safe (it folds in the additional props; "FromColliders" is
  a misnomer — see rapier2d-compat rigid_body.d.ts:377/395). The new
  geometry lags one `world.step()` for queries — never `updateScene-
  Queries()` (diverges from client predWorld).
- Full internals + the feel-test-lockstep env-noise caveat:
  [docs/architecture/collision-layers.md](../../docs/architecture/collision-layers.md).

## Composite ships + scrap geometry (2026-06-13)

- `ShipShape` is a discriminated union (`polygon | composite`). The
  `shipHullOutline(kind)` seam (`geometry/shipHullOutline.ts`) returns the
  composite `hull` or the polygon `points` — **every collision/physics reader
  goes through it**, so polygon kinds are byte-identical. The
  "silhouette == collider" invariant is RELAXED for composites: the collider is
  the authored gross `hull`; the visual `parts[]` are detail (per-part live
  collision is intentionally NOT modelled). `shipShapeScale` / `shipPrimaryColor`
  are the sibling accessors.
- `geometry/shipScrapGroups.ts` precomputes ONCE at module load (like
  `shipHullDecomp`) one scrap GROUP per composite component — a silhouette
  (`canScrap:true`) + its detail parts (role-prefix), each recentred on the
  component centroid, with a convex-hull collider. Polygon kinds → empty. The
  death→scrap path (server) and `buildScrapGfx` (client) both read it.
- `physics/collisionGroups.ts` `SCRAP_COLLISION_GROUPS` (membership bit 1 /
  filter ~bit 1) makes scrap NOT collide with other scrap but collide with
  everything else. Threaded through `World.spawnObstacle`'s optional
  `collisionGroups` param (→ worker `SPAWN_OBSTACLE`). `swarm/scrapConstants.ts`
  holds the tuning (burst/damping/HP/MAX_LIVE_SCRAP). Full story:
  [docs/architecture/composite-ships-and-scrap.md](../../docs/architecture/composite-ships-and-scrap.md).
