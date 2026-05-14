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
} from './protocol';

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

    this.installEventListeners(this.canvas);

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
      this.postPointerEvent(this.serialisePointer(e));
    };
    const onWheel = (e: WheelEvent): void => {
      // Non-passive so we can preventDefault to stop page scroll/zoom.
      e.preventDefault();
      this.postWheelEvent(this.serialiseWheel(e));
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

  private addListener(
    canvas: HTMLCanvasElement,
    event: string,
    handler: EventListener,
    options?: AddEventListenerOptions,
  ): void {
    canvas.addEventListener(event, handler, options);
    this.listeners.push({ event, handler, options });
  }

  private serialisePointer(e: PointerEvent): SerialisedPointerEvent {
    return {
      type: e.type,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      button: e.button,
      buttons: e.buttons,
      clientX: e.clientX,
      clientY: e.clientY,
      offsetX: e.offsetX,
      offsetY: e.offsetY,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      isPrimary: e.isPrimary,
      pressure: e.pressure,
      width: e.width,
      height: e.height,
      twist: e.twist,
      tiltX: e.tiltX,
      tiltY: e.tiltY,
      stamp: Date.now(),
    };
  }

  private serialiseWheel(e: WheelEvent): SerialisedWheelEvent {
    return {
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      deltaZ: e.deltaZ,
      deltaMode: e.deltaMode,
      clientX: e.clientX,
      clientY: e.clientY,
      offsetX: e.offsetX,
      offsetY: e.offsetY,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      stamp: Date.now(),
    };
  }

  update(mirror: RenderMirror): void {
    this.post({ type: 'MIRROR_UPDATE', mirror });
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
    if (mirror.pendingHealthBarHits) mirror.pendingHealthBarHits.length = 0;
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
        this.feedback.mountCounts.clear();
        for (const [k, v] of msg.feedback.mountCounts) {
          this.feedback.mountCounts.set(k, v);
        }
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
