# Renderer worker boundary — OffscreenCanvas

On desktop the Pixi renderer runs in a dedicated Web Worker that draws into an
`OffscreenCanvas`. The main thread keeps React, Zustand, input and networking;
it posts the per-frame `RenderMirror` and discrete commands to the worker and
reads a small `RendererFeedback` object back. Touch devices, and browsers
without `OffscreenCanvas`, run the same `PixiRenderer` on the main thread.

Moving parts:

- `src/client/render/worker/protocol.ts` — the message union in both directions.
- `src/client/render/worker/renderer.worker.ts` — the worker entry; hosts `PixiRenderer`.
- `src/client/render/worker/WorkerRendererClient.ts` — the main-thread `IRenderer`
  that posts to the worker (or falls back to `PixiRenderer`).
- `src/client/render/worker/Camera.ts` — the hand-rolled camera used in both paths.

The short rules are in `src/client/CLAUDE.md` "Renderer worker boundary".

## Client rules in detail

Moved verbatim from `src/client/CLAUDE.md`, which keeps the short form of each rule and points here.

- **`IRenderer.getFeedback(): RendererFeedback`** is the closed-set channel for renderer → main-thread data each frame. Today: in-renderer field, populated at the tail of `update()`. Future (Phase 4): main-thread cache, populated by `FEEDBACK` postMessages from the worker. **Adding a new field requires a phase-gate review** — every entry expands the per-frame postMessage payload. Phase-gated additions to date: `liveBeamRenderedFromX/Y` (smoke handoff 2026-06-06, Issue 1) — the ACTUAL drawn live-beam origin (the `BeamSpritePool` sprite transform), published as `data-beam-rendered-from-x/y`. It exists because `data-beam-from-x/y` RECOMPUTES the origin from the live ship pose and so passes even when the drawn beam is frozen; the render-cache detach bug (Bug #1) is only observable by reading what's actually drawn. `placementScreenX/Y` (same handoff, Issue 5) — the screen projection of the structure placement ghost pose, published as `data-placement-screen-x/y`, so the world-anchored confirm can sit over the blueprint. `placementConfirmSeq` (WS-10 R2.5) — a MONOTONIC counter the renderer bumps on a DESKTOP mouse left-click during placement; `gameRafLoop` edge-detects a change and commits the placement at the chosen point via `commitChosenPlacement`, then clears `placementKind`. A monotonic seq (not a one-shot bool) is robust to the FEEDBACK cache being read across several RAFs — the value only moves on a real click. `hoveredPickId` (WS-10 R2.4) — the id of the entity the desktop pointer is hovering over (set from pointer-move via `pickEntityAt`), driving the lighter `HoverBracket` outline; published as `data-hover-pick-id`. Renderer-local — NEVER Zustand (it updates at pointer-move cadence; #2). When you add a `RendererFeedback` field, thread it through all three worker sites (`renderer.worker.ts` FEEDBACK post, `WorkerRendererClient.emptyFeedback` + the FEEDBACK handler) or the worker render path silently lacks it.

- **The wire format is [`render/worker/protocol.ts`](../../src/client/render/worker/protocol.ts).** Discriminated unions in both directions; structured-cloneable variants only. No DOM handles, no Pixi handles, no functions. Locked by `render/worker/protocol.test.ts` (structuredClone roundtrip + compile-time exhaustiveness).

- **Forbidden imports inside `src/client/render/worker/**`** (CI-enforced): `react`, `react-dom`, `@mui/*`, `@emotion/*`, `zustand` — the worker has no DOM. State crosses the boundary via the protocol; main thread reads Zustand and posts the resulting messages.

- **`RenderMirror` is the per-frame wire payload** — already plain data (no Pixi handles, no functions). Any new field on `RenderMirror` must remain structured-cloneable.

- **pixi-viewport does NOT work inside an OffscreenCanvas-hosted runtime** — its Drag plugin calls `addEventListener` on `events.domElement`, which is undefined in a worker. Spike-verified 2026-05-14 (commit `2dd11d3`). Replacement: hand-rolled `Camera` class in the worker, prototype at [render/__offscreen-spike__/spike-worker.ts](../../src/client/__offscreen-spike__/spike-worker.ts).

- **Pointer / wheel / touch events are forwarded from the main thread.** The main thread installs DOM listeners on the gameplay canvas, serialises each event via the `SerialisedPointerEvent` / `SerialisedWheelEvent` shapes, and posts as `POINTER_EVENT` / `WHEEL_EVENT`. The worker's `Camera` consumes via a `onPointerDown / Move / Up` state machine.

- **Fallback for browsers without OffscreenCanvas** (Safari < 17): `WorkerRendererClient` constructor branches on `supportsOffscreenRenderer()` and returns `PixiRenderer` (still alive in [render/PixiRenderer.ts](../../src/client/render/PixiRenderer.ts)) on `false`. Production code never assumes worker rendering is available.

Why: Zustand triggers React re-renders on subscription changes. Putting per-frame spatial data in Zustand would cause 60 Hz React re-renders, which is a performance catastrophe. Spatial state lives in a plain-object render mirror that Pixi polls directly — no React involvement.

## History

Moved from `src/client/CLAUDE.md`: why the rule is what it is, with the measurements behind it.

The renderer is migrating off the main thread onto a dedicated Web Worker via `OffscreenCanvas`. Phase 3 has landed the scaffolding; Phases 4 + 5 host the actual Pixi `Application`s in the worker. See [plan](../../../.claude/plans/humble-strolling-coral.md) for the full multi-phase roadmap.

- **Touch devices DEFAULT to the main-thread `PixiRenderer`, NOT the worker (2026-05-22).** The selection logic in `App.tsx` is: `?worker=1` → force worker (if capable); `?worker=0` → force main-thread; no override → `!isTouchDevice() && supportsOffscreenRenderer()`. The OffscreenCanvas commit / worker→main IPC path produces ~110 ms tail-latency stalls on high-DPR Android phones; the 2026-05-22 smoke pair (capture `721mwk` worker-on vs `iph9cv` worker-off, same device same session) showed a **19× reduction in `raf_gap > 100 ms` events** (38 → 3) and 85 s of continuous zero-stall play. The `humble-strolling-coral` migration assumed the worker would be a perf win on mobile; the on-device measurement falsified that for at least this user's device. The render cost saved by off-loading Pixi (~1.5 ms / frame) is dwarfed by the ~110 ms IPC commit tail-latency. **Do not flip the touch default back without a fresh smoke** — and if you do, the smoke MUST measure `raf_gap` clusters under the cap (commit `9e23436`), not just frame time. The IPC mechanism is below JS — `longtaskCount30s=0` while `rafGapCount30s` climbed in `721mwk` — so reducing JS allocation pressure or capping work cadence cannot reach it.
