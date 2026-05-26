/**
 * Worker → Main wire format. Discriminated union on `type`; every
 * variant is structured-cloneable. Locked by `protocol.test.ts`.
 */

import type { RendererFeedback } from '@core/contracts/IRenderer';

/** Sent once after Pixi `app.init` completes. */
export interface ReadyMsg { type: 'READY' }

/**
 * Renderer feedback for the main thread's `getFeedback()` cache.
 * Posted once per frame at the tail of the worker's render loop.
 * See `RendererFeedback` for field semantics.
 */
export interface FeedbackMsg {
  type: 'FEEDBACK';
  feedback: RendererFeedback;
}

/**
 * `GalaxyMapLayer` hex tap — the worker fires this when its
 * pointer-event state machine resolves a tap on a sector hex. Main
 * thread routes to `handleEngageTransit(sectorKey)`.
 */
export interface OverlayTappedMsg {
  type: 'OVERLAY_TAPPED';
  sectorKey: string;
}

/**
 * Uncaught exception in the worker. Surfaces in the main-thread proxy
 * for logging / fallback decisions; not a contract for recovery.
 */
export interface WorkerErrorMsg {
  type: 'ERROR';
  message: string;
}

/**
 * Per-frame worker-side sub-cost markers (F1 of the warp-spool perf
 * investigation — `docs/HANDOFF-warp-spool-perf-followup.md`). All the
 * worker-side per-frame costs for ONE frame, collected by
 * `PixiRenderer.update()` and shipped here so the main thread can
 * re-emit each via `logEvent` (the worker has no `window.__eqxLogs`).
 *
 * **Why a separate message and NOT a `RendererFeedback` field**: a
 * `markers?` field on `RendererFeedback` (`src/core/contracts/IRenderer.ts`)
 * would piggyback the existing per-frame `FEEDBACK` postMessage with no
 * new message type — BUT `RendererFeedback` is a phase-gated closed-set
 * DI contract (its docstring + `src/client/CLAUDE.md` mandate a
 * phase-gate review for every new field, because each entry permanently
 * expands the worker→main per-frame payload). This is diagnostic-only
 * scaffolding, not a contract surface, so it gets its own gated
 * message instead: zero contract change, and zero cost when
 * diagnostics are off (the worker only posts this when
 * `SET_DIAG_MARKERS { enabled: true }` was received).
 *
 * Plain primitives only — structured-cloneable, no Maps/handles. Locked
 * by `protocol.test.ts`.
 */
export interface FrameMarkers {
  /** `PixiRenderer.update()` entry→exit wall-clock (ms). */
  rendererUpdateMs: number;
  /** `this.sprites.size` at the end of `update()` — entity-count proxy. */
  spriteCount: number;
  /** `tickWarpShockwaves` entry→exit wall-clock (ms). ~0 when warp inactive. */
  warpTickMs: number;
  /** Active stacked `ShockwaveFilter` count (`warpShockwaves?.length ?? 0`). */
  filterCount: number;
  /** `app.stage.filters.length > 0` at the END of this frame. The big
   *  diagnostic — if this stays `true` indefinitely across many frames
   *  (rather than cycling within ~1.5 s burst windows), the warp filter
   *  chain is stuck attached and the GPU is running the full shockwave
   *  + zoom-blur + bloom pass every frame. Render-jitter-fix Phase 1b
   *  (2026-05-21). */
  warpFiltersAttached: boolean;
  /** Wall-clock ms since `warpBurstStartedAt`, or -1 when no burst is
   *  in flight. Pairs with `warpFiltersAttached` to characterise the
   *  attach/detach cycle. */
  warpBurstAgeMs: number;
  /** `BackgroundGrid`: `computeGridLabels` + new-`Text` create loop (ms). */
  gridLabelSpecMs: number;
  /** `BackgroundGrid`: cost folded into the spec/create bracket — see
   *  `BackgroundGrid.lastFrameMarkers`. Kept distinct so the analyzer
   *  can attribute label-spec vs text-create separately if the split
   *  is later refined. */
  gridTextCreateMs: number;
  /** `BackgroundGrid`: the destroy/`labels.delete` cleanup loop (ms). */
  gridCleanupMs: number;
  /** `BackgroundGrid` live label `Text` count after this frame. */
  gridLabelCount: number;
}

/**
 * Per-frame diagnostic markers. Posted by the worker at the tail of
 * `MIRROR_UPDATE` ONLY while `SET_DIAG_MARKERS { enabled: true }` is in
 * effect. The main side (`WorkerRendererClient`) re-emits the fields as
 * `logEvent('renderer_update' | 'warp_tick' | 'grid_update', …)`.
 */
export interface FrameMarkersMsg {
  type: 'FRAME_MARKERS';
  markers: FrameMarkers;
}

export type WorkerToMainMsg =
  | ReadyMsg
  | FeedbackMsg
  | OverlayTappedMsg
  | WorkerErrorMsg
  | FrameMarkersMsg;
