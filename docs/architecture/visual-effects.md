# Visual Effects Subsystem

> Plan: [`~/.claude/plans/i-d-like-you-to-wiggly-puppy.md`](../../).
> Status: M0.5 → M11 landed 2026-05-27 on
> `claude/game-visuals-particles-gdWgc`. Awaiting on-device smoke.

## Why this exists

Pre-2026-05-27 the in-game visuals were functional but flat: warp
filters were **disabled** (`WarpFilterChain.ts:240-243`, "Render-jitter-fix
Phase 1b" 2026-05-21), ship destruction was an 8-line Graphics
starburst, engines were static taper triangles, lasers had no glow or
impact sparks, and shields had no in-world visual at all (only the HUD
bar).

The user asked for the visual layer raised — cosmetic, controllable,
and on a leash for GC. This subsystem is the answer.

## Goals (all delivered)

1. **Reinstate warp visuals**, toned down so the 2026-05-21 mobile
   regression doesn't recur.
2. **Add laser glow + impact sparks** at damage events.
3. **Visible shields** (in-world ring + glow) when a ship's shield is
   up.
4. **Convert ship destruction** to particle effects + a brief filter
   pulse.
5. **Convert engines** to particle trails complementing the legacy
   flames.
6. **Extend the effects-preview sandbox** to a true 1:1 preview for
   every effect.
7. **Throttle effects dynamically** — distance-cull first, then tier-
   based quality drop.
8. **SOLID** + tight GC discipline.

## Architecture

### Contracts (`src/core/contracts/IEffects.ts`)

Three narrow sub-contracts per ISP:

```ts
interface IParticleEffects {
  spawnBurst(kind, worldX, worldY, opts?): void;
  setContinuous(entityId, kind, active): void;
  tick(nowMs, dtMs, rendererUpdateMs?): void;
  resetForSectorHandoff(): void;
  pulseShield(entityId): void;
}
interface IFilterEffects {
  triggerOneShotFilter(kind, worldX, worldY): void;
}
interface IEffectsBudget {
  setQuality(level): void;
  getQuality(): EffectQuality;
  getStats(): { activeBursts, activeContinuous, activeFilters, quality };
}
interface IEffects extends IParticleEffects, IFilterEffects, IEffectsBudget {}
```

**Warp methods stay on `IRenderer`** — one ownership site per state
surface (Invariant #12). `EffectsBudget` holds a direct reference to
`WarpFilterChain` for tier-driven attach/detach. No facade, no parallel
path.

### Construction site

`EffectsService` is constructed **inside `PixiRenderer.init`** — one
construction site per renderer instance, covers both the OffscreenCanvas
worker path AND the touch-device main-thread fallback
(`src/client/CLAUDE.md:67-69`).

`ColyseusClient` **never imports `EffectsService`**. Effect triggers
flow through `RenderMirror.pendingEffectTriggers` (drained by the
renderer each frame on `shouldRender` — same skip-frame discipline as
`explodingShips`, locked by `perFrameTriggers.test.ts`).

`?effects=0` URL escape hatch skips `EffectsService` construction
entirely; the renderer falls back to today's inline Graphics paths for
destruction + flames.

### Per-effect modules (`src/client/effects/perEffect/`)

| Module | Responsibility | Tier dial (high → minimal) |
|---|---|---|
| `WarpFilterChain` (existing) | spool/climax/burst/flash | full chain → drop bloom → drop zoom-blur → detach all |
| `DestructionFx` | radial particle burst + ShockwaveFilter | 40 particles + shock → 20 + shock → 10 no shock → legacy `buildExplosionGfx` |
| `EngineEmitter` | per-ship continuous particle trails | thrust + boost emitters → thrust only → thrust half-rate → off (legacy Graphics flames carry) |
| `LaserGlow` | GlowFilter on liveBeamGfx + remoteBeamGfx | both attached q=0.2 → both q=0.1 → live only → both detached |
| `ImpactSparks` | one-shot spark burst at damage hits | 24 particles → 12 → 6 → skip |
| `ShieldAura` | ring sprites in one shared container | ring + GlowFilter + breathe → ring + breathe → flat ring → hidden |

All managers follow the same disciplines:
- **Constructor-injected factories** for Pixi classes that touch DOM
  (filters compile shaders → `document.createElement('canvas')`). Keeps
  tests DOM-free.
- **Pool caps with oldest-out eviction** (matches `DamageNumberManager`
  pattern). Pool sizes: 200 destruction particles, 300 engine particles,
  160 impact sparks, 32 shield rings, 8 shockwave filters.
- **`resetForSectorHandoff()` method** for transit cleanup.
- **One-pose-per-frame invariant**: `EffectsService.tick` runs INSIDE
  `PixiRenderer.update(mirror)` at the tail, after all sprite updaters.
  Engine emitters + shield rings read the freshly-written sprite
  positions; never re-resolve drone poses (matches the 2026-05-19 rule
  in `src/client/CLAUDE.md`).

### Budget (`EffectsBudget.ts`)

| Transition | Trigger | Hold |
|---|---|---|
| `high → medium` | EMA(rendererUpdateMs) > 6 ms | 500 ms |
| `medium → low` | EMA > 8 ms | 500 ms |
| `low → minimal` | EMA > 9 ms | 250 ms |
| `minimal → low` | EMA < 7 ms | 750 ms |
| `low → medium` | EMA < 6 ms | 1500 ms |
| `medium → high` | EMA < 4 ms | 1500 ms |

Recovery thresholds are 2 ms lower than the downshift trigger AND
require a 3× longer hold to prevent flicker. EMA alpha = 0.06
(~16-sample / ~270 ms response). Warmup = 8 samples held at `high`.

The budget keeps two independently-resolved tiers (`localTier` from its
own metrics, `pushedTier` from the main-thread `PerfMonitor`) and
exposes `pickMoreRestrictive(local, pushed)` as `getQuality()`. The
main thread pushes via `SET_EFFECT_QUALITY` **only on tier transition**
(≤ once per 500 ms by hysteresis construction). NEVER per-frame —
locked by an `EffectsBudget.test.ts` assertion.

### Mirror additions (`RenderMirror`)

Two fields:

- **`pendingEffectTriggers?: Array<{ kind; worldX; worldY; intensity?;
  tint?; entityId? }>`** — one-shot effect-trigger drain queue. Cleared
  inside `consumeOneFrameTriggers` on `shouldRender` frames only (same
  worker-mode skip-frame gate as `explodingShips`). Lock test:
  `perFrameTriggers.test.ts`.
- **`ShipRenderState.shieldDown?: boolean`** — per-ship shield-up bit.
  Populated by `handleShield` (clears on restore/regen) AND
  `handleDamage` (sets on `newShield<=0`). Mirrors the existing
  `swarm[].shieldDown` for drones. Single ownership site per render
  entry. Known limitation: remote players who joined after their shield
  broke (no DamageEvent observed) start with `shieldDown=undefined` →
  aura OFF. Future fix: lift onto the snapshot wire.

### Sector handoff

`ColyseusClient.resetPredictionState()` calls the new
`callbacks.onSectorHandoff?.()` as a sibling line to
`rearmJoinReadiness()` (NOT folded — SRP per zone). The connect-flow
wires `onSectorHandoff` → `renderer.resetEffectsForSectorHandoff()` →
`EffectsService.resetForSectorHandoff()`, which wipes per-entity
emitters + in-flight bursts + shield rings AND clears the diff trackers
(`_activeThrustIds`, `_activeBoostIds`, `_activeShieldIds`).

`resetPredictionState` ALSO clears `mirror.pendingEffectTriggers.length =
0` directly so source-coord triggers don't drain into the destination
sector.

Lock test: `src/client/net/transitResetEffects.test.ts`.

## Files

| File | Purpose |
|---|---|
| `src/core/contracts/IEffects.ts` | Three narrow contracts + composite |
| `src/core/contracts/IRenderer.ts` | Added `RenderMirror.pendingEffectTriggers`, `ShipRenderState.shieldDown`, `IRenderer.resetEffectsForSectorHandoff` |
| `src/client/effects/EffectsService.ts` | Implements `IEffects`; constructed in `PixiRenderer.init` |
| `src/client/effects/EffectsBudget.ts` | Pure tier policy with EMA + hysteresis |
| `src/client/effects/config/effectDefaults.ts` | Per-effect tuning constants — Copy-JSON target |
| `src/client/effects/perEffect/DestructionFx.ts` + factories | Destruction particles + ShockwaveFilter |
| `src/client/effects/perEffect/EngineEmitter.ts` + factories | Thrust + boost continuous emitters |
| `src/client/effects/perEffect/LaserGlow.ts` + factories | GlowFilter on beam Graphics |
| `src/client/effects/perEffect/ImpactSparks.ts` + factories | Damage-event spark bursts |
| `src/client/effects/perEffect/ShieldAura.ts` + factories | One-container shield rings + shared GlowFilter |
| `src/client/render/PixiRenderer.ts` | Constructs EffectsService; drives sync* + drain |
| `src/client/render/pixi/WarpFilterChain.ts` | Re-enabled + `applyQuality` method |
| `src/client/render/worker/protocol/mainToWorker.ts` | 4 new variants (TRIGGER/SET_QUALITY/SET_PARAMS/RESET_HANDOFF) |
| `src/client/render/worker/WorkerRendererClient.ts` | Forwarding methods for new variants |
| `src/client/render/worker/renderer.worker.ts` | Dispatch + default-branch warn |
| `src/client/render/perFrameTriggers.ts` | Drains `pendingEffectTriggers` on `shouldRender` |
| `src/client/net/ColyseusClient.ts` | `handleDamage` pushes impact triggers, `handleShield` updates shieldDown, `resetPredictionState` fires `onSectorHandoff` |
| `src/client/app/gameSurfaceConnectFlow.ts` | Wires `onSectorHandoff` → `renderer.resetEffectsForSectorHandoff()` |
| `src/client/__offscreen-spike__/visual-effects-sandbox.html` + `*-main.ts` | All effects previewable + quality dial |
| `src/client/__offscreen-spike__/particle-emitter-probe.*` | M0.5 worker-compat probe |
| `src/client/effects/**/*.test.ts` | 50+ unit tests |
| `src/client/render/worker/protocol.test.ts` | Protocol structuredClone round-trips |

## `@pixi/particle-emitter` notes (M0.5 spike)

v5.0.10 is installed. Static-analysis evidence the library is worker-
safe: zero references to `document.`, `window.`, `addEventListener`,
`navigator.`, `location.`, or `requestAnimationFrame` in
`node_modules/@pixi/particle-emitter/lib/particle-emitter.es.js`. Worker
probe at `__offscreen-spike__/particle-emitter-probe.html` for live
browser verification.

**M3-M10 manager modules use hand-rolled Graphics particles**, NOT the
library — the same pattern as `DamageNumberManager`. The library remains
available behind a future `EmitterPool` wrapper for continuous-emission
effects where it's a better fit. The two patterns coexist behind their
per-effect manager seams.

Caveat: v5.0.10's TypeScript types were authored for Pixi v7
(`Container<DisplayObject>`); Pixi v8 renamed the child constraint to
`ContainerChild`. Runtime compatible; type-cast at call sites or own a
typed wrapper.

## Mobile-perf safety nets

- **Warp filter chain** re-enabled with toned-down defaults (spoolCount
  4→2, climaxAmplitude 220→70, bloomStrength 6→1.5, flashAlpha 0.85→0.55)
  AND a budget dial that drops bloom at `medium`, drops zoom-blur at
  `low`, and detaches all filters at `minimal` (matching the 2026-05-21
  safe state).
- **Shield aura** uses ONE shared GlowFilter on a global container, NOT
  per-entity. Per-entity filters would directly regress the same warp-
  disable rationale at N-shielded-ships scale.
- **Touch-device default** is `medium` quality (pinned at the
  `PerfMonitor`/budget-push level — landing under M9's broader policy
  work). Bloom shader pass — the heaviest single contributor — is
  never attached on touch in production by default.
- **`?effects=0`** URL escape hatch skips construction entirely — runtime
  fallback to today's inline Graphics flames + starburst destruction.

## Test coverage

Unit (vitest):
- `EffectsBudget.test.ts` — every tier transition + hysteresis + IPC-
  only-on-transition lock
- `EffectsService.test.ts` — skeleton, re-entrancy, escape hatch
- `DestructionFx.test.ts`, `EngineEmitter.test.ts`, `LaserGlow.test.ts`,
  `ShieldAura.test.ts` — per-effect manager contracts
- `particleEmitterCompat.test.ts` — `@pixi/particle-emitter` imports
  cleanly under node

Integration (vitest):
- `mirrorToEngineEmitter.test.ts` — mirror.thrustingShips → setContinuous
  contract
- `handleDamageSpawnsImpact.test.ts` — DamageEvent → pendingEffectTriggers
- `transitResetEffects.test.ts` — sector handoff wipes state

Protocol (vitest):
- `protocol.test.ts` — structuredClone round-trip for every new variant

E2E (Playwright) — deferred to a follow-up:
- `visual-effects-sandbox.spec.ts` — each effect radio shows the right
  panel + the effect runs without console errors
- `effects-in-combat.spec.ts` — destroying a lingering hull spawns burst
  at hull's last pose, NOT (0,0)

## Known follow-ups

1. **Snapshot-wire `shieldDown` for player ships** — closes the cold-
   start gap where a remote player who joined after their shield broke
   shows no aura until the next DamageEvent.
2. **Per-effect slider tuning panels** in the sandbox (full Copy-JSON
   parity with warp).
3. **`@pixi/particle-emitter` EmitterPool** wrapper for continuous
   emission — the hand-rolled engines work but the library has built-in
   particle behaviour tracks (texture, alpha, scale, rotation lists)
   that would be cheaper than the per-particle Graphics mutation we do
   today.
4. **Predicted impact sparks** — currently authoritative-only; if smoke
   reports "number pops, spark lags" add `pendingEffectCancels` + `tag`
   field on `pendingEffectTriggers` mirroring the `clientShotId`
   weapon-hit-prediction path for damage numbers.
5. **`benchmarks/effects-gc.bench.ts`** — lock the "≤ 200 particle
   allocs/sec at `high` quality" budget the plan committed to.
6. **On-device smoke** — capture `raf_gap` distribution under combat
   with effects ON, confirm budget transitions hold under the 10 ms RAF
   cap.

## Client rules in detail

Moved verbatim from `src/client/CLAUDE.md`, which keeps the short form of each rule and points here.

- **Game-space coords handed to the renderer scene graph MUST flip Y (2026-05-15).** Game space is Y-up; the Pixi `world` container is Y-down. Every sprite/beam/mount/halo obeys `pixiY = -gameY` (`sprite.y = -ship.y`). The warp world-anchor (`{kind:'world'}`, game-space from `mirror.ships`) broke this — it projected `+worldY` through `world.toGlobal` and the ripple appeared at the ship's *vertical mirror* (off-screen at non-zero spawn Y; "bottom right" smoke report). Fix: the pure `resolveWarpFilterCenter` helper (exported from `PixiRenderer.ts`, locked by `PixiRenderer.warpCenter.test.ts`) negates Y for the world branch; `screen`/`null` anchors pass through. **A superseded fix multiplied the filter centre by `renderer.resolution` (HiDPI `uInputSize` theory) — that was WRONG; do not re-add it.** On-device evidence is decisive: the sandbox screen-centre warp was confirmed pixel-correct on a DPR-3 phone with no scaling, so the renderer screen frame already matches the filter `uInputSize` frame. Heuristic correction: a renderer bug that "only happens on the phone" is NOT automatically a missing `× resolution` — a game/Pixi frame mismatch (Y-flip, origin offset) produces the identical on-device-only symptom because the error is invisible at spawn-origin and only grows as you move. Prefer fixes derived from on-device observations over engine-internals theory. See `docs/LESSONS.md` 2026-05-15. **The opposite mistake is flipping twice:** `FxExplosions.spawn` (and the other `art/fx` APIs that say "game space") flip Y themselves, so hand them GAME coords. The naval-shell burst stored `-p.y` and burst at the shell's Y mirror (2026-11-10, ~380 px above the fighter it hit); it now lives in `art/fx/navalShellBursts.ts`, locked by `navalShellBursts.test.ts` (burst lands on the drawn shell sprite).

### Damage numbers and health bars

- `mirror.pendingDamageNumbers` and `mirror.pendingHealthBarHits` are per-frame **drain queues** populated by `ColyseusClient.handleDamage()` and consumed by `PixiRenderer.update()`. They are arrays, not maps — every entry is consumed once per frame.
- `DamageNumberManager` ([render/DamageNumbers.ts](../../src/client/render/DamageNumbers.ts)) — **accumulator model (2026-05-30, plan melodic-engelbart Step 4).** One floating-number bucket per `targetId` at any time. Each `spawn(targetId, x, y, damage, tag?)` either adds to the existing bucket (running total grows, font scales via `fontScaleForTotal`, stay-window resets, text re-anchors at the new hit coord) OR opens a fresh bucket (evicting the bucket with least life remaining if at `POOL_CAP=20`). **One number per screen spot (2026-11-11, pile-up fix):** a hit on a target with no bucket first folds into any live bucket within `MERGE_RADIUS_PX` (36 CSS px, converted by `1/camera.scale`) via the pure `findCoalesceIndex` ([render/damageNumberCoalesce.ts](../../src/client/render/damageNumberCoalesce.ts)) — a packed melee or a splash otherwise stacked several black-stroked numbers on one spot, which read as dark/red blocks inside fireballs. Live buckets sit in a dense `live[]` array (swap-remove) so every loop is iterator-free (#14). After `STAY_FRAMES` (36, ~0.6 s @ 60 Hz) with no new hits the bucket fades over `FADE_FRAMES` (24, ~0.4 s) and is destroyed (was 60 + 30: "linger"). Draw order is already right: the manager's container is added to the world after `shipContainer` (which holds the FX explosion layers), so numbers draw above fireballs. Locks: `damageNumberCoalesce.test.ts`, `DamageNumbers.test.ts`, `tests/e2e/damage-number-lifetime.spec.ts`. **No number climbs after its target dies (2026-11-13 fight-clip review):** on a kill, `ColyseusClient.flushQueuedDamageFx` releases the queued hit visuals for that id (smooth-beam splits, naval hits held for their burst) in the explosion's frame, and `PixiRenderer` calls `DamageNumberManager.markDead` for each `explodingShips` id AFTER draining the frame's spawns: the closed number finishes its float but takes no late hit on its id and no coalesced hit from anything near it. Locks: `ColyseusClient.damageAfterDeath.test.ts` + the after-death case in the e2e spec above. Pre-accumulator the manager `new Text(...)`-ed per hit at ~30 Hz under held fire — aggregating into ~1 bucket per active target reduces text-construction churn by an order of magnitude (the dominant non-FX allocation cost surfaced by the imperative-taco hostile CDP profile). `cancelByTag(tag)` subtracts the predicted contribution from each bucket the tag touched and destroys buckets whose total drops to zero; per-tag contributions are tracked in a lazy `Map` allocated only on tagged adds (auth-only buckets — the common case — never allocate it). Server provides `hitX`/`hitY` in `DamageEvent`; falls back to entity-pose if absent.
- `HealthBarManager` ([render/HealthBars.ts](../../src/client/render/HealthBars.ts)) shows a bar above an entity only when the local player has just hit it (`evt.shooterId === localId`). Bar fades after 2 s with no consecutive hits and removes after 2.5 s. Position is read from `mirror.ships` or `mirror.swarm` each frame so the bar tracks moving targets.

### Effects subsystem (2026-05-27, plan `wiggly-puppy` M1)

A first-class visual-effects subsystem lives under `src/client/effects/`. Contracts in `src/core/contracts/IEffects.ts`. The subsystem owns warp re-enable, laser glow + impact sparks, shield aura, particle ship-destruction, and particle engines. Live preview lives at `__offscreen-spike__/visual-effects-sandbox.html`.

**Ownership rules (Invariant #12 — one ownership site per state surface):**

- **Warp methods stay on `IRenderer`.** `setWarpMode` / `triggerWarpIn` / `setWarpCenter` / `setLoadCurtain` are NOT duplicated on `IFilterEffects`. `EffectsBudget` controls warp filter detach/attach by holding a direct reference to `WarpFilterChain` and calling its `applyQuality(level)` method (added in M3). No facade, no parallel path.
- **`EffectsService` is constructed inside `PixiRenderer.init`** — one construction site per renderer instance, covers both the OffscreenCanvas worker path and the touch-device main-thread fallback.
- **`ColyseusClient` never imports `EffectsService`.** Effect triggers flow through `RenderMirror.pendingEffectTriggers` (added in M2), drained by `PixiRenderer.update(mirror)` on `shouldRender` (worker every-other-RAF). Same gating pattern as `explodingShips` — extending `perFrameTriggers.ts` is mandatory for any new one-shot mirror queue.
- **`EffectsService.tick(now, dt)` runs INSIDE `PixiRenderer.update(mirror)` at the tail, AFTER `updateSwarmSprites`** — guarantees one-pose-per-frame (the rule under "Drones are PURE snapshot-interpolated"). NEVER call `tick` from a separate Pixi ticker callback; that would resolve poses at a divergent `now` and reintroduce the 2026-05-19 jitter bug class.

**Engine exhaust is PARTICLE-ONLY (`EngineEmitter`) — the legacy triangle flames are GONE (engine-fx pass, plan `majestic-pie`).** The `buildThrustFlameGfx`/`buildBoostFlameGfx` ship-child triangles + the `thrustFlames`/`boostFlames` maps were deleted; `EngineEmitter` is now the SOLE engine visual at every quality tier. Load-bearing details:

- **The pose handed to the emitter is GAME-SPACE.** `PixiRenderer.init`'s `getEntityPose` closure goes through the pure [`render/pixi/entityPoseFromSprite.ts`](../../src/client/render/pixi/entityPoseFromSprite.ts) helper, which un-negates BOTH the sprite's Y and its `rotation` (`sprite.rotation = -ship.angle`, so game angle = `-rotation`). The pre-fix closure returned `angle: sp.rotation` (Pixi-space), and because the emitter does game-space trig, `sin`'s odd symmetry **mirrored the exhaust to the wrong side** — the smoke-reported bug. The closure mutates a REUSED scratch (`_enginePoseScratch`) and fills `vx/vy` from `_lastMirror.ships` (the sprite carries no velocity), so the per-frame poll is alloc-free (#14). `ShieldAura` shares the callback but reads only x/y — the angle fix is side-effect-free. Lock: `entityPoseFromSprite.test.ts` (seam, failing-first) + `EngineEmitter.test.ts` spawn-side (math).
- **Per-kind nozzle + plume scale are computed at REGISTRATION** (not per frame) by the pure [`render/pixi/engineGeometry.ts`](../../src/client/render/pixi/engineGeometry.ts) `engineProfileForKind()` — `sternOffset` from the hull's polygon rear extent, `plumeScale` from `radius / fighterRadius`. Threaded through `setContinuous(id, kind, active, radius?, engine?)` → `EngineEmitter.setActive` (mirrors how shield `radius` threads; `radius` stays shield-only). NO new catalogue field / no `SHIP_KINDS_LIST` reorder / no `SHIP_KIND_CATALOGUE_VERSION` bump (a render-only derived offset isn't a stored stat).
- **Emission is speed-scaled; particle velocity is PURE astern ejection.** `rateHz` and `ejectSpeed` scale by `clamp(speed/refSpeed, minRateFrac, 1)` (idle thrust sputters at the floor; fast streams densely + ejects harder). Each particle's WORLD velocity is the astern ejection cone ONLY — the plume trails naturally because the ship races forward while the exhaust shoots astern (faster ship ⇒ longer relative trail), and it can NEVER render on the forward side. **Do NOT re-add ship-velocity inheritance** (`pose.v × streamFactor`): it rendered the exhaust on the FORWARD side at high ship speed (smoke 2026-06-07; the analytic "relative velocity is always astern" argument is correct yet the rendered result was forward — trust the measurement, removed it). Lock: `engine-particles-probe.spec.ts` "exhaust stays astern at high ship speed" reads the particles' WORLD positions (camera-independent) via the `__debugEngine` test hook. Drones never register engine emitters and aren't in `mirror.ships`, so they get NO engine particles; `vx/vy` resolve to 0 (used only for the speed scaling).
- **`minimal` tier emits a SPARSE plume, not zero** (`thrustRateMul 0.35`). With no flame fallback, every device must still show exhaust.
- **Particles are additive white-baked 2-layer dots; colour-over-life is per-frame `gfx.tint`** (white-hot → kind hue → smoke, pure integer lerp). The tint-keyed free-pool routes by the BASE hue (`p.tint`), NEVER the transient display tint. All tuning in `DEFAULT_ENGINE_PARAMS` (`effectDefaults.ts`). Visual-verification harness: the main-thread `PixiRenderer` probe `__offscreen-spike__/engine-particles-probe.html` + `tests/e2e/engine-particles-probe.spec.ts` (deterministic) and `engine-particles-flight.spec.ts` (real pipeline) → `diag/e2e-screenshots/engine-particles/`.

**Budget tiers + thresholds (lock at `src/client/effects/EffectsBudget.ts`):**

| Transition | Trigger | Hold |
|---|---|---|
| `high → medium` | EMA(rendererUpdateMs) > 6 ms | 500 ms |
| `medium → low` | EMA > 8 ms | 500 ms |
| `low → minimal` | EMA > 9 ms | 250 ms |
| `minimal → low` | EMA < 7 ms | 750 ms |
| `low → medium` | EMA < 6 ms | 1500 ms |
| `medium → high` | EMA < 4 ms | 1500 ms |

Recovery thresholds are 2 ms lower than the downshift trigger AND require a 3× longer hold to prevent flicker. EMA alpha = 0.06 (~16-sample / ~270 ms response). Warmup = 8 samples held at `high`.

**Push-vs-pull discipline:**

- Per-frame metrics are fed to the budget by `EffectsService.tick`. Per-effect modules **pull** the resolved quality via `EffectsService.getQuality()` each frame (pull avoids per-transition allocations).
- The main-thread `PerfMonitor` (M9) computes `rafGapMs` EMA separately and pushes via `SET_EFFECT_QUALITY` **only on its own tier transition** (≤ once per 500 ms). NEVER per-frame. Lock: `EffectsBudget.test.ts` "100 frames at constant load → exactly 0/1 transitions".
- The budget keeps the more-restrictive of (locally-resolved tier, pushed tier) via `pickMoreRestrictiveQuality`. Pushed tier never weakens local resolution.

**Sector handoff (M9 wiring landed):** `EffectsService.resetForSectorHandoff()` is called from `ColyseusClient.resetPredictionState()` via the `onSectorHandoff` callback (sibling line to `rearmJoinReadiness()` — SRP per zone). The renderer's `resetEffectsForSectorHandoff()` method wipes per-entity continuous emitters + in-flight bursts + shield rings AND clears the diff trackers (`_activeThrustIds`, `_activeBoostIds`, `_activeShieldIds`) so the destination sector's first frame re-registers cleanly. `mirror.pendingEffectTriggers.length = 0` happens inside `resetPredictionState` for source-coord trigger drainage. Lock test: `src/client/net/transitResetEffects.test.ts`.

**`@pixi/particle-emitter` notes (M0.5 spike):**

- v5.0.10 is the latest released version; typed against Pixi v7 (`Container<DisplayObject>`). Pixi v8 renamed the child constraint to `ContainerChild`. Runtime is compatible; types disagree. Cast at the construct site or own a typed wrapper in `effects/pools/EmitterPool.ts`.
- Static-analysis evidence the library is worker-safe (M0.5 spike): zero references to `document.` / `window.` / `addEventListener` / `navigator.` / `location.` / `requestAnimationFrame` in `node_modules/@pixi/particle-emitter/lib/particle-emitter.es.js`. Live OffscreenCanvas probe at `__offscreen-spike__/particle-emitter-probe.html`.

**Escape hatch:** `?effects=0` URL param skips `EffectsService` construction entirely — falls back to today's inline Graphics paths for destruction + flames. Mirrors `?worker=0`.
