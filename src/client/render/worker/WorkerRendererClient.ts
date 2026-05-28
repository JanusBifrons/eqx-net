/**
 * Main-thread proxy that implements `IRenderer` against the
 * `renderer.worker.ts` Web Worker. From the App's perspective this is
 * a drop-in replacement for `PixiRenderer`; underneath, every contract
 * method posts to the worker and `getFeedback()` reads a locally-cached
 * struct that the worker refreshes via FEEDBACK each frame.
 *
 * At end of Phase 3 this class is dead code — `App.tsx` still wires
 * `PixiRenderer`. Phase 4 swaps in `WorkerRendererClient`, with a
 * capability check (`OffscreenCanvas` + `transferControlToOffscreen`)
 * to fall back to `PixiRenderer` on browsers that lack OffscreenCanvas
 * (Safari < 17, etc.).
 *
 * Construction cost: ~50–200 ms for worker spawn + Pixi `app.init`
 * (measured in the Phase 1 spike). One-time at GameSurface mount.
 *
 * See `~/.claude/plans/humble-strolling-coral.md` Phase 3 / 4.
 */

import type {
  IRenderer,
  RenderMirror,
  RendererFeedback,
} from '@core/contracts/IRenderer';
import type {
  MainToWorkerMsg,
  WorkerToMainMsg,
  SerialisedPointerEvent,
  SerialisedWheelEvent,
  WarpParams,
  WarpCenter,
  TriggerEffectMsg,
  SetEffectParamsMsg,
} from './protocol';
import type { EffectQuality } from '@core/contracts/IEffects';
import { logEvent, isDiagEnabled, isAutoCaptureEnabled } from '../../debug/ClientLogger';
import { serialisePointerEvent, serialiseWheelEvent } from './eventSerialisation.js';

/** Callback invoked when the worker emits OVERLAY_TAPPED. */
export type OverlayTapHandler = (sectorKey: string) => void;

/**
 * Stable feedback object. The worker overwrites its fields each
 * FEEDBACK message — reference identity is preserved so callers can
 * cache the result of `getFeedback()` without worrying about stale
 * pointers.
 */
function emptyFeedback(): RendererFeedback {
  return {
    mountCounts: new Map<string, number>(),
    haloArrowCount: 0,
    damageNumberActiveCount: 0,
    wreckSpriteCount: 0,
    firstFrameRendered: false,
  };
}

export class WorkerRendererClient implements IRenderer {
  private worker: Worker | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private readonly feedback: RendererFeedback = emptyFeedback();
  private onOverlayTap: OverlayTapHandler | null = null;
  private initResolve: (() => void) | null = null;

  // Event listener handles, kept so `dispose()` removes them cleanly.
  // The canvas survives transferControlToOffscreen — only the rendering
  // context moves to the worker, so DOM event listeners on the canvas
  // still fire on the main thread (this is the whole point of the
  // forwarding pattern).
  private readonly listeners: Array<{ event: string; handler: EventListener; options?: AddEventListenerOptions }> = [];
  // Window/visualViewport-level listeners for viewport rotation +
  // browser-chrome resize. Tracked separately because they live on
  // `window`/`visualViewport`, not the canvas.
  private windowListeners: Array<{ target: Window | VisualViewport | null; event: string; handler: EventListener }> = [];
  private resizeObserver: ResizeObserver | null = null;
  private canvasHost: HTMLElement | null = null;

  /** Subscribe to OVERLAY_TAPPED messages. Called by `App.tsx`. */
  setOverlayTapHandler(handler: OverlayTapHandler | null): void {
    this.onOverlayTap = handler;
  }

