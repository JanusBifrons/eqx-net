/**
 * Main → Worker wire format. Discriminated union on `type`; every
 * variant is structured-cloneable (no functions, no DOM/Pixi handles,
 * no class instances). Locked by `protocol.test.ts`.
 */

import type { RenderMirror, WarpCenter } from '@core/contracts/IRenderer';
import type { WarpParams } from './warpParams.js';
import type { SerialisedPointerEvent, SerialisedWheelEvent } from './serialisedEvents.js';

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

/** Sandbox-only: live-tune the active warp params. Production code never posts this. */
export interface SetWarpParamsMsg {
  type: 'SET_WARP_PARAMS';
  params: Partial<WarpParams>;
}

export interface SetWarpCenterMsg {
  type: 'SET_WARP_CENTER';
  center: WarpCenter | null;
}

/**
 * Sandbox-only: position the camera so a given world point sits at
 * screen centre. Used by the visual-effects sandbox to anchor world
 * (0, 0) at screen centre WITHOUT needing a local player ship to
 * follow. Production code uses Camera.follow on the local ship, not
 * this message.
 */
export interface SetCameraCenterMsg {
  type: 'SET_CAMERA_CENTER';
  worldX: number;
  worldY: number;
}

/**
 * Fire the "warp-in" companion effect — a flash + single big ripple at
 * the supplied centre, no preceding spool/climax. Used when a ship
 * arrives at a sector (the receiving end of a warp). `setWarpMode(false)`
 * fires the same flash+ripple at the moment of departure (the exit
 * burst). Production: per-ship-per-event, fired by the join/transit
 * flow with the ship's spawn world position.
 */
export interface TriggerWarpInMsg {
  type: 'TRIGGER_WARP_IN';
  center: WarpCenter | null;
}

/**
 * Show or hide the load curtain — an opaque overlay that hides the
 * canvas during the join + transit load periods. Driven by App.tsx
 * orchestration: visible while connecting, while waiting for the
 * first snapshot + readiness gates, and during the IN_TRANSIT /
 * ARRIVED travel window of inter-sector transit. The renderer alpha-
 * tweens between target states (200 ms rise, 380 ms fade — see
 * `CURTAIN_*_MS` in `PixiRenderer.ts`).
 */
export interface SetLoadCurtainMsg {
  type: 'SET_LOAD_CURTAIN';
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

/**
 * Toggle the worker's per-frame diagnostic-marker emission (F1 of the
 * warp-spool perf investigation — see
 * `docs/HANDOFF-warp-spool-perf-followup.md`). When `enabled` the worker
 * `postMessage`s a `FRAME_MARKERS` message at the tail of each
 * `MIRROR_UPDATE`; when disabled it posts NOTHING (zero extra IPC in
 * production). The cheap `performance.now()` brackets that produce the
 * numbers stay unconditional in the worker (sub-µs, uniform), so the
 * markers-off baseline is the production cost.
 *
 * Sent once at `WorkerRendererClient.init` based on `isDiagEnabled()`
 * (`?diag=1` in the URL OR `navigator.webdriver`), so E2E specs /
 * diagnostic captures get markers with zero cost on normal sessions.
 */
export interface SetDiagMarkersMsg {
  type: 'SET_DIAG_MARKERS';
  enabled: boolean;
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
  | SetWarpParamsMsg
  | SetWarpCenterMsg
  | SetCameraCenterMsg
  | TriggerWarpInMsg
  | SetLoadCurtainMsg
  | SetDiagMarkersMsg
  | PointerEventMsg
  | WheelEventMsg
  | DisposeMsg;
