# Warp Visual System

*The story of the in-game warp/transit effect: what it is, why it is built
the way it is, what it cost us to get right, and what is still open.*

This is the canonical prose guide (project Invariant #10). Rules live in
the CLAUDE.md files; gotchas live in `docs/LESSONS.md`; this captures the
*why* and the migration path. Shipped on branch `wip/pixi-filters-warp`
(commits `9c0828b` → `66ac347` → `5d87075`).

---

## 1. What the player sees

On entering a sector — fresh join or inter-sector transit — the gameplay
canvas runs a short full-screen warp effect anchored to the ship: a stack
of expanding shockwave rings + a radial zoom-blur + a bloom bloom-up,
under a dark "load curtain" that lifts into an arrival flash once the
client is synced. A `WARP STABILISATION X%` caption counts up over a 5 s
minimum floor. Remote ships warping in/out of your sector get a one-shot
ripple at their entry/exit point.

The effect exists to **mask two unavoidable latencies** — the sector
load, and the ~5 s the reconciler needs to receive its first snapshot and
settle the local prediction — so the player never sees the ship
"teleport" when the first server correction lands.

## 2. Architecture — render-mirror, not an overlay

The warp visual is **not** a React/DOM overlay and **not** event-driven.
It is a Pixi filter chain applied to `app.stage` inside the
**OffscreenCanvas renderer worker** (Phase 4 of the worker migration).
The renderer polls the render mirror every frame; warp state is part of
that per-frame data, never the discrete event bus (per the root
CLAUDE.md Event Bus rules).

Filter chain (current, post-`5d87075`): `ShockwaveFilter` ×N (phase
spool) → one-shot `ShockwaveFilter` burst → `ZoomBlurFilter` →
`BloomFilter`, applied to `app.stage`. Single canvas, single Pixi
`Application` — no second canvas.

**Why this chain.** The first pass used `OldFilmFilter` +
`GlitchFilter`. `GlitchFilter` calls `document.createElement('canvas')`
which throws `document is not defined` in the worker; `OldFilmFilter`'s
per-frame procedural noise regeneration starved the mobile main thread.
Both were dropped for the pure-shader chain above. **Do not reintroduce
DOM-touching pixi-filters into the worker path.**

Key seams:
- `IRenderer` (`src/core/contracts/IRenderer.ts`) — `setWarpCenter`,
  `triggerWarpIn`, `pendingWarpEvents`. Adding a field here is a
  phase-gate review (it widens the per-frame postMessage payload).
- Worker wire format: `src/client/render/worker/protocol.ts`
  (structured-cloneable discriminated unions only).
- `WorkerRendererClient` falls back to the still-alive main-thread
  `PixiRenderer` on browsers without OffscreenCanvas (Safari < 17).

## 3. The anchor model (and the three iterations it took)

`resolveWarpFilterCenter` (pure, exported from
`src/client/render/PixiRenderer.ts`, locked by
`PixiRenderer.warpCenter.test.ts`) maps a `WarpCenter` to filter-space
pixels each frame:

- `{kind:'entity', entityId}` — **the production path.** The renderer
  re-resolves `entityId` to that ship's *live sprite* **every frame**, so
  the effect tracks the ship through the whole spool. Id-agnostic:
  local / remote / bot, no special-case.
- `{kind:'world'}` — a fixed game-space point, used **only** for a
  despawned remote warp-out. Game space is Y-up, the Pixi `world`
  container is Y-down, so the world branch **negates Y**
  (`pixiY = -gameY`).
- `{kind:'screen'}` / `null` — screen-space passthrough (sandbox /
  fallback).

The path here was earned the hard way (see `docs/LESSONS.md`
2026-05-15):

1. **`× renderer.resolution` (HiDPI theory) — WRONG, reverted.** A
   superseded fix multiplied the centre by the device pixel ratio.
   On-device evidence killed it: the sandbox screen-centre warp was
   pixel-exact on a DPR-3 phone with no scaling, so the renderer screen
   frame already matches the filter `uInputSize` frame. **Do not
   re-add.** Heuristic: a renderer bug that "only happens on the phone"
   is *not* automatically a missing `× resolution` — a game↔Pixi frame
   mismatch (Y-flip, origin) produces the identical on-device-only
   symptom because the error is invisible at spawn-origin and only grows
   with distance.
2. **Game→Pixi Y-flip missing on the world anchor.** The ripple
   appeared at the ship's vertical mirror — off-screen at non-zero spawn
   Y (the "bottom right" smoke report). Fixed by negating Y in the
   world branch.
3. **Anchor captured once at spool-start → froze** while the ship flew
   ~539 u over the 3.6 s spool. Fixed by the per-frame live-sprite
   re-resolution of the `{kind:'entity'}` anchor above.

The standing lesson, encoded in `src/client/CLAUDE.md`: **prefer fixes
derived from on-device observation over engine-internals theory.**

## 4. Server side — why a stationary new arrival doesn't teleport

`SectorRoom` force-broadcasts snapshots for `JOIN_BROADCAST_GRACE_TICKS`
(300 ticks = 5 s) after every join / spawn / reconnect-rebind, bypassing
Stage-5 idle-suppression regardless of motion. Without it a freshly
spawned stationary ship in a quiet sector got *zero* snapshots until the
player moved, and the first one then snapped the stale free-run
prediction hundreds of units — the visible "warp in, stay still, move,
teleport" bug. The 5 s window deliberately matches the client's
`joinMinimumElapsed` warp-curtain floor so the correction lands beneath
the curtain. See `src/server/CLAUDE.md` → Thresholds.

Remote-ship visuals: `TransitOrchestrator` (commit) and `SectorRoom`
(join/respawn) broadcast `warp_out` / `warp_in`
(`src/shared-types/messages.ts`) to everyone *except* the subject; the
client renders a one-shot `triggerWarpIn()` ripple at the broadcast
`(x, y)`.

## 5. Load curtain + arrival flash

`setLoadCurtain(active)` drives an independent dark Graphics tween
(quick ~200 ms rise to hide the canvas, ~380 ms fade aligned to the
arrival flash). It is decoupled from the filter chain — the curtain can
be up while filters are detached. `useGameReady` requires all of:
connected + welcomed + first-frame + 5 s-elapsed; warp mode is active
only during transit SPOOLING. By the time the curtain fades, the
on-screen pose *is* the server-authoritative one.

**Phase G (2026-05-16) — transit re-arms join-readiness; single arrival
flash.** A pure inter-sector transit keeps `phase==='game'`, so
`setPhase` never re-armed the readiness flags (its comment claimed it
did — same defect class as the 7829d04 spatial bug). The `transit_ready`
handler now calls `useUIStore.getState().rearmJoinReadiness()` as a
sibling to `resetPredictionState()`: it clears `firstSnapshotApplied` +
`joinMinimumElapsed` and bumps `joinGeneration` (the 5 s-floor
`useEffect` is keyed on it, so the floor re-runs per transit — a pure
transit doesn't remount GameSurface, so the old `[]`-dep effect armed
the floor exactly once per session). `rendererFirstFrameRendered` is
deliberately NOT re-armed on transit — the renderer stays live
(GPU-init lag is an initial-join concern; `setPhase` resets 3 flags,
`rearmJoinReadiness` resets 2). `WarpScreen` now reads `useGameReady()`
directly (a prior local copy had drifted to 4 gates vs the canonical
5). **Bug A ("double arrival flash") was a consequence of Bug B**, and
its fix came in two on-device-corrected steps:

- **G1/G2 (Option B — "keep the climax, mask it") — falsified
  on-device.** Re-arming `gameReady→false` at `transit_ready` raises
  the curtain *before* the IN_TRANSIT spool-exit `setWarpMode(false)`
  burst, intending to hide it. On-device (2026-05-16 user smoke test)
  this was pure downside: the climax is now *always* occluded, and the
  ~200 ms curtain-rise tween vs the fast room-swap let it BLEED
  through — a leaky flash "while the cover is on", then the 5 s floor,
  then the real arrival flash: a reordered double-flash with a
  blackout between. A theoretical "mask it" choice falsified by the
  device.
- **G3 (Option A — single flash, the shipped design).** The burst now
  fires from exactly ONE site: the arrival reveal (`triggerWarpIn`).
  `setWarpMode(false)` only fades the filter chain out — no burst.
  Both `fireBurst()` call-sites defer to the pure `warpEventFiresBurst`
  policy (beside `shouldDetachWarpVisual`), so `'warp-mode-off'` /
  `'warp-mode-on'` never burst and a future re-introduction trips
  `PixiRenderer.warpBurst.test.ts`. Net warp-out: source-side spool
  visual → curtain up → 5 s floor hold → curtain drop + ONE arrival
  flash.

One root (the Bug-B re-arm gap), fixed at one ownership site; the
flash policy then centralised. See `docs/LESSONS.md` 2026-05-16
Phase-G entries. The three warp effects + the `loading` derivation
live in `src/client/useWarpOrchestration.ts` (a behaviour-preserving
extraction from `App.tsx`'s `GameSurface`,
`App.warpOrchestration.test.tsx`).

## 6. GalaxyMapLayer is worker-hosted

The in-game galaxy overlay (`GalaxyMapLayer`) lives in the renderer
worker. Pixi's event system doesn't initialise in a worker, so it uses a
custom `hitTest(screenX, screenY)`; the main thread forwards pointer
events and the layer posts `OVERLAY_TAPPED { sectorKey }` back. Note the
distinct surfaces: the **drawer** "Show galaxy map" opens
`GalaxyOverviewScreen` in `mode='select'` (`galaxy-overview-select`);
`GalaxyMapLayer` is the gameplay-canvas MAP/`M` overlay. (A stale E2E
selector here cost a debugging cycle — see the 2026-05-16 Phase-B note in
the plan history.)

## 7. Grid-cell readout

The HUD `Grid x,y` readout divides by 500 u, but labels were only drawn
at macro (2500 u) intersections, so the readout never landed on a
labelled line. Now every micro (500 u) intersection is labelled and the
micro grid alpha went 0.18 → 0.34 (it is now the primary spatial
reference). Pure `computeGridLabels` (`src/client/render/BackgroundGrid.ts`,
locked by `BackgroundGrid.labels.test.ts`).

## 8. Open / future — spool-window frame cost

One item is **deferred, not solved**: a ~29 ms mean frame confined to
the spool window and 4 transient `raf_gap`s (116–183 ms) at the transit
room-swap boundary on a DPR≈2.6 mobile GPU. The user reprioritized this
as the headline post-merge work, to be done **data-driven** (instrument
→ measure → attribute → fix only the indicted cost). It is tracked in
`docs/HANDOFF-warp-spool-perf-followup.md` (branch
`perf/warp-spool-frame-cost`). Preliminary code-reading suggests the
filter tick is *not* the dominant cost — but that is a hypothesis for
the markers to confirm, not a license to lighten the chain blind.

## 9. Test locks

| Surface | Lock |
|---|---|
| Anchor projection / Y-flip | `PixiRenderer.warpCenter.test.ts` |
| Filter detach/teardown | `PixiRenderer.warpDetach.test.ts` |
| Grid labels | `BackgroundGrid.labels.test.ts` |
| Join-grace force-broadcast | `tests/integration/sectorRoom/joinBroadcastGrace.test.ts` |
| warp_in/out broadcasts | `tests/integration/sectorRoom/warpBroadcasts.test.ts` |
| Transit commit/abort | `src/server/transit/TransitOrchestrator.test.ts` |
| Arrival prediction-drift reseed (7829d04) | `src/client/net/ColyseusClient.transitArrivalDrift.test.ts` |
| Transit join-readiness re-arm (Phase G) | `src/client/state/store.rearmJoinReadiness.test.ts` |
| WarpScreen re-show on consecutive transits (Phase G) | `src/client/components/WarpScreen.transit.test.tsx` |
| Transit reset group: prediction + UI (Phase G) | `src/client/net/ColyseusClient.transitRearmReadiness.test.ts` |
| Single arrival flash / orchestration call-ordering (Phase G) | `src/client/App.warpOrchestration.test.tsx` |
| Warp burst policy — only the arrival reveal bursts (Phase G3) | `src/client/render/PixiRenderer.warpBurst.test.ts` |
| Warp-screen lifecycle (E2E) | `tests/e2e/join-warp-screen.spec.ts` |

## 10. See also

- `docs/LESSONS.md` — 2026-05-15 entries (Y-flip, on-device-evidence,
  entity-anchor, debugging discipline); 2026-05-16 entries (arrival
  prediction-drift; Phase-G transit join-readiness re-arm + the
  Bug-A-is-a-consequence-of-Bug-B coupling).
- `src/client/CLAUDE.md` → Renderer Rules (the Y-flip rule), Renderer
  worker boundary.
- `src/server/CLAUDE.md` → Thresholds (`JOIN_BROADCAST_GRACE_TICKS`).
- `docs/architecture/snapshot-cadence.md` — the idle-suppression the
  join-grace overrides.
- `docs/HANDOFF-warp-spool-perf-followup.md` — the open perf work.

## Client rules in detail

Moved verbatim from `src/client/CLAUDE.md`, which keeps the short form of each rule and points here.

- **Warp burst fires on arrival ONLY — single-flash policy (2026-05-16, Phase G3).** Exactly one warp flash per inter-sector transit: the arrival reveal (`triggerWarpIn`). `setWarpMode(false)` (spool exit) fades the filter chain out but does NOT burst, and `setWarpMode(true)` (spool start) ramps amplitude (no pulse). Both `fireBurst()` call-sites defer to the pure `warpEventFiresBurst(event)` policy (exported from `PixiRenderer.ts` beside `shouldDetachWarpVisual`, locked by `PixiRenderer.warpBurst.test.ts`). Why: post-Phase-G the load curtain is always raised at `transit_ready` (before SPOOLING→IN_TRANSIT), so a spool-exit burst is permanently occluded yet bleeds through the ~200 ms curtain-rise — a leaky reordered double-flash (on-device 2026-05-16). The earlier theoretical "keep the climax, mask it" was falsified on-device; do not re-introduce a warp-out / spool-start burst. See `docs/LESSONS.md` 2026-05-16 Phase-G3 entry.

- `DEFAULT_WARP_PARAMS` (in `worker/protocol/warpParams.ts`) toned down: `spoolCount` 4→2 (half the shader passes), `spoolAmplitude` 18→10, `climaxAmplitude` 220→70 (third), `flashAlphaMax` 0.85→0.55. (`bloomStrengthMax` removed in R2.9.) **Phase 3 (#10) "subtler ripple":** `climaxAmplitude` 70→40, `burstAmplitude` 220→140, `flashAlphaMax` 0.55→0.35, and the `climaxDurationMs`/`burstDurationMs` +50% (1100→1650 / 1500→2250) so the same envelope reads as a gentler wave spread over a longer distance. Locked by `warpParams.test.ts`. (On-device sign-off is a follow-up.)
- `WarpFilterChain.applyQuality(level)` is the budget hook (ONE ownership site for warp filter attach/detach — `IFilterEffects` deliberately does NOT duplicate the surface, per Invariant #12). Dials (post-R2.9, no bloom):
  - `high`    : full chain (shockwaves + zoom-blur + burst)
  - `medium`  : same as high (bloom — the former high-only pass — removed)
  - `low`     : drop zoom-blur (shockwaves + burst only)
  - `minimal` : detach all filters (matches the 2026-05-21 safe state)
- **Touch-device default is `medium`** (pinned in M9 alongside the `PerfMonitor` wiring). EffectsBudget can still drop to `low`/`minimal` on EMA pressure.
- **Load curtain (WS-14/R2.26-curtain):** `setLoadCurtain(active)` drives the dark overlay via the pure `curtainAlphaAt` — the RISE is now INSTANT (opaque before the destination sector renders, so it never flashes through) while the FADE-OUT (arrival reveal) keeps the 380 ms tween.
- The single-flash arrival-only policy (2026-05-16 Phase G3) is unchanged. The `pendingWarpEvents` drain still calls `renderer.triggerWarpIn`. M3 only changes the FILTERS attached during the active warp envelope; it does NOT change which events fire bursts.

**Do not re-disable the chain wholesale** if a mobile regression appears post-M3 — first instrument the budget to confirm which tier is active during the regression, and dial `minimal` per-device if needed via the touch-default pin. The 2026-05-21 disable was a hammer; the budget tier dial is the surgical replacement.

## History

**Warp re-enable (M3, 2026-05-27) — supersedes 2026-05-21 disable.** The warp filter chain at `pixi/WarpFilterChain.ts` was disabled on 2026-05-21 ("Render-jitter-fix Phase 1b" — captures confirmed filters were not load-bearing for playability; the disable avoided duty-cycle cost on mobile). M3 re-enables it WITH a budget tier dial. **(WS-14/R2.9, 2026-06-13: the BLOOM/glow pass was removed ENTIRELY — "remove warp glow" — so `bloomStrengthMax`, the `warpBloom` filter, and `qualityIncludesBloom` are gone; the single subtle white arrival flash (`warpFlash`, fired by `triggerWarpIn`) is the only reveal. The tier notes below are historical — there is no bloom to drop now, so `high` == `medium`.)**
## Server implementation notes

> Moved from `src/server/CLAUDE.md`. The short rules stay there; this is the detail.

### From the server Thresholds section

Moved verbatim from the old "Thresholds" section of `src/server/CLAUDE.md`. The rules stay there in short form; current values are in [server-thresholds](server-thresholds.md). Dates, plan names and "was" notes below are history.

- **Warp/transit join-broadcast grace (2026-05-15)**: `JOIN_BROADCAST_GRACE_TICKS = 300` (5 s @ 60 Hz, [rooms/SectorRoom.ts](../../src/server/rooms/SectorRoom.ts)). On every join / spawn / reconnect-rebind the room sets `forceBroadcastUntilTick = currentTick + JOIN_BROADCAST_GRACE_TICKS`; while `serverTick < forceBroadcastUntilTick` the broadcast gate treats the sector as non-idle **regardless of motion** (`inJoinGrace` short-circuits `isSectorIdle`), so a just-joined stationary client gets the steady snapshot stream it needs to reconcile its prediction. Without it, Stage-5 idle-suppression starved a freshly-spawned stationary ship of snapshots until the player moved — then the first snapshot snapped the stale free-run prediction hundreds of units (the "warp / change-sector → stay still → move → teleport" smoke-test bug, diag 2026-05-15). 5 s deliberately matches the client's `joinMinimumElapsed` warp-curtain floor so the first correction lands *beneath* the curtain. Companion `warp_in` / `warp_out` broadcasts (`TransitOrchestrator` / `SectorRoom` → [src/shared-types/messages.ts](../../src/shared-types/messages.ts)) drive remote-ship warp visuals. Locked by [tests/integration/sectorRoom/joinBroadcastGrace.test.ts](../../tests/integration/sectorRoom/joinBroadcastGrace.test.ts) + [warpBroadcasts.test.ts](../../tests/integration/sectorRoom/warpBroadcasts.test.ts). Full feature story: [docs/architecture/warp-visual.md](warp-visual.md).