  async init(rawContainer: unknown): Promise<void> {
    const container = rawContainer as HTMLElement;
    this.canvas = document.createElement('canvas');
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.touchAction = 'none';
    container.appendChild(this.canvas);

    const dpr = window.devicePixelRatio ?? 1;
    this.canvas.width = Math.floor(container.clientWidth * dpr);
    this.canvas.height = Math.floor(container.clientHeight * dpr);

    const offscreen = this.canvas.transferControlToOffscreen();

    this.worker = new Worker(new URL('./renderer.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (e: MessageEvent<WorkerToMainMsg>): void => {
      this.handleWorkerMessage(e.data);
    };
    this.worker.onerror = (e: ErrorEvent): void => {
      // eslint-disable-next-line no-console
      console.error('[render-worker] error:', e.message);
    };

    // Promise resolved when READY arrives.
    const ready = new Promise<void>((resolve) => {
      this.initResolve = resolve;
    });

    this.post({
      type: 'BOOT',
      canvas: offscreen,
      width: this.canvas.width,
      height: this.canvas.height,
      dpr,
    }, [offscreen]);

    // F1 — tell the worker once whether to emit per-frame markers.
    // Ordered after BOOT (messages are processed FIFO) and before the
    // first MIRROR_UPDATE, so the gate is set before any frame.
    // Render-jitter-fix Phase 1b (2026-05-21): also enabled under
    // `?autocapture=1` so streamed phone captures carry per-frame
    // renderer / warp / grid cost markers — without them we can't see
    // whether render cost grows monotonically (the user's accumulating-
    // filter hypothesis). Production player sessions (neither flag set)
    // still pay zero IPC cost.
    this.post({ type: 'SET_DIAG_MARKERS', enabled: isDiagEnabled() || isAutoCaptureEnabled() });

    this.installEventListeners(this.canvas);
    // Resize listeners — without these, OffscreenCanvas's drawing
    // buffer never updates on rotation / URL-bar hide-show / DPR
    // change. The DOM-mode PixiRenderer has the same listeners
    // (see PixiRenderer.init); the worker path needed them too.
    // User-reported 2026-05-14: rotating the phone left the canvas
    // stretched and thin because the buffer stayed at the original
    // dims while CSS scaled the element. Lock test:
    // tests/e2e/join-warp-screen.spec.ts "viewport rotation resizes
    // the gameplay canvas".
    this.canvasHost = container;
    this.installResizeListeners(container);

    await ready;
  }

  // ---------- Event forwarding ----------
  //
  // The canvas's DOM element (with rendering context transferred) still
  // receives native pointer/wheel/touch events on the main thread. We
  // serialise + forward them to the worker, where `Camera` consumes the
  // synthesised events via its state machine. This is the workaround
  // for pixijs/pixijs#9132 (Pixi events don't work natively in
  // OffscreenCanvas runtime) — confirmed by the Phase 1 spike.

  private installEventListeners(canvas: HTMLCanvasElement): void {
    const onPointer = (e: PointerEvent): void => {
      this.postPointerEvent(serialisePointerEvent(e));
    };
    const onWheel = (e: WheelEvent): void => {
      // Non-passive so we can preventDefault to stop page scroll/zoom.
      e.preventDefault();
      this.postWheelEvent(serialiseWheelEvent(e));
    };
    const onTouchMove = (e: TouchEvent): void => {
      // Stops iOS page-pinch hijacking when the gesture starts on the
      // canvas. Touch coords aren't forwarded directly — pixi-viewport's
      // pinch (and ours) is reconstructed from `pointer*` events with
      // pointerType === 'touch'.
      e.preventDefault();
    };

    this.addListener(canvas, 'pointerdown', onPointer as EventListener);
    this.addListener(canvas, 'pointermove', onPointer as EventListener);
    this.addListener(canvas, 'pointerup', onPointer as EventListener);
    this.addListener(canvas, 'pointercancel', onPointer as EventListener);
    this.addListener(canvas, 'pointerleave', onPointer as EventListener);
    this.addListener(canvas, 'wheel', onWheel as EventListener, { passive: false });
    this.addListener(canvas, 'touchmove', onTouchMove as EventListener, { passive: false });
  }

  /** Window-level + container-level resize listeners. Mirrors the
   *  DOM-mode `PixiRenderer.init` resize wiring. Each event reads the
   *  canvas host's `clientWidth`/`clientHeight` and posts a RESIZE
   *  message to the worker so the OffscreenCanvas drawing buffer
   *  stays sized to the visible viewport. */
  private installResizeListeners(host: HTMLElement): void {
    const handler = (): void => this.dispatchResize();
    // `window.resize` covers most viewport changes (including rotation
    // on Android Chrome). `orientationchange` catches iOS Safari edge
    // cases where window.resize fires before the geometry actually
    // settles. `visualViewport.resize` catches URL-bar show/hide on
    // mobile that doesn't trigger window.resize.
    window.addEventListener('resize', handler);
    window.addEventListener('orientationchange', handler);
    this.windowListeners.push({ target: window, event: 'resize', handler });
    this.windowListeners.push({ target: window, event: 'orientationchange', handler });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handler);
      this.windowListeners.push({ target: window.visualViewport, event: 'resize', handler });
    }
    // ResizeObserver on the host catches CSS-driven layout changes
    // (drawer opening, slot anchor reflow, dvh recalc on mobile) that
    // don't fire window resize.
    this.resizeObserver = new ResizeObserver(handler);
    this.resizeObserver.observe(host);
    // One-shot rAF resize so post-mount layout settling is captured.
    requestAnimationFrame(handler);
  }

  /** Read current host dimensions and forward to the worker.
   *  Idempotent — skip the postMessage when dims haven't actually
   *  changed, since `ResizeObserver` fires on EVERY layout pass
   *  (including stable ones during the first paint cycle). */
  private lastResizeW = 0;
  private lastResizeH = 0;
  private dispatchResize(): void {
    if (!this.canvasHost || !this.worker) return;
    const w = this.canvasHost.clientWidth || window.innerWidth;
    const h = this.canvasHost.clientHeight || window.innerHeight;
    if (w <= 0 || h <= 0) return;
    if (w === this.lastResizeW && h === this.lastResizeH) return;
    this.lastResizeW = w;
    this.lastResizeH = h;
    const dpr = window.devicePixelRatio ?? 1;
    logEvent('worker_resize', { w, h, dpr });
    this.resize(w, h, dpr);
  }

  private addListener(
    canvas: HTMLCanvasElement,
    event: string,
    handler: EventListener,
    options?: AddEventListenerOptions,
  ): void {
    canvas.addEventListener(event, handler, options);
    this.listeners.push({ event, handler, options });
  }

  // Pointer/wheel serialisation lives in `./eventSerialisation.ts` —
  // pure DPR-aware functions, no `this`-state.

  update(mirror: RenderMirror): void {
    // F1 (warp-spool perf — `docs/HANDOFF-warp-spool-perf-followup.md`).
    // `this.post` → `worker.postMessage` runs the structured-clone of
    // the (KB-scale, entity-count-dependent) RenderMirror SYNCHRONOUSLY
    // on the main thread — a candidate for the in-game-vs-sandbox
    // differential. Bracket it + a size proxy. GATED behind
    // `isDiagEnabled()`: `JSON.stringify(mirror)` every frame is NOT
    // free, so it must be off in production. When off, this is a single
    // `this.post(...)` call exactly as before — zero added cost.
    if (isDiagEnabled()) {
      const cloneStart = performance.now();
      this.post({ type: 'MIRROR_UPDATE', mirror });
      const costMs = performance.now() - cloneStart;
      logEvent('mirror_clone', { costMs, approxBytes: JSON.stringify(mirror).length });
    } else {
      this.post({ type: 'MIRROR_UPDATE', mirror });
    }
    // Per-frame drain queues: `pendingDamageNumbers` and
    // `pendingHealthBarHits` are mutated in place by the consumer
    // (`PixiRenderer.update`) in the main-thread path. In the worker
    // path, `PixiRenderer` drains a STRUCTURED-CLONE on the worker
    // side, leaving the main-thread mirror's arrays untouched — if we
    // didn't clear them here, ColyseusClient's events would be
    // re-posted every frame and the worker would re-spawn duplicates
    // until garbage collection. Drain locally to match the
    // main-thread contract. Regression-locked by
    // `tests/e2e/damage-number-lifetime.spec.ts`.
    if (mirror.pendingDamageNumbers) mirror.pendingDamageNumbers.length = 0;
    // weapon-hit-prediction Phase 2 — same worker-path drain contract as
    // pendingDamageNumbers: the worker cancels on its STRUCTURED-CLONE, so
    // the main-thread queue must be cleared here or cancels re-post every
    // frame. (The 2026-05-14 damage-number boundary lesson.)
    if (mirror.pendingDamageNumberCancels) mirror.pendingDamageNumberCancels.length = 0;
    if (mirror.pendingHealthBarHits) mirror.pendingHealthBarHits.length = 0;
    if (mirror.pendingWarpEvents) mirror.pendingWarpEvents.length = 0;
  }

  /**
   * Read the most recent feedback. Backed by a main-thread cache
   * populated by FEEDBACK messages from the worker. Reference identity
   * stable across calls; field values mutate each frame.
   */
  getFeedback(): RendererFeedback {
    return this.feedback;
  }

  /**
   * Attach a screen-space overlay (Pixi `Container`) to the renderer's
   * stage. CANNOT cross the worker boundary as a Pixi handle — instead,
   * the main thread sends `SET_VISIBLE` / `SET_CURRENT_SECTOR` /
   * `SET_TRANSIT_DOCKED` / `RESIZE` messages and the worker constructs
   * the layer locally on BOOT. The `overlay` argument is unused in this
   * implementation; kept for the `IRenderer` contract.
   *
   * Phase 4 wires the real layer-state messages from `App.tsx`'s
   * existing `useEffect` hooks. For Phase 3 this is a no-op.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  addOverlayContainer(_overlay: unknown): void {
    // No-op in Phase 3. Phase 4 wires SET_VISIBLE / etc.
  }

  /**
   * Pixi ticker FPS cap. See `PixiRenderer.setTickerMaxFPS` for the
   * three-mode semantics. Phase 3 only forwards; Phase 4 hooks the
   * worker side.
   */
  setTickerMaxFPS(fps: number | null | undefined): void {
    this.post({ type: 'SET_TICKER_FPS', fps });
  }

  /**
   * Warp-mode render state. See `IRenderer.setWarpMode`. Posts to the
   * worker which forwards to its `PixiRenderer.setWarpMode`.
   */
  setWarpMode(active: boolean): void {
    this.post({ type: 'SET_WARP_MODE', active });
  }

  /**
   * Live-tune warp visual params. Sandbox-only — production code never
   * calls this; defaults live in `PixiRenderer.DEFAULT_WARP_PARAMS`.
   * Posts to the worker which forwards to `PixiRenderer.setWarpParams`.
   */
  setWarpParams(params: Partial<WarpParams>): void {
    this.post({ type: 'SET_WARP_PARAMS', params });
  }

  /**
   * Anchor the warp centre. World-space anchors track a world point
   * as the camera pans; screen-space anchors are used raw (sandbox
   * click-to-place). `null` reverts to screen centre. In production,
   * each per-ship warp event sets its own world anchor before
   * `setWarpMode(true)`.
   */
  setWarpCenter(center: WarpCenter | null): void {
    this.post({ type: 'SET_WARP_CENTER', center });
  }

  /**
   * Sandbox-only: position the camera so a world point sits at screen
   * centre. Production code follows the local ship via the renderer's
   * built-in `Camera.follow`, not this message.
   */
  setCameraCenter(worldX: number, worldY: number): void {
    this.post({ type: 'SET_CAMERA_CENTER', worldX, worldY });
  }

  /**
   * Fire the warp-in (arrival) companion effect at the supplied
   * centre. Flash + single big ripple, no preceding spool/climax.
   */
  triggerWarpIn(center: WarpCenter | null): void {
    this.post({ type: 'TRIGGER_WARP_IN', center });
  }

  /**
   * Show or hide the load curtain — an opaque overlay that hides the
   * canvas during the join + transit load periods. Production
   * orchestration in `App.tsx` drives this; the renderer animates the
   * alpha-tween internally.
   */
  setLoadCurtain(active: boolean): void {
    this.post({ type: 'SET_LOAD_CURTAIN', active });
  }

  /**
   * Effects subsystem (plan `wiggly-puppy` M2): trigger a one-shot effect.
   * Production code rarely calls this directly — most triggers ride
   * `RenderMirror.pendingEffectTriggers` (drained renderer-side per
   * frame). Sandbox + `IFilterEffects.triggerOneShotFilter` use it.
   */
  triggerEffect(effect: TriggerEffectMsg['effect'], worldX: number, worldY: number,
                opts?: { intensity?: number; tint?: number; entityId?: string }): void {
    this.post({
      type: 'TRIGGER_EFFECT',
      effect,
      worldX,
      worldY,
      ...(opts?.intensity !== undefined ? { intensity: opts.intensity } : {}),
      ...(opts?.tint !== undefined ? { tint: opts.tint } : {}),
      ...(opts?.entityId !== undefined ? { entityId: opts.entityId } : {}),
    });
  }

  /**
   * Push an `EffectsBudget` quality tier. Called by the main-thread
   * `PerfMonitor` only on tier transition (≤ once per 500 ms — see
   * `EffectsBudget` hysteresis). NEVER per-frame.
   */
  setEffectQuality(level: EffectQuality): void {
    this.post({ type: 'SET_EFFECT_QUALITY', level });
  }

  /**
   * Sandbox-only live tune for a single effect's params. Mirrors
   * `setWarpParams`. Production never calls this; per-effect defaults
   * live in `src/client/effects/config/effectDefaults.ts`.
   */
  setEffectParams(effect: SetEffectParamsMsg['effect'], params: Record<string, number | boolean>): void {
    this.post({ type: 'SET_EFFECT_PARAMS', effect, params });
  }

  /** Effects subsystem (plan `wiggly-puppy` M9): wipe per-entity emitters
   *  + in-flight bursts on sector handoff. The worker forwards to
   *  `pixiRenderer.resetEffectsForSectorHandoff()`. */
  resetEffectsForSectorHandoff(): void {
    this.post({ type: 'RESET_EFFECTS_HANDOFF' });
  }

  /** Forward a native pointer event into the worker camera state machine. */
  postPointerEvent(native: SerialisedPointerEvent): void {
    this.post({ type: 'POINTER_EVENT', native });
  }

  /** Forward a native wheel event into the worker camera state machine. */
  postWheelEvent(native: SerialisedWheelEvent): void {
    this.post({ type: 'WHEEL_EVENT', native });
  }

  /** Push GalaxyMapLayer state updates. Called by `App.tsx` useEffects. */
  setLayerVisible(visible: boolean): void {
    this.post({ type: 'SET_VISIBLE', visible });
  }
  setLayerCurrentSector(sectorKey: string | null): void {
    this.post({ type: 'SET_CURRENT_SECTOR', sectorKey });
  }
  setLayerTransitDocked(docked: boolean): void {
    this.post({ type: 'SET_TRANSIT_DOCKED', docked });
  }

  /** Notify the worker of a canvas-host resize. */
  resize(width: number, height: number, dpr: number): void {
    this.post({ type: 'RESIZE', width, height, dpr });
  }

  dispose(): void {
    // Remove event listeners FIRST so any in-flight pointer event
    // doesn't fire postMessage after the worker is terminated.
    if (this.canvas) {
      for (const { event, handler, options } of this.listeners) {
        this.canvas.removeEventListener(event, handler, options);
      }
      this.listeners.length = 0;
    }
    for (const { target, event, handler } of this.windowListeners) {
      target?.removeEventListener(event, handler);
    }
    this.windowListeners.length = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.canvasHost = null;
    if (this.worker) {
      this.post({ type: 'DISPOSE' });
      // Give the worker a tick to `self.close()` cleanly; if it
      // doesn't, terminate forcibly.
      const w = this.worker;
      this.worker = null;
      setTimeout(() => {
        w.terminate();
      }, 100);
    }
    if (this.canvas) {
      this.canvas.remove();
      this.canvas = null;
    }
  }

  // ---------- Internal ----------

  private post(msg: MainToWorkerMsg, transfer?: Transferable[]): void {
    if (!this.worker) return;
    if (transfer && transfer.length > 0) {
      this.worker.postMessage(msg, transfer);
    } else {
      this.worker.postMessage(msg);
    }
  }

  private handleWorkerMessage(msg: WorkerToMainMsg): void {
    switch (msg.type) {
      case 'READY': {
        this.initResolve?.();
        this.initResolve = null;
        break;
      }
      case 'FEEDBACK': {
        // Mutate in place to preserve reference identity.
        this.feedback.haloArrowCount = msg.feedback.haloArrowCount;
        this.feedback.damageNumberActiveCount = msg.feedback.damageNumberActiveCount;
        this.feedback.wreckSpriteCount = msg.feedback.wreckSpriteCount;
        this.feedback.firstFrameRendered = msg.feedback.firstFrameRendered;
        this.feedback.mountCounts.clear();
        for (const [k, v] of msg.feedback.mountCounts) {
          this.feedback.mountCounts.set(k, v);
        }
        break;
      }
      case 'FRAME_MARKERS': {
        // F1 — re-emit the worker's per-frame sub-costs onto the
        // main-thread log ring (the worker has no `window.__eqxLogs`).
        // Three tags so the analyzer + capture buckets keep them
        // distinct. Only arrives while diagnostics are enabled (the
        // worker gates the post), so no production-path cost here.
        const m = msg.markers;
        logEvent('renderer_update', { totalMs: m.rendererUpdateMs, spriteCount: m.spriteCount });
        logEvent('warp_tick', {
          totalMs: m.warpTickMs,
          filterCount: m.filterCount,
          // Render-jitter-fix Phase 1b — the load-bearing diagnostic
          // for the stuck-filter-chain hypothesis. `attached=true`
          // for many frames in a row + `burstAgeMs` climbing past
          // ~1500ms means filters are stuck on (the bug-fix-target).
          attached: m.warpFiltersAttached,
          burstAgeMs: m.warpBurstAgeMs,
        });
        logEvent('grid_update', {
          labelSpecMs: m.gridLabelSpecMs,
          textCreateMs: m.gridTextCreateMs,
          cleanupMs: m.gridCleanupMs,
          labelCount: m.gridLabelCount,
        });
        break;
      }
      case 'OVERLAY_TAPPED': {
        this.onOverlayTap?.(msg.sectorKey);
        break;
      }
      case 'ERROR': {
        // eslint-disable-next-line no-console
        console.error('[render-worker] worker error:', msg.message);
        break;
      }
    }
  }
}

/**
 * Capability check — `OffscreenCanvas` + `transferControlToOffscreen`.
 * Safari < 17 lacks support; `App.tsx` should fall back to
 * `PixiRenderer` on `false`.
 */
export function supportsOffscreenRenderer(): boolean {
  return (
    typeof OffscreenCanvas !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function'
  );
}
