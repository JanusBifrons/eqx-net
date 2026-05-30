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
