# Client God-File Decomposition Plan

> **Status**: Approved 2026-05-26. Ready for execution by a fresh agent.
> Start at Part A.0 → A.1 (`ClientTelemetry`). Use the step-by-step
> checklist near the end of this file as the work-tracking surface;
> mark each step `[x]` in this file as you commit it.
>
> **Predecessor**: `hazy-pillow` (SectorRoom storage extraction, 2026-05-25,
> branch `claude/colyseus-refactor-plan-XEAuw`). Smoke-tested on-device
> successfully — methodology proven.
>
> **SOLID context**: this plan addresses all five SOLID principles, not
> just S. See the "SOLID applied to this refactor" section below for
> the per-principle framing. Each subsystem ships as
> `(interface, concrete impl, mock)` — interface first, concrete impl
> second, mock helper in `__mocks__/` third. Orchestrator depends on
> interfaces, not concretions. Factories (`createDefault*`) supply
> default production wiring; tests inject mocks.

---

## Context

After `hazy-pillow` shipped (SectorRoom 4365 → 4236 LOC, 10 subsystems
owning state), the two remaining true god-files in the codebase are:

| File | LOC | Concerns observed |
|---|---|---|
| `src/client/net/ColyseusClient.ts` | **4138** | 13 field clusters, 6 methods >100 LOC, 8 test files locking architecture |
| `src/client/render/PixiRenderer.ts` | **1934** | 15+ field clusters in one class (18 fields just for warp visuals; separate sprite pools for ships/wrecks/projectiles/explosions/boost-flames/thrust-flames/server-ghost/beams) |

Both fail any reasonable read of Single-Responsibility Principle. PixiRenderer
in particular has 18 fields dedicated to warp visuals alone — that is a
subsystem hiding inside another subsystem.

A first-pass audit dismissed PixiRenderer as "well-decomposed because it has
sibling extractions" (DamageNumberManager, HealthBarManager, LabelManager,
HaloRadar, MountVisualManager, BackgroundGrid, Starfield). That verdict was
wrong: extracting peripheral helpers does not redeem a main class that still
owns 15+ concerns. The plan you're reading corrects that.

**What hazy-pillow taught us (carry-forward methodology)**:

1. **Storage-relocation first; method bodies later.** Per-step pattern:
   create a subsystem class, expose its state as `public readonly` Maps /
   Sets / counters, bulk-rename `this.<field>` → `this.<subsystem>.<field>`,
   commit. Method bodies stay in the orchestrator until their cross-subsystem
   deps stabilise. This delivers ownership boundaries quickly without the
   cross-cutting risk of method extraction.
2. **Identity preservation.** Subsystem fields are `public readonly` (not
   private with getter-wrappers) because external code caches references at
   construction time. Returning a fresh wrapper from a getter would break
   those caches.
3. **`_internals` test escape hatch (Step 1 of hazy-pillow).** ONLY if
   integration tests pierce private fields. ColyseusClient's 8 tests are
   architecture-lockstep tests that don't pierce — `_internals` is not
   needed for Part A. PixiRenderer's tests need a baseline check in B.0;
   add `_internals` only if necessary.
4. **Each commit is inner-loop-green.** `pnpm typecheck && pnpm lint &&
   pnpm test && pnpm test:integration && timeout 8 pnpm dev:server`. The
   pattern is mechanical enough that a green-bar commit per subsystem is
   achievable in a single session.
5. **Honest deferral.** Method-body extraction is a *separate* refactor
   pass that follows. Document what's deferred in commit messages and the
   anatomy doc; don't pretend the work shipped when only storage did.

**SRP sanity test (soft heuristic, not a hard ceiling)**: if a class has
**>800 LOC AND mutable state AND >1 distinct change axis**, audit it for
SRP. Pure-data files (wire formats, contracts), test files, entry-point
orchestrators, and routing files are exempt. The point is to apply
judgment, not a number. The two files above fail this test by a huge
margin; the 400-550 LOC tier mostly passes after inspection.

---

## SOLID applied to this refactor

`hazy-pillow` shipped storage-relocation that addresses **S only** —
each subsystem owns one cluster of state. That was the conservative
first move and it worked. This plan deliberately addresses **all five**
SOLID principles from day one, because retrofitting the other four
after the fact is harder than designing for them now.

**S — Single Responsibility.** One subsystem class, one reason to change.
The PixiRenderer split (10+ subsystems) and the ColyseusClient split
(11 subsystems) are entirely about identifying distinct change axes:
"adding a new sprite type", "retuning warp visual choreography",
"changing prediction window tuning", "adding a new HUD throttle", etc.
Each axis = one class.

**O — Open/Closed.** New features by adding new classes, not modifying
the orchestrator. Concretely:

