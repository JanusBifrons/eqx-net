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

The persistent galaxy lives at [galaxy/galaxy.ts](galaxy/galaxy.ts) — a pure module exporting `GALAXY_SECTORS` (a 7-sector hexagonal sunflower: Sol Prime centre + 6 outers). Both the server (room registration in `index.ts`, neighbour validation) and the client (visual landing screen, in-game galaxy-map overlay) consume this. Pure: no I/O, no imports outside the TS stdlib. The unit test [galaxy/galaxy.test.ts](galaxy/galaxy.test.ts) enforces structural invariants (edge symmetry, no dangling neighbours, exactly 6 ring outers at hex distance 1 from the centre); a typo in `neighbours` will fail the test before merge. To grow the galaxy, extend `GALAXY_SECTORS` with valid axial-hex coords and symmetric edges. See [docs/architecture/galaxy-graph.md](../../docs/architecture/galaxy-graph.md) for the walkthrough.

When a new phase needs a new concretion (e.g., persistence), add it as a new contract here — never by reaching from core into the server or client zones.

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
- **`CONTACT_BATCH { tick, contacts: Contact[] }`** — emitted per tick when Rapier's `EventQueue` produced contact-force events above `CONTACT_FORCE_FLOOR` (Stage 2 of the network-feel roadmap). Each `Contact` carries `{ aId, bId, vAxPost, vAyPost, vBxPost, vByPost, forceMagnitude }`. The main thread re-emits each as `COLLISION_RESOLVED` on the Bus and broadcasts a `collision_resolved` network message. Skipped (no message) when the tick produced no qualifying contacts.

Adding a fourth variant: extend the worker's `parentPort!.postMessage` site, the SectorRoom message handler's discriminator (`msg.type`), and update this list. The main→worker direction has its own discriminated union (`WorkerCommand`); the reverse direction is informally typed because the message handler does explicit type narrowing on receive.

**Main → Worker commands (current set):** `SPAWN`, `DESPAWN`, `INPUT`, `SPAWN_OBSTACLE`, `AI_INTENT`, `CLOCK_RATE`, `SET_POSITION`, `REKEY_SHIP`, `SET_HULL_EXPOSED`. `SET_HULL_EXPOSED { id, exposed, kindId, tick }` (shield/hull refactor) swaps a body between its cheap circle collider and its exact hull-polygon compound on the shield 0-cross; `kindId` is carried in the command (server-authoritative — no worker-side kind map). The authoritative list is the `WorkerCommand` union + the header docstring in [physics/worker.ts](physics/worker.ts); keep all three (worker union, `SectorRoom.WorkerCmd`, this note) in sync.

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

See [docs/architecture/weapon-mounts.md](../../docs/architecture/weapon-mounts.md) for the full call-graph and the "do not add a second correction path" rule.

## AI lockstep — Input Symmetry Rule (chapter 2, 2026-05-09)

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

## Rapier `castRay` API (Phase 4 — do not look these up again)

- `world.castRay(ray, maxDist, solid, filter, filterMask, filterGroups, filterExcludeRigidBody)` — the exclude parameter takes a `RigidBody` object (from `bodies.get(id)`), not a handle number.
- `hit.collider` is already a `Collider` object; do NOT wrap it in `world.getCollider()` (that takes a number).
- `hit.timeOfImpact` — there is no `hit.toi` property.
- **Query pipeline lag**: `castRay` queries the Rapier broadphase/narrowphase, which is only updated inside `world.step()`. Bodies spawned after the last `step()` are invisible to `castRay`. In unit tests, call `world.tick(1/60)` in `beforeEach` after spawning bodies, before any hitscan calls.

---

## What belongs in src/core

- Pure simulation: physics, AI behaviour trees, combat math, reconciliation.
- Event bus definition.
- DI contracts.
- Shared math utilities.
- Deterministic state machines (e.g., Phase 8 `TransitStateMachine`).
- Combat constants and pure geometry helpers (`src/core/combat/Weapons.ts`): `HITSCAN_DAMAGE`, `PROJECTILE_DAMAGE`, `HITSCAN_RANGE`, `PROJECTILE_SPEED`, `WEAPON_COOLDOWN_TICKS`, `rayHitsSphere()`. These constants are now **derived** from the data-driven catalogue — see below.
- Weapon catalogue (`src/core/combat/WeaponCatalogue.ts`): the single source of truth for weapon definitions. Each entry is a discriminated `WeaponDef = HitscanWeaponDef | ProjectileWeaponDef` describing damage, cooldown, and mode-specific params (range for hitscan; speed/radius/maxTicks for projectile). Lookup via `getWeapon(id)`. The catalogue is **append-only and pure** — no DI, no I/O. Adding a new weapon = adding a record + listing its id in `WEAPON_IDS`. The server resolves a `WeaponDef` per fire and parameterises `spawnServerProjectile` from it; the client uses the same lookup for ghost spawn speed and the renderer-side bolt visual. **Do not branch on weapon id in `src/core` paths** — read fields off the `WeaponDef` instead. The Open/Closed boundary is the catalogue, not a switch statement.

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
- `src/core/geometry/triangulate.ts` ear-clips ship polygons
  deterministically (`+ - * /` + cross-sign only, fixed ear order →
  bit-identical Node↔Chromium). Per-kind triangles precomputed once at
  module load — never per-tick/per-break.
- `World.setHullExposed`: ALL ship/drone colliders are density 0; mass
  is a pinned `setAdditionalMassProperties`. `recomputeMassProperties-
  FromColliders()` IS called after every collider change and is
  REQUIRED + safe (it folds in the additional props; "FromColliders" is
  a misnomer — see rapier2d-compat rigid_body.d.ts:377/395). The new
  geometry lags one `world.step()` for queries — never `updateScene-
  Queries()` (diverges from client predWorld).
- Full internals + the feel-test-lockstep env-noise caveat:
  [docs/architecture/collision-layers.md](../../docs/architecture/collision-layers.md).
