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

## SimulationClock (Phase 6 — TiDi)

- Lives at `src/core/clock/SimulationClock.ts`. Pure: no I/O, takes only an optional `Bus` for `TIDI_RATE_CHANGED` emits.
- `rate ∈ [0.7, 1.0]`. The server constructs and owns the clock; `src/core` never instantiates it (DI invariant #5).
- The worker reads the rate from the SAB header (`CLOCK_RATE_IDX`) at the start of each tick and scales the **accumulator input** — `physics.tick(FIXED_DT * rate)` — NOT Rapier's per-step dt. Scaling Rapier's dt would change collision behaviour; scaling the accumulator keeps every step deterministic and just makes some wall-clock ticks step zero times.
- Bus emits `TIDI_RATE_CHANGED` only when the rate moves at least `RAMP_PER_TICK` since the last emit, so the bus isn't spammed with sub-epsilon noise.
- Phase 6 bus variants: `TIDI_RATE_CHANGED` (rate ramp), `ENTITY_SHED` (LoadShedder evicted a far drone — distinct from `ENTITY_DESTROYED` so persistence/telemetry can distinguish "killed in combat" from "evicted for budget").

---

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
- Combat constants and pure geometry helpers (`src/core/combat/Weapons.ts`): `HITSCAN_DAMAGE`, `PROJECTILE_DAMAGE`, `HITSCAN_RANGE`, `PROJECTILE_SPEED`, `WEAPON_COOLDOWN_TICKS`, `rayHitsSphere()`.

## What does NOT belong in src/core

- Anything that reads/writes files.
- Anything that knows about WebSockets.
- Anything that draws pixels or plays sound.
- Anything that calls React or MUI.
- Anything that depends on `performance.now()` vs `process.hrtime()` — abstract time via an injected clock.