- *PixiRenderer*: today, adding a new sprite type (say, "asteroid debris
  cloud") requires editing `PixiRenderer.ts`: add a field, add a branch
  in the per-frame loop, add a despawn call in dispose. After the
  refactor, the per-frame loop iterates a registry of
  `IEntityRenderer[]`. Adding a new sprite type = write a new class
  + push it into the registry at construction time. PixiRenderer itself
  doesn't change.
- *ColyseusClient*: today, adding a new wire-message handler requires
  editing `connect()`'s 520-line handler-binding block. After the
  refactor, message handlers are registered via a `MessageRouter`
  subsystem with `MessageRouter.on(type, handler)` and live next to
  their owning subsystem. New handlers compose; the connection code
  doesn't change.

**L — Liskov Substitution.** Every concrete subsystem must be
substitutable for its abstraction without changing the orchestrator's
correctness. This means:

- Each subsystem has an **explicit TypeScript interface** declared in
  a dedicated `contracts/` directory (mirror the existing
  `src/core/contracts/` convention from invariant #5).
- The orchestrator depends on the *interface*, not the concrete class.
- Tests can inject a `Mock<Interface>` (or a `Noop<Interface>`) and the
  orchestrator continues to work.
- The interfaces' contracts (return types, side-effect ordering,
  null-vs-undefined) are documented in the contract file and locked by
  at least one unit test per implementation.

**I — Interface Segregation.** Don't force a subsystem into a bloated
interface. Concretely:

- `IEntityRenderer { update(mirror, deltaMs): void; dispose(): void }`
  is the minimal contract for sprite-pool subsystems.
  `ShipSpriteRenderer`, `WreckSpriteRenderer`, `ProjectileSpriteRenderer`,
  etc. implement only this.
- `IWarpController { tick(deltaMs); setMode(on); triggerWarpIn();
  setParams(p); setLoadCurtain(on) }` is the warp-specific contract.
  Doesn't pollute sprite renderers.
- `ICameraController { resize(w, h); forwardPointer(e); forwardWheel(e);
  setCenter(x, y); update() }` is the camera contract.
- `ITickPhaseListener { onPhase(phase, ctx): void }` (optional) for
  subsystems that need to observe orchestrator phases without owning
  rendering. Most subsystems won't implement this.

Each test only depends on the interface it actually uses.

**D — Dependency Inversion.** High-level orchestrators depend on
abstractions; concrete implementations are injected.

- `ColyseusClient` and `PixiRenderer` accept their subsystems via
  constructor injection. Default production wiring is a factory function
  (e.g., `createDefaultPixiRenderer()`) that news up the concrete
  classes; tests construct with mocks/stubs.
- Subsystems themselves accept their dependencies (Pixi `world`
  Container, mirror reference, audio sink) via constructor — no
  global singleton reads.
- This satisfies root CLAUDE.md invariant #5 ("DI seams: `src/core`
  never constructs a renderer / audio / network sink / persistence")
  one zone deeper: now `src/client/render/PixiRenderer` and
  `src/client/net/ColyseusClient` also avoid constructing their own
  collaborators.

**The methodology in one line**: each subsystem ships as
**`(interface, concrete-impl, mock-for-tests)`** rather than just a
class. The interface lives in `src/client/{net,render}/contracts/`;
the concrete impl lives in `src/client/{net,render}/`; the orchestrator
imports only the interfaces.

---

## Plan shape

Two phases under one plan:

- **Part A**: ColyseusClient interface + state extraction
  (A.0 baseline → A.11 subsystems → A.12 MessageRouter →
  A.13 factory + DI constructor → A.15 smoke-test = 14 commits)
- **Part B**: PixiRenderer interface + subsystem extraction
  (B.0 baseline + interfaces → B.11 subsystems →
  B.12 factory + DI constructor → smoke-test = 13 commits)
- **Part C**: Documentation (1 commit)

**Total: ≈28 commits. Wall-clock estimate: 5-7 focused sessions.**

A new agent picks up this plan, copies it to `docs/plans/`, executes
Part A end-to-end (smoke-test checkpoint), then Part B (smoke-test
checkpoint), then Part C.

---

## Part A — ColyseusClient.ts decomposition (4138 LOC)

### A.0 — Baseline + plan-commit + contracts directory

Tasks:
1. Copy this plan file to `docs/plans/client-god-files-decomposition.md`.
   Commit: `docs(plans): client god-file decomposition (plan checked in)`.
2. Verify the inner loop is green on current `main`. Capture
   `wc -l src/client/net/ColyseusClient.ts` and current
   `pnpm test:integration` wall-clock for later comparison.
3. **No `_internals` accessor needed.** The 8 ColyseusClient test files
   (`ColyseusClient.resetPredictionState.test.ts`,
   `ColyseusClient.transitArrivalDrift.test.ts`,
   `ColyseusClient.transitRearmReadiness.test.ts`,
   `ColyseusClient.deadReckon.test.ts`,
   `ColyseusClient.lingeringRouting.test.ts`,
   `ColyseusClient.lingeringRender.test.ts`,
   `ColyseusClient.lingeringJitter.test.ts`,
   `ColyseusClient.mountAnglesPreservation.test.ts`) are
   architecture-lockstep tests that assert observable behaviour, NOT
   internal field state. Confirm with `grep -l "as unknown as" tests/` —
   if any of them pierce internals via cast, add a `_internals` accessor
   first (mirror of hazy-pillow Step 1).
4. **Create `src/client/net/contracts/` directory.** This is where
   subsystem interfaces live. Add an `index.ts` barrel export. Each
   subsequent step adds one or more interfaces here BEFORE the concrete
   class.

### A.1 — A.11: Subsystem extractions

Per-step pattern (hazy-pillow's storage-relocation, extended with
SOLID-shaped contracts):

1. **Design the interface first.** Add
   `src/client/net/contracts/I<Subsystem>.ts` (or extend
   `index.ts` for small interfaces). The interface enumerates the
   *observable* surface — methods callers actually need — not every
   public field. Storage fields stay on the concrete class.
2. **Create the concrete impl.** `src/client/net/<Subsystem>.ts` with
   `public readonly` storage fields + `implements I<Subsystem>`.
3. **Inject via constructor.** In `ColyseusClient.ts`, change the field
   declaration: `private readonly <name>: I<Subsystem>` (interface type,
   not concrete). Wire the concrete impl in the constructor — for now,
   `new <Subsystem>(...)` directly; later steps (D.0, below) extract
   the wiring to a factory.
4. Bulk-rename: `Edit` with `replace_all: true` on each field
   (`this.<field>` → `this.<name>.<field>`).
5. Add a `Mock<Subsystem>` (or noop) test helper under
   `src/client/net/contracts/__mocks__/` so tests that need to inject
   one don't have to construct the real thing. Even if no test uses it
   yet, the act of writing a mock validates the interface is minimal
   (Interface Segregation check).
6. Run inner loop. Commit:
   `refactor(client/net): extract <Subsystem> behind I<Subsystem> (Part A.<N>, plan: client-god-files)`.

**Why this is more than the hazy-pillow pattern**: hazy-pillow shipped
concrete classes with `public readonly` fields and bulk-renamed call
sites — that achieved S but not L/I/D. Here every subsystem ships with
an interface, so the orchestrator depends on abstractions (D), the
subsystem is substitutable (L), the interface is narrow (I), and the
class is single-purpose (S). O comes in when we extract the message
router (A.12) so new wire messages compose rather than modifying
`connect()`.

**Subsystem proposals (from Phase 1 audit; the executor refines as they
go — order minimises cross-cluster references at each step):**

| Step | Subsystem | Fields it owns | Rationale |
|---|---|---|---|
| A.1 | `ClientTelemetry` | `_lastRafStallAtMs`, `_lastRafStallHeapMb`, `_swarmDecodeMaxMs`, `_swarmDecodeTotalMs`, `_swarmDecodeCount`, `_rafSampleCounter`, `lastFrameMs`, `_localPoseResolvedLogged`, `_lastReconcileMs`, `_lastReplayWindow` | Smallest, isolated, no behavioural risk. Builds confidence in the rename pattern. |
| A.2 | `SnapshotCoalesce` | `_pendingSnapshot`, `_coalesceEnabled`, `_coalescedSinceLastProcess`, `_recentCorrFlags`, `_recentIntervals`, `_lastSnapshotRecvAtMs`, `lastSnapshotAt` | Bounded; touches only `connect()` and `handleSnapshot()` callsites. |
| A.3 | `CollisionGuardState` | `_collisionGuard`, `_preResetRemotePosScratch`, `_preResetRemotePosEntries` | Small, well-bounded. |
| A.4 | `HudDispatcher` | `_pendingHullPct`, `_pendingShieldPct`, `_lastPushedHullPct`, `_lastPushedShieldPct`, `_lastHudDispatchAtMs`, `_lastPushedSwarmCount`, `stats` | The 1Hz HUD throttle is one coherent concern. `stats` is publicly read — expose via getter. |
| A.5 | `PredictionTuningState` | `_rttWelford`, `_lookaheadCtrl`, `_dropDetector`, `leadTicks`, `inputTick`, `_anchorInitialised`, `clockAnchorServerTick`, `clockAnchorPerfNow`, `welcomePerfNow`, `serverTickAtWelcome`, `_lastLocalTickAtMs` | Consolidates the prediction-window tuning state. Already partially supported by `predictionTuning.ts`, `lookaheadController.ts`, `clockAnchor.ts`; this gathers their *state* under one owner. |
| A.6 | `PredictionWorldBag` | `predWorld`, `reconciler`, `predRemoteShipIds`, `predSwarmKeys`, `predWreckIds`, `predLingeringIds` | All "things that live in predWorld but aren't authoritative". Single owner makes `resetPredictionState` cleaner. |
| A.7 | `RemoteShipPredictor` | `_remoteLastInputs`, `_remoteForwardTicks`, `_predGuard`, `_remoteShipOffsets`, `remoteHistory` | Stage-3 forward-prediction + 100ms display-delay buffer for remote players. |
| A.8 | `SwarmDecodeState` | `_swarmInterpScratch`, `_aimInterpScratch`, `_swarmBinaryLastMs`, `_swarmBinaryEwma`, `_swarmBodyKeyCache`, `_swarmSyncSeenScratch`, `_swarmNearbyIds`, `_swarmNearbySwapScratch`, `_aiController`, `_aiRegisteredIds` | Binary swarm decode + scratch pools + AI hostility ledger (kept post-pivot, never ticked). |
| A.9 | `MirrorEntityTracker` | `_lingeringShipOffsets`, `_damageFlashFrames` | Per-entity lerp + flash state shared by remote ships + lingering hulls. |
| A.10 | `CombatPredictionState` | `ghostManager`, `_hitLedger`, `_lastHitscanFireMs`, `lastFiredAtTick`, `_scheduledDamageSpawns` | Hit-prediction ledger + ghost projectile manager + smooth-beam scheduled splits. |
| A.11 | `InputDispatcher` | `lastSentInputState`, `lastSentInputAtMs`, `_joystickInputState`, `_localSlotTarget`, `keyboard`, `touchInput`, `localDead` | Input throttle state + joystick hysteresis + sticky turret target. |

**Constraints during each step:**

- **Zustand purity (invariant #2)**: no spatial field may move into Zustand
  as part of this refactor. Subsystem class fields are fine — they're not
  Zustand stores.
- **`stats: PredictionStats`** is publicly read by E2E specs via
  `getPredStats()` helper. Expose `getStats()` on `HudDispatcher`; verify
  the helper's resolution path doesn't break.
- **Identity-preserving Maps**: external code in `src/client/combat/` and
  `src/client/render/` doesn't directly reference ColyseusClient internals
  via property access (per `src/client/CLAUDE.md`'s `mirror.X` discipline),
  so the identity-preservation constraint is *weaker* than SectorRoom's.
  Still, expose all Maps as `public readonly` so future external readers
  don't break if they appear.
- **Pool / scratch invariants**: every subsystem must preserve the
  pool/scratch fields' lifetime semantics. `_swarmNearbySwapScratch` two-set
  swap, `_preResetRemotePosEntries` grow-once pool, `_swarmBodyKeyCache`
  string cache — these were anti-GC measures from `docs/LESSONS.md`
  2026-05-22 (heap-growth-gate spec). Class field, never per-tick local.

### A.12 — `IMessageRouter` for Open/Closed handler binding

After A.1-A.11 land, the 520-line handler-binding block inside
`connect()` is still the single point of modification for new wire
messages. Extract it as a `MessageRouter` with the contract:

```ts
interface IMessageRouter {
  on<T extends WireMessageType>(type: T, handler: (msg: WireMessage<T>) => void): void;
  bind(room: Room): void;      // attach all registered handlers to a Colyseus room
  unbind(room: Room): void;
}
```

Each subsystem that needs to react to wire messages registers its own
handlers via `router.on(type, fn)` in its constructor. When `connect()`
runs, it iterates `router.bind(this.room)` to attach them all. Adding
a new message handler means writing a new subsystem (or extending an
existing one) and calling `router.on(...)` — `connect()` does not
change.

This is the **O** of SOLID realised concretely.

Commit: `refactor(client/net): extract MessageRouter (Part A.12, plan: client-god-files)`.

### A.13 — `createDefaultColyseusClient()` factory (Dependency Inversion seam)

Move the construction of all 12 subsystems (A.1-A.12) out of
`ColyseusClient`'s constructor and into a `createDefaultColyseusClient()`
factory function. `ColyseusClient`'s constructor now accepts the
subsystems as parameters (typed as their interfaces), making it fully
mockable in tests:

```ts
export class ColyseusGameClient {
  constructor(
    private readonly telemetry: IClientTelemetry,
    private readonly coalesce: ISnapshotCoalesce,
    private readonly collisionGuard: ICollisionGuardState,
    private readonly hud: IHudDispatcher,
    private readonly predictionTuning: IPredictionTuningState,
    private readonly predictionWorld: IPredictionWorldBag,
    private readonly remotePredictor: IRemoteShipPredictor,
    private readonly swarmDecode: ISwarmDecodeState,
    private readonly mirrorEntities: IMirrorEntityTracker,
    private readonly combatPrediction: ICombatPredictionState,
    private readonly input: IInputDispatcher,
    private readonly router: IMessageRouter,
    callbacks: ColyseusClientCallbacks,
  ) {}
}

// Default production wiring.
export function createDefaultColyseusClient(
  callbacks: ColyseusClientCallbacks,
): ColyseusGameClient {
  return new ColyseusGameClient(
    new ClientTelemetry(),
    new SnapshotCoalesce(),
    // ... etc
    callbacks,
  );
}
```

The single call site that does `new ColyseusGameClient(...)` today
(`src/client/net/clientSingleton.ts`) switches to
`createDefaultColyseusClient(...)`. Tests can construct with
hand-picked mocks.

Commit: `refactor(client/net): createDefaultColyseusClient factory + DI constructor (Part A.13, plan: client-god-files)`.

### A.14 — Method-body extractions (deferred; documented only)

**Explicitly out of scope for this plan.** The 6 giant methods that
remain on `ColyseusClient` after Part A:

- `connect()` (~667 LOC, much smaller after A.12) — room join + handler
  binding (now via MessageRouter)
- `handleSnapshot()` (~603 LOC) — snapshot reconcile + apply
- `syncMirror()` (~194 LOC) — Colyseus schema diff → mirror
- `tickPhysics()` (~400 LOC) — wall-clock-anchored input loop
- `updateMirror()` (~452 LOC) — per-RAF mirror rebuild
- `sendFire()` (~225 LOC) — multi-mount fire + smooth-beam splitting

These move in a future plan. Document in `colyseus-client-anatomy.md`
Part C as deferred, alongside the equivalent SectorRoom method-body
deferrals.

### A.15 — Smoke-test checkpoint

After all of A.1-A.11 land, on-device smoke test of:
- Local player spawn → fire → damage → destroy → respawn
- Transit out → arrival drift (`resetPredictionState` path)
- Drone interpolation (one-pose-per-frame rule)
- Lingering-hull collision + render
- Joystick hysteresis

If smoke passes: commit `chore: Part A smoke-test confirmation`. If any
regression: bisect by reverting subsystem extractions one at a time.
The bulk-rename pattern is reversible.

---

## Part B — PixiRenderer.ts decomposition (1934 LOC)

### B.0 — Baseline + test piercing audit + contracts directory

1. Confirm `pnpm test` green post-Part-A.
2. Audit `PixiRenderer.*.test.ts` files for private-field piercing:
   - `PixiRenderer.warpCenter.test.ts`
   - `PixiRenderer.warpBurst.test.ts`
   - `spriteUpdateDecisions.test.ts`
   - any others under `src/client/render/`
3. If any pierce: add `_internals` accessor to PixiRenderer first (mirror
   of hazy-pillow Step 1), rewrite the piercing tests to route through it,
   commit as `refactor(client/render): _internals accessor (Part B.0)`.
   If none pierce: proceed directly to B.1.
4. **Create `src/client/render/contracts/` directory.** Each subsystem
   in Part B ships with its interface here, mirroring Part A's
   `src/client/net/contracts/` discipline. The orchestrator
   `PixiRenderer` will import only from `contracts/`.
5. **Design the core interfaces** before any extraction:
   - `IEntityRenderer { update(mirror, deltaMs): void; dispose(): void }`
     — sprite-pool subsystems. Ships in `contracts/IEntityRenderer.ts`.
   - `IWarpController { tick(deltaMs); setMode(on); triggerWarpIn();
     setParams(p); setLoadCurtain(on, target?) }` — warp choreography.
   - `ICameraController { resize(w, h); forwardPointerEvent(e);
     forwardWheelEvent(d, x, y); setCenter(x, y); update(): void }`
     — viewport + input forwarding.
   - `ILoadCurtainController { tick(deltaMs); setTargetAlpha(a) }`
     — split out from warp because the curtain has different
     lifetime semantics than warp filters.

   Commit: `feat(client/render/contracts): subsystem interfaces (Part B.0)`.

### B.1 - B.11: Subsystem extractions

**This is the SRP correction.** Each subsystem represents a distinct
change axis for PixiRenderer — adding a new entity type, changing warp
visual choreography, retuning camera behaviour, etc.

| Step | Subsystem | Fields | Methods to move (in order of dependency) |
|---|---|---|---|
| B.1 | `LoadCurtainController` | `loadCurtain`, `loadCurtainTargetAlpha`, `loadCurtainTweenStartedAt`, `loadCurtainTweenFromAlpha` | Tween methods (currently inline in `update()`). Single concern; smallest extraction. |
| B.2 | `WarpVisualController` | 18 warp fields (see Phase 1 audit) + the `warpBurst` family | `fireBurst()`, `ensureWarpStage()`, `buildShockwaveStack()`, `attachWarpFilters()`, `setWarpMode()`, `triggerWarpIn()`, `setWarpParams()`. **Biggest single win on the file** — ≈500 LOC moves out. |
| B.3 | `CameraController` | `world`, `camera`, `shipContainer`, viewport-related state | `resize()`, `forwardPointerEvent()`, `forwardWheelEvent()`, `setCameraCenter()`, the pointer/wheel/touch installer, `installCanvasEventListeners()`. |
| B.4 | `ShipSpriteRenderer` | `sprites: Map<string, Graphics>` | The ship-sprite branch of `update()` (sprite create / kind-rebuild / position-update / damage-flash / mount-aim composition / dispose). |
| B.5 | `WreckSpriteRenderer` | `wreckSprites: Map<string, Graphics>` | `updateWrecks(mirror)` (already extracted as private method — move whole-cloth). |
| B.6 | `LingeringHullSpriteRenderer` | (none new — uses `wreckSprites`-style pool internally) | `updateLingeringShips(mirror)` (already extracted as private method). |
| B.7 | `ProjectileSpriteRenderer` | `projectileSprites: Map<string, Graphics>` | The projectile branch of `update()`. Includes ghost-projectile compositing (does NOT own GhostManager — reads from mirror). |
| B.8 | `ExplosionSpriteRenderer` | `explosionSprites: Array<{ gfx, framesLeft }>` | Explosion-fade lifecycle (frame countdown + destroy). |
| B.9 | `FlameRenderer` | `boostFlames`, `thrustFlames` | Boost + thrust sprite cycling. |
| B.10 | `BeamRenderer` | `liveBeamGfx`, `remoteBeamGfx` | Multi-mount beam tracing (live + remote, per-shooter per-mount). |
| B.11 | `DebugViewRenderer` | `serverGhost` | Orange-diamond debug viz at raw snapshot coords. |

**Per-subsystem interface pattern (Open/Closed via registry)**:

Each *entity* subsystem implements `IEntityRenderer`:

```ts
// contracts/IEntityRenderer.ts
export interface IEntityRenderer {
  /** Called once per frame from PixiRenderer.update(). */
  update(mirror: RenderMirror, deltaMs: number): void;
  /** Called from PixiRenderer.dispose(). */
  dispose(): void;
}

// ShipSpriteRenderer.ts
export class ShipSpriteRenderer implements IEntityRenderer { ... }
```

Each subsystem owns its own Pixi `Container`; PixiRenderer attaches
them in order to the `world` so layering stays controlled. **The
orchestrator holds the subsystems behind their interfaces and iterates
a registry — the per-frame loop has zero entity-specific code**:

```ts
class PixiRenderer implements IRenderer {
  // Constructor-injected — DI seam (D).
  constructor(
    private readonly camera: ICameraController,
    private readonly warp: IWarpController,
    private readonly loadCurtain: ILoadCurtainController,
    private readonly entityRenderers: readonly IEntityRenderer[],
    private readonly hudOverlays: readonly IHudOverlay[],  // halo, damage numbers, etc.
  ) {}

  update(mirror: RenderMirror, deltaMs: number): void {
    this.warp.tick(deltaMs);
    this.loadCurtain.tick(deltaMs);
    for (const r of this.entityRenderers) r.update(mirror, deltaMs);
    for (const h of this.hudOverlays) h.update(mirror);
    this.camera.update();
    this.feedback.firstFrameRendered = true;
  }
}
```

**Adding a new entity type (post-refactor)**: write a new
`class FooSpriteRenderer implements IEntityRenderer`, append to the
`entityRenderers` array in the factory, ship. **PixiRenderer.ts is
not modified.** That is the Open/Closed Principle as a concrete
property of the design, not an aspiration.

A factory function (Dependency Inversion):

```ts
// createDefaultPixiRenderer.ts
export function createDefaultPixiRenderer(world: Container, audio?: IAudio): PixiRenderer {
  const camera = new CameraController(world);
  const warp = new WarpVisualController(world);
  const loadCurtain = new LoadCurtainController(world);
  const entityRenderers: IEntityRenderer[] = [
    new ShipSpriteRenderer(world),
    new WreckSpriteRenderer(world),
    new LingeringHullSpriteRenderer(world),
    new FlameRenderer(world),
    new ProjectileSpriteRenderer(world),
    new BeamRenderer(world),
    new ExplosionSpriteRenderer(world),
    new DebugViewRenderer(world),
  ];
  const hudOverlays: IHudOverlay[] = [
    new HaloRadar(world),
    new DamageNumberManager(world),
    new HealthBarManager(world),
    new LabelManager(world),
  ];
  return new PixiRenderer(camera, warp, loadCurtain, entityRenderers, hudOverlays);
}
```

Tests construct `new PixiRenderer(mockCamera, mockWarp, ..., [mockShip])`
and only need to know about the interfaces they exercise (Interface
Segregation).

Target outcome: **PixiRenderer.ts shrinks to ~300-400 LOC** as a thin
orchestrator depending only on interfaces. The "per-frame loop touches
multiple entity types simultaneously" objection from the original audit
is solved by iterating the registry — yes you walk the mirror multiple
times, that's fine; the per-tick cost is dwarfed by Pixi's own draw
call cost.

### B.12 — `createDefaultPixiRenderer()` factory (Dependency Inversion seam)

Mirror of A.13. Move construction of all subsystems (B.1-B.11) out of
`PixiRenderer`'s constructor into `createDefaultPixiRenderer()`.
`PixiRenderer`'s constructor accepts the subsystems as parameters
typed as their interfaces (`ICameraController`, `IWarpController`,
`ILoadCurtainController`, `readonly IEntityRenderer[]`,
`readonly IHudOverlay[]`). The orchestrator is now fully DI-shaped:
the per-frame loop iterates the injected `entityRenderers` registry,
not a hard-coded set of fields.

The single call site that does `new PixiRenderer()` (in
`WorkerRendererClient.ts` or wherever the fallback path lives — see
`src/client/CLAUDE.md` "Touch devices default to PixiRenderer") switches
to `createDefaultPixiRenderer()`. Tests construct with mock entity
renderers as needed.

Commit: `refactor(client/render): createDefaultPixiRenderer factory + DI constructor (Part B.12, plan: client-god-files)`.

### B.13 — Smoke-test checkpoint

After all of B.1-B.12, on-device smoke of:
- Full game session: spawn → fire → damage flash → destroy → respawn
- Warp out (curtain raise + spool) → arrival (single flash, no double-flash)
- Mount visual rotation on multi-mount ships
- Damage numbers + health bars + halo + labels (the already-extracted
  HUD managers must still work)
- Pointer / wheel / touch on the canvas (CameraController)

---

## Part C — Documentation (single commit)

After Parts A + B land + smoke-tested:

1. **Create** `docs/architecture/colyseus-client-anatomy.md` (mirror of
   `sector-room-anatomy.md`):
   - Subsystem map table (11 rows)
   - What stays on ColyseusClient (the 6 giant methods, the message
     handler block, the per-frame orchestration)
   - Identity-preservation discipline
   - Deferred work (method bodies)
   - Test piercing posture (none today; future _internals if needed)

2. **Create** `docs/architecture/pixi-renderer-anatomy.md`:
   - Subsystem map table (11+ rows including the already-extracted
     siblings)
   - Per-frame update sequence + container layering
   - WarpVisualController state machine diagram (the 18 fields → distinct
     phases of warp choreography)
   - The Y-flip rule (game-space ↔ Pixi-space conversion lives where)
   - The one-pose-per-frame drone interpolation rule (and which subsystem
     enforces it)
   - Deferred work

3. **Update** `src/client/CLAUDE.md`:
   - Add "ColyseusClient subsystems" section pointing at anatomy doc
   - Add "PixiRenderer subsystems" section pointing at anatomy doc
   - Keep the existing prediction / Zustand / Y-flip / one-pose-per-frame
     sections — those are gameplay invariants, not file-structure

4. **Append** `docs/LESSONS.md` entry dated `YYYY-MM-DD` with title
   `client-god-files — ColyseusClient + PixiRenderer state extraction`.
   Sections:
   - What shipped (2 files decomposed into 21 subsystems total)
   - The PixiRenderer-was-mis-classified-as-well-decomposed correction
     story (and the user push-back that triggered the correction)
   - SRP test "soft heuristic" framing — when LOC is a smell vs when
     it's defensible
   - What stays inline (method bodies on both files; future refactor pass)

5. **Banner** on `docs/plans/refactor-god-files.md`:
   ```
   ⚠️ Update 2026-05-DD — ColyseusClient + PixiRenderer state extraction
   completed via `client-god-files-decomposition.md`. The
   sections below are partially superseded.
   ```

Commit: `docs(refactor): client-god-files anatomy + CLAUDE.md + LESSONS (Part C)`.

---

## Verification protocol

**Per-step inner loop** (every commit in A.1-A.11 and B.1-B.11):

```
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && timeout 8 pnpm dev:server
```

The dev:server boot is mandatory — Phase 1 audit found that worker /
SAB init paths are not covered by unit tests. A clean boot
(`INFO: EQX Peri server started port: 2567`) within 8 s confirms
the runtime path.

**Part A checkpoint** (after A.11): full E2E suite + on-device smoke
on actual mobile device. Focus areas: prediction window
(`?diag=1` → check `rollingCorrRate`, `ticksAhead`), transit arrival
(no warp-out jank), joystick hysteresis, snapshot coalescing under
GC pressure (gate #4 → check `raf_gap` clusters).

**Part B checkpoint** (after B.11): full E2E suite + on-device smoke.
Focus areas: warp visual single-flash policy, mount-angle preservation
on per-frame mirror rebuild, ship sprite kind-rebuild path (the Phase
6b lingering hull "permanently invisible" regression class), 90 Hz
device frame cap (the `?fpscap=10` rule from `src/client/CLAUDE.md`).

---

## Risk + reversibility

**Risk**: the bulk-rename pattern is mechanical and reversible
per-commit. If a regression surfaces in step N, revert that step's
commit; the previous N-1 are independent.

**Compound risk**: a regression in step N that depends on state
ownership from step N-1 is harder to revert — you'd revert N and N-1
together. Mitigation: each subsystem's extraction touches only the
fields/scratches in that subsystem. Cross-subsystem refactors are
explicitly out of scope.

**Test coverage gap**: ColyseusClient has 8 architecture-lockstep
tests; PixiRenderer has 3-4 visual + 1 mount-angle-preservation
test. None of these prove behavioural correctness end-to-end. The
on-device smoke-test checkpoints are the safety net.

**No netgate runs.** State relocation does not change wire format,
broadcast cadence, or prediction tuning constants. Netgate is reserved
for changes that move `data-pred-stats` and is unnecessary here.

---

## Out of scope (explicitly deferred)

1. **Method-body extraction** for `connect()`, `handleSnapshot()`,
   `syncMirror()`, `tickPhysics()`, `updateMirror()`, `sendFire()`
   (ColyseusClient) and `update()` / warp choreography internals
   (PixiRenderer). Future plan; depends on whether the new subsystem
   interfaces hold up under maintenance pressure first.

2. **SectorRoom method-body extraction** (the hazy-pillow deferred
   work — `handleFire`, `applyDamage`, `advanceProjectiles`,
   `onJoin`, the wreck conversion txn, etc.). Future plan.

3. **400-550 LOC tier files** (Camera.ts 470, GalaxyOverviewRenderer.ts
   498, WorkerRendererClient.ts 505, diagRouter.ts 519, World.ts 533,
   LivingWorldDirector.ts 430, HaloRadar.ts 417). These passed an
   inspection-based SRP smell-test today — small field counts, single
   concern per file. **They do not pass the same scrutiny on O/L/I/D
   automatically.** When the executor reaches Part C, do a brief
   SOLID-pass on each — specifically: does the orchestrator (or
   parent class) construct them directly, or accept them via an
   interface? If directly constructed, that's a DI-violation worth
   noting (but not fixing in this plan). Document findings in
   LESSONS.md. Future plan candidate: "DI seam audit for the mid-tier
   client subsystems".

4. **The "well-decomposed" sibling extractions already on disk**
   (DamageNumberManager, HealthBarManager, LabelManager, HaloRadar,
   MountVisualManager, BackgroundGrid, Starfield, spriteUpdateDecisions
   for PixiRenderer; predictionStats, predictionTuning,
   lookaheadController, clockAnchor, swarmInterpolation,
   remotePredictionGuard, applyCollisionResolved, BinarySwarmDecoder,
   transitClient, GhostProjectile, HitPrediction for ColyseusClient).
   These stay as-is; the plan composes them into the new subsystem
   structure but does not re-extract them.

---

## Step-by-step execution checklist (for the executing agent)

Mark each step `[x]` in the plan file as you commit it. Push after
A.11, A.12, B.0 (interfaces), B.11, B.12 (factory), and C.

- [ ] **A.0** — Plan committed to repo + baseline + `src/client/net/contracts/` created
- [ ] **A.1** — `IClientTelemetry` + `ClientTelemetry`
- [ ] **A.2** — `ISnapshotCoalesce` + `SnapshotCoalesce`
- [ ] **A.3** — `ICollisionGuardState` + `CollisionGuardState`
- [ ] **A.4** — `IHudDispatcher` + `HudDispatcher`
- [ ] **A.5** — `IPredictionTuningState` + `PredictionTuningState`
- [ ] **A.6** — `IPredictionWorldBag` + `PredictionWorldBag`
- [ ] **A.7** — `IRemoteShipPredictor` + `RemoteShipPredictor`
- [ ] **A.8** — `ISwarmDecodeState` + `SwarmDecodeState`
- [ ] **A.9** — `IMirrorEntityTracker` + `MirrorEntityTracker`
- [ ] **A.10** — `ICombatPredictionState` + `CombatPredictionState`
- [ ] **A.11** — `IInputDispatcher` + `InputDispatcher`
- [ ] **A.12** — `IMessageRouter` + `MessageRouter` (Open/Closed seam)
- [ ] **A.13** — `createDefaultColyseusClient()` factory (Dependency Inversion seam)
- [ ] **Part A smoke-test on device**
- [ ] **B.0** — Test piercing audit; `_internals` if needed; `src/client/render/contracts/` + core interfaces
- [ ] **B.1** — `LoadCurtainController` (`ILoadCurtainController`)
- [ ] **B.2** — `WarpVisualController` (`IWarpController`) *(biggest single win)*
- [ ] **B.3** — `CameraController` (`ICameraController`)
- [ ] **B.4** — `ShipSpriteRenderer` (`IEntityRenderer`)
- [ ] **B.5** — `WreckSpriteRenderer` (`IEntityRenderer`)
- [ ] **B.6** — `LingeringHullSpriteRenderer` (`IEntityRenderer`)
- [ ] **B.7** — `ProjectileSpriteRenderer` (`IEntityRenderer`)
- [ ] **B.8** — `ExplosionSpriteRenderer` (`IEntityRenderer`)
- [ ] **B.9** — `FlameRenderer` (`IEntityRenderer`)
- [ ] **B.10** — `BeamRenderer` (`IEntityRenderer`)
- [ ] **B.11** — `DebugViewRenderer` (`IEntityRenderer`)
- [ ] **B.12** — `createDefaultPixiRenderer()` factory + DI constructor (Dependency Inversion seam)
- [ ] **B.13** — Smoke-test on device
- [ ] **C** — Documentation deliverables (incl. SOLID-applied section in each anatomy doc)

Final state target:
- `src/client/net/ColyseusClient.ts`: ~2500-3000 LOC orchestrator
  (down from 4138; reduction is modest — value is in ownership
  clarity, interface contracts, DI seam, and the MessageRouter
  enabling Open/Closed for new wire messages)
- `src/client/render/PixiRenderer.ts`: **~300-400 LOC orchestrator**
  (down from 1934; bigger LOC reduction because entity renderers own
  both state AND their `update()` branches, and the per-frame loop
  becomes a `for (const r of entityRenderers) r.update(...)` iteration)
- `src/client/net/contracts/` directory with 12+ interfaces
- `src/client/render/contracts/` directory with 4-6 interfaces
- 2 factory files (`createDefaultColyseusClient.ts`,
  `createDefaultPixiRenderer.ts`) wiring concretions via DI
- 23+ new files under `src/client/{net,render}/` (interfaces +
  concretes + mocks)
- 2 new architecture docs (one per orchestrator), each with a
  "SOLID applied" section
- `docs/LESSONS.md` entry capturing both the SRP-correction story
  and the upgrade from hazy-pillow's S-only pattern to full
  SOLID-shaped subsystems

---

## A note for the executing agent

**The methodology**: each subsystem ships as
**`(interface, concrete impl, mock-for-tests)`** in one commit. Interface
first, then implementation, then update the orchestrator to depend on
the interface, then bulk-rename callsites, then run inner loop, then
commit. The hazy-pillow pattern handled only the concrete-impl step;
this plan extends it with interfaces (Liskov + Interface Segregation
+ Dependency Inversion) and a registry pattern (Open/Closed for
PixiRenderer's entity loop and ColyseusClient's message routing).

**Hard rules**:

1. **Interface before implementation.** Always write the interface
   first. If you can't list the public surface in 5-10 method
   signatures, the subsystem is too big — split it.
2. **Constructor injection only.** Subsystems take their dependencies
   (Pixi world, mirror, audio sink) via constructor. No
   `getGameClient()` / global lookups inside a subsystem class.
3. **Orchestrator depends on interfaces.** `ColyseusClient` and
   `PixiRenderer` import only from `contracts/`, not from concrete
   class files. The factory (A.13 / B.12) is the one place concrete
   classes get instantiated.
4. **Mock helper per subsystem.** Write a noop / mock for the
   interface in `__mocks__/` alongside the concrete class. If you
   can't write a useful mock in <30 LOC, the interface is too
   complex — split it. (This is the empirical test for I.)
5. **Method-body extraction is out of scope.** If you find that the
   storage extraction forces moving a method body (because the field
   is mutated from a callback or deep inside a 600-line method),
   STOP. Document it in the commit message as deferred and move on.
   Mixing storage and method extraction is the scope-creep failure
   mode that bit `hazy-pillow`.
6. **Don't restructure already-extracted helpers.** PixiRenderer's
   `MountVisualManager`, `DamageNumberManager`, `HealthBarManager`,
   etc. exist. Don't refactor them in this plan; compose them via
   the `IHudOverlay` interface and move on.

When in doubt, mirror the SectorRoom pattern in
`docs/architecture/sector-room-anatomy.md`: subsystems own state,
the orchestrator owns the per-tick orchestration, method bodies that
span multiple subsystems stay on the orchestrator. This plan ADDS to
that pattern: subsystems are interfaces first; the orchestrator
depends on interfaces; concrete impls live behind a factory.

Good luck. The methodology works; the failure modes are scope creep
into method bodies and a god-interface anti-pattern (`ISubsystem` with
20 methods). Use the mock-helper-in-30-LOC test to keep interfaces
honest.
