/**
 * Wire protocol for the OffscreenCanvas renderer worker.
 *
 * Both directions are discriminated unions on `type` so the
 * message-handler switches are exhaustiveness-checked at compile time.
 * Plain TS types only — no class instances, no functions, no DOM
 * handles, no Pixi handles. Every variant must be structured-cloneable
 * so the postMessage hop costs nothing extra.
 *
 * See plan `~/.claude/plans/humble-strolling-coral.md` Phase 3 for
 * the migration context. The pattern follows
 * `src/core/physics/worker.ts` for the message-shape style (Node
 * worker_threads worker, not directly reusable in the browser).
 */

import type { RenderMirror, RendererFeedback } from '@core/contracts/IRenderer';

// ---------- Main → Worker ----------

/**
 * Initialise the worker. Sent once after `new Worker(...)`.
 * `canvas` MUST be transferred (second arg to postMessage) — the
 * main thread loses control of it.
 */
export interface BootMsg {
  type: 'BOOT';
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  /**
   * Device pixel ratio at boot. The main thread sizes the canvas to
   * physical pixels before transfer; the worker uses `resolution: 1`
   * + `autoDensity: false`. DPR changes at runtime arrive via RESIZE.
   */
  dpr: number;
}

/**
 * Per-frame render request. Posted by the main thread after
 * `gameClient.updateMirror()`. The renderer reads this snapshot;
 * the worker's response (if any) is asynchronous via FEEDBACK.
 *
 * `RenderMirror` is plain data — no DOM/Pixi handles. Verified
 * structured-cloneable by `protocol.test.ts`.
 */
export interface MirrorUpdateMsg {
  type: 'MIRROR_UPDATE';
  mirror: RenderMirror;
}

/** GalaxyMapLayer overlay state — driven by Zustand useEffects in `App.tsx`. */
export interface SetVisibleMsg { type: 'SET_VISIBLE'; visible: boolean }
export interface SetCurrentSectorMsg { type: 'SET_CURRENT_SECTOR'; sectorKey: string | null }
export interface SetTransitDockedMsg { type: 'SET_TRANSIT_DOCKED'; docked: boolean }

/**
 * Canvas resize. Width/height in physical pixels (main thread already
 * applied DPR). The worker resizes the renderer and any layer overlays.
 */
export interface ResizeMsg {
  type: 'RESIZE';
  width: number;
  height: number;
  dpr: number;
}

/**
 * Pixi ticker FPS cap. See `PixiRenderer.setTickerMaxFPS`. `null` =
 * pause entirely; `undefined` = remove cap; number = throttle.
 */
export interface SetTickerFpsMsg {
  type: 'SET_TICKER_FPS';
  fps: number | null | undefined;
}

/**
 * Warp-mode render state toggle. See `IRenderer.setWarpMode`. The
 * worker forwards to its `PixiRenderer.setWarpMode(active)` which
 * applies the filter chain + animates streaks on the same Pixi stage
 * as gameplay — no second canvas.
 */
export interface SetWarpModeMsg {
  type: 'SET_WARP_MODE';
  active: boolean;
}

/**
 * Native pointer event, forwarded from the main thread because
 * `OffscreenCanvas` has no DOM event source in the worker (per
 * pixijs/pixijs#9132). The worker hand-rolled camera consumes these
 * via a state machine (`Camera.onPointerDown/Move/Up`).
 */
export interface PointerEventMsg {
  type: 'POINTER_EVENT';
  native: SerialisedPointerEvent;
}
export interface WheelEventMsg {
  type: 'WHEEL_EVENT';
  native: SerialisedWheelEvent;
}

/** Tear-down request. Worker should clean its Pixi handles then `self.close()`. */
export interface DisposeMsg { type: 'DISPOSE' }

export type MainToWorkerMsg =
  | BootMsg
  | MirrorUpdateMsg
  | SetVisibleMsg
  | SetCurrentSectorMsg
  | SetTransitDockedMsg
  | ResizeMsg
  | SetTickerFpsMsg
  | SetWarpModeMsg
  | PointerEventMsg
  | WheelEventMsg
  | DisposeMsg;

// ---------- Worker → Main ----------

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

export type WorkerToMainMsg =
  | ReadyMsg
  | FeedbackMsg
  | OverlayTappedMsg
  | WorkerErrorMsg;

// ---------- Serialised event shapes (structured-cloneable) ----------

/**
 * Subset of `PointerEvent` fields the worker camera reads. Stamped
 * with `Date.now()` on the main thread so the worker can translate
 * to its own performance.now() timeline if needed (the two clocks
 * differ by an unknown offset).
 */
export interface SerialisedPointerEvent {
  type: string;
  pointerId: number;
  pointerType: string;
  button: number;
  buttons: number;
  clientX: number;
  clientY: number;
  offsetX: number;
  offsetY: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isPrimary: boolean;
  pressure: number;
  width: number;
  height: number;
  twist: number;
  tiltX: number;
  tiltY: number;
  stamp: number;
}

export interface SerialisedWheelEvent {
  deltaX: number;
  deltaY: number;
  deltaZ: number;
  deltaMode: number;
  clientX: number;
  clientY: number;
  offsetX: number;
  offsetY: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  stamp: number;
}
