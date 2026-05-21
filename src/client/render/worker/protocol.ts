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

import type { RenderMirror, RendererFeedback, WarpCenter } from '@core/contracts/IRenderer';

// Re-export so existing client-side imports from this module keep working.
export type { WarpCenter };

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
 * Tunable parameters for the warp visual effect. Plain data so the
 * `SET_WARP_PARAMS` message stays structured-cloneable. The renderer
 * keeps a copy of the full struct; partials passed in `SET_WARP_PARAMS`
 * are merged on top so sliders only need to send the field they
 * changed.
 *
 * The warp visual layers two filters at a shared centre:
 *   - `ShockwaveFilter` × `count` (concentric expanding rings)
 *   - `ZoomBlurFilter` (radial motion blur from the same point)
 *
 * The envelope has two phases driven by a single `setWarpMode(true)`
 * call:
 *   1. **Spool** — `spoolDurationMs`. Many small short-lived ripples
 *      (count = `spoolCount`, finite `spoolRadius`, fast cycle).
 *      Amplitude / brightness / blur ramp from 0 to a small peak.
 *   2. **Climax** — `climaxDurationMs`. One big ripple
 *      (count = 1, infinite radius, slow cycle). Amplitude /
 *      brightness / blur continue to grow to their peaks.
 *
 * After `setWarpMode(false)` a `fadeOutMs` tween brings everything to
 * 0 — blur peaks at fade-start and dissipates with the rest.
 *
 * Today only the visual-effects sandbox spike posts these — production
 * code uses the defaults baked in below.
 */
export interface WarpParams {
  /** ShockwaveFilter `speed` uniform (pixels/sec). 100–2000. */
  speed: number;
  /** ShockwaveFilter `wavelength` uniform. 40–600. */
  wavelength: number;
  /** ZoomBlurFilter `innerRadius` — radius (px) inside which blur is at full strength. 0–400. */
  zoomBlurInnerRadius: number;
  /** Ms to fade everything to 0 after `setWarpMode(false)`. 100–2000. */
  fadeOutMs: number;

  // ---- Spool phase: many small short-lived pulses ----
  /** Spool phase duration (ms). 0–8000. */
  spoolDurationMs: number;
  /** Stacked ShockwaveFilter count during spool. 1–8. */
  spoolCount: number;
  /** ShockwaveFilter time-cycle period during spool (ms). 200–2000. */
  spoolWavePeriodMs: number;
  /** Spool ripples die beyond this radius (px). 50–800. */
  spoolRadius: number;
  /** Peak amplitude at end of spool. 0–80. */
  spoolAmplitude: number;
  /** Peak brightness at end of spool. 1.0–2.0. */
  spoolBrightness: number;
  /** Peak zoom blur strength at end of spool. 0–1. */
  spoolZoomBlur: number;

  // ---- Climax phase: single big pulse ----
  /** Climax phase duration (ms). 0–4000. */
  climaxDurationMs: number;
  /** ShockwaveFilter time-cycle period during climax (ms). 1000–10000. */
  climaxWavePeriodMs: number;
  /** Peak amplitude at climax (the "big pulse"). 10–250. */
  climaxAmplitude: number;
  /** Peak brightness at climax. 1.0–2.5. */
  climaxBrightness: number;
  /** Peak zoom blur strength at climax. 0–1. */
  climaxZoomBlur: number;

  // ---- Burst + flash: the "exit moment" / warp-in arrival pulse ----
  /** Total lifetime (ms) of the burst ShockwaveFilter pulse. 100–1500. */
  burstDurationMs: number;
  /** Peak amplitude of the burst ripple (starts here, decays to 0). 50–400. */
  burstAmplitude: number;
  /** Burst ShockwaveFilter `speed` (px/sec). 400–3000. */
  burstSpeed: number;
  /** Burst ShockwaveFilter `wavelength`. 80–500. */
  burstWavelength: number;
  /** Burst ShockwaveFilter peak `brightness`. 1.0–2.5. */
  burstBrightness: number;
  /** Peak alpha of the white flash overlay. 0–1. */
  flashAlphaMax: number;
  /** Total lifetime (ms) of the flash alpha tween. 100–800. */
  flashDurationMs: number;
  /** World-space distance beyond which the flash is invisible. The
   *  flash alpha scales linearly from `flashAlphaMax` at distance 0 to
   *  0 at this range. Reads camera world centre (i.e. local-ship
   *  position in production) as the viewer. 0–8000. */
  flashRangeMax: number;

  // ---- Bloom: amplifies the bright wavefront during climax + burst ----
  /** Peak BloomFilter `strength` at climax + burst. Bloom amplifies
   *  bright pixels (the wavefront has its own `brightness` uniform) so
   *  the wave reads as a glowing line that distant viewers can spot
   *  even before the displacement reaches their screen. 0–8. 0 = off. */
  bloomStrengthMax: number;
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
 * Default warp params — the production warp visual runs with these
 * baked into `PixiRenderer`'s `warpParams` field. The visual-effects
 * sandbox spike also seeds its sliders from this object so the
 * iteration starts at the production baseline.
 *
 * Design intent: spool reads as "build-up flutter" (many small ripples
 * that die early, very subtle blur), climax reads as "the big moment"
 * (one strong ripple, brightness + blur peak). Total ramp ≈ 5 s.
 */
export const DEFAULT_WARP_PARAMS: WarpParams = {
  // Shared
  speed: 600,
  wavelength: 240,
  zoomBlurInnerRadius: 80,
  fadeOutMs: 700,

  // Spool: 4 small short-lived ripples for ~3.75 s
  spoolDurationMs: 3750,
  spoolCount: 4,
  spoolWavePeriodMs: 700,
  spoolRadius: 320,
  spoolAmplitude: 18,
  spoolBrightness: 1.05,
  spoolZoomBlur: 0.04,

  // Climax: 1 big pulse for ~1.25 s — the "amazing" moment, cranked to
  // near-max so the wave is legible. Dial back via sliders.
  climaxDurationMs: 1100,
  climaxWavePeriodMs: 5000,
  climaxAmplitude: 220,
  climaxBrightness: 2.0,
  climaxZoomBlur: 0.7,

  // Burst + flash: the despawn / arrival pulse. Defaults sized for
  // "drive-by visibility" — a viewer can be far from the burst centre
  // and still catch the wavefront before it fades.
  //   - amplitude 440 + wavelength 520: dramatic, fat displacement
  //   - speed 2800 × duration 1500 ms: wave reaches ~4200 px from
  //     centre, well past most screens at zoom 1
  //   - amplitude curve sqrt(1 - t) in the renderer: slow tail-off so
  //     the wavefront stays visible at the perimeter
  burstDurationMs: 1500,
  burstAmplitude: 440,
  burstSpeed: 2800,
  burstWavelength: 520,
  burstBrightness: 2.6,
  flashAlphaMax: 0.85,
  flashDurationMs: 380,
  flashRangeMax: 2500,
  bloomStrengthMax: 6,
};

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
