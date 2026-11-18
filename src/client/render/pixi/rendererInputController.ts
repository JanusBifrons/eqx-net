import { RendererCommandRouting } from './rendererCommandRouting.js';
import { decidePlacementPointer } from '../placementPointerDecision.js';
import { setCanvasPointerCapture } from '../pointerCapture.js';

export type { RendererInputDeps } from './rendererCommandRouting.js';

/** A pointer event forwarded from the main thread (worker path). */
export interface ForwardedPointerEvent { type: string; pointerId: number; offsetX: number; offsetY: number; stamp: number; button?: number; buttons?: number; shiftKey?: boolean; pointerType?: string }

/**
 * Pointer / touch / wheel input for PixiRenderer: canvas listeners (main-thread
 * path, bound once in `installCanvasEventListeners`, removed in
 * `removeEventListeners`) and forwarded events (worker path), the camera half
 * of a gesture, and placement pointers. RTS command routing and THE selection
 * live in the base, `RendererCommandRouting`. Constructed once by
 * PixiRenderer; its public input methods are one-line delegates there.
 */
export class RendererInputController extends RendererCommandRouting {

  /**
   * Worker-context entry point for synthesised pointer events forwarded
   * from the main thread. The Camera consumes via its state machine.
   */
  forwardPointerEvent(e: ForwardedPointerEvent): void {
    // Galaxy selector (spawn/warp picker) owns pointer input for free
    // pan/zoom; a tap is resolved to a sector inside the layer. Otherwise
    // the world camera consumes it (gameplay pan/zoom + tap).
    const gl = this._galaxyLayer;
    if (gl !== null && gl.isPanZoomActive()) {
      switch (e.type) {
        case 'pointerdown': gl.onPointerDown(e.pointerId, e.offsetX, e.offsetY, e.stamp); break;
        case 'pointermove': gl.onPointerMove(e.pointerId, e.offsetX, e.offsetY); break;
        case 'pointerup': gl.onPointerUp(e.pointerId, e.offsetX, e.offsetY, e.stamp); break;
        case 'pointercancel':
        case 'pointerleave': gl.onPointerCancel(e.pointerId); break;
      }
      return;
    }
    // Structure placement positions the ghost instead of panning (worker path).
    if (this._placementActive) {
      this.routePlacementPointer(e.type, e.offsetX, e.offsetY, e.button ?? -1, e.pointerType ?? 'mouse');
      return;
    }
    // RTS command view (slice 13a): the router decides camera / box / select /
    // order. Its `camera` actions run the camera below with taps ignored.
    if (this.commandRoutingActive()) {
      this.routeCommandPointer(e.type, e.pointerId, e.offsetX, e.offsetY, e.stamp,
        e.button ?? 0, e.buttons ?? 0, e.shiftKey === true, e.pointerType ?? 'mouse');
      return;
    }
    const wasTap = this.cameraPointer(e.type, e.pointerId, e.offsetX, e.offsetY, e.stamp);
    if (wasTap) {
      // Confirmed tap (single pointer, short duration, small distance):
      // route to the registered tap-handler. The worker uses this to
      // hit-test the GalaxyMapLayer (since Pixi's event subsystem
      // isn't initialised without a DOM event source).
      if (this.onTap) this.onTap(e.offsetX, e.offsetY);
      // Click-to-inspect (Item B2): a gameplay tap selects an entity, gated
      // off galaxy + placement so it never cross-fires with warp/picker/build.
      if (!this.galaxyTapSuppressed() && !this._placementActive) {
        this.handleGameplayTap(e.offsetX, e.offsetY);
      }
    }
  }

  /**
   * The camera half of pointer handling (both render paths). Returns the
   * camera's `wasTap` on pointerup; callers decide whether a tap means anything
   * (command view ignores it: the router owns taps there).
   */
  protected cameraPointer(type: string, pointerId: number, x: number, y: number, stamp: number): boolean {
    switch (type) {
      case 'pointerdown':
        this.camera.onPointerDown(pointerId, x, y, stamp);
        return false;
      case 'pointermove':
        this.camera.onPointerMove(pointerId, x, y);
        // WS-10 (R2.4) — desktop hover outline. Renderer-local; gated like
        // selection so it never fires over the galaxy layer / during placement.
        if (!this.galaxyTapSuppressed() && !this._placementActive) {
          this.handleGameplayHover(x, y);
        }
        return false;
      case 'pointerup':
        return this.camera.onPointerUp(pointerId, x, y, stamp).wasTap;
      case 'pointercancel':
      case 'pointerleave':
        this.camera.onPointerCancel(pointerId);
        return false;
    }
    return false;
  }

  /**
   * Register a confirmed-tap handler. Fired by `forwardPointerEvent`
   * when Camera resolves a tap (short, low-distance pointer cycle).
   * Coords passed in are the canvas-local pixel position of the tap
   * (DPR-scaled per `WorkerRendererClient.serialisePointer`).
   *
   * Worker-only — DOM-mode Pixi uses its native event system instead.
   */
  private onTap: ((screenX: number, screenY: number) => void) | null = null;
  setOnTap(handler: ((screenX: number, screenY: number) => void) | null): void {
    this.onTap = handler;
  }

  /** Worker-context wheel forwarding. */
  forwardWheelEvent(deltaY: number, offsetX: number, offsetY: number): void {
    const gl = this._galaxyLayer;
    if (gl !== null && gl.isPanZoomActive()) {
      gl.onWheel(deltaY, offsetX, offsetY);
      return;
    }
    this.camera.onWheel(deltaY, offsetX, offsetY);
  }

  /**
   * Install pointer/wheel/touch listeners on the canvas and forward
   * them into the Camera. Replaces pixi-viewport's automatic
   * `events: app.renderer.events` subscription. Touch hijacking is
   * suppressed via `{ passive: false }` + `preventDefault`.
   */
  private readonly canvasListeners: Array<{ type: string; handler: EventListener; options?: AddEventListenerOptions }> = [];
  /** P3.5 — the window-level placement-drag pointermove handler (so the ghost
   *  follows the pointer off-canvas / over overlays). Removed in dispose(). */
  private _placementWindowMoveHandler: EventListener | null = null;
  installCanvasEventListeners(canvas: HTMLCanvasElement): void {
    const onPointer = (e: PointerEvent): void => {
      // eslint-disable-next-line no-restricted-properties -- real time: input event stamp
      const stamp = Date.now();
      // Galaxy selector owns pointer input (free pan/zoom; tap → sector).
      const gl = this._galaxyLayer;
      if (gl !== null && gl.isPanZoomActive()) {
        switch (e.type) {
          case 'pointerdown': gl.onPointerDown(e.pointerId, e.offsetX, e.offsetY, stamp); break;
          case 'pointermove': gl.onPointerMove(e.pointerId, e.offsetX, e.offsetY); break;
          case 'pointerup': gl.onPointerUp(e.pointerId, e.offsetX, e.offsetY, stamp); break;
          case 'pointercancel':
          case 'pointerleave': gl.onPointerCancel(e.pointerId); break;
        }
        return;
      }
      // Structure placement: position the blueprint ghost instead of panning.
      // The Camera's `screenToWorld` gives pixi-world coords (y = -gameY).
      if (this._placementActive) {
        // Capture the pointer for the duration of the placement drag (playtest
        // 2026-06-10 Issue 9 — "desktop build-drag breaks"). A fast drag that
        // leaves the canvas (or another element grabbing the pointer) stops
        // delivering pointermove, stalling the ghost. Capture keeps every
        // move/up routed here until release.
        setCanvasPointerCapture(canvas, e.type, e.pointerId);
        this.routePlacementPointer(e.type, e.offsetX, e.offsetY, e.button, e.pointerType);
        return;
      }
      // RTS command view (slice 13a): router owns the gesture. Capture the
      // pointer so a drag box keeps updating when it leaves the canvas.
      if (this.commandRoutingActive()) {
        setCanvasPointerCapture(canvas, e.type, e.pointerId);
        this.routeCommandPointer(e.type, e.pointerId, e.offsetX, e.offsetY, stamp,
          e.button, e.buttons, e.shiftKey, e.pointerType);
        return;
      }
      const wasTap = this.cameraPointer(e.type, e.pointerId, e.offsetX, e.offsetY, stamp);
      // Click-to-inspect (Item B2): a confirmed gameplay tap (not a drag)
      // selects an entity. Gated off the galaxy layer + placement so it
      // never cross-fires. The galaxy `isPanZoomActive` branch above
      // already returned for the selector; `galaxyTapSuppressed()` also
      // covers the in-game overlay (warp taps).
      if (wasTap && !this.galaxyTapSuppressed() && !this._placementActive) {
        this.handleGameplayTap(e.offsetX, e.offsetY);
      }
    };
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const gl = this._galaxyLayer;
      if (gl !== null && gl.isPanZoomActive()) {
        gl.onWheel(e.deltaY, e.offsetX, e.offsetY);
        return;
      }
      this.camera.onWheel(e.deltaY, e.offsetX, e.offsetY);
    };
    const onTouchMove = (e: TouchEvent): void => {
      e.preventDefault();
    };
    const add = (type: string, handler: EventListener, options?: AddEventListenerOptions): void => {
      canvas.addEventListener(type, handler, options);
      this.canvasListeners.push({ type, handler, options });
    };
    add('pointerdown', onPointer as EventListener);
    add('pointermove', onPointer as EventListener);
    add('pointerup', onPointer as EventListener);
    add('pointercancel', onPointer as EventListener);
    add('pointerleave', onPointer as EventListener);
    add('wheel', onWheel as EventListener, { passive: false });
    add('touchmove', onTouchMove as EventListener, { passive: false });

    // P3.5 — desktop placement drag: while placing, the ghost must keep
    // following the pointer even when it leaves the canvas or crosses an HUD
    // overlay (canvas `pointermove` isn't delivered there — the user's repeated
    // "desktop drag breaks"). ALSO listen on the WINDOW and route window moves
    // (converted to canvas-local) to the ghost while placement is active.
    // GATE on `e.target !== canvas`: moves OVER the canvas are already routed by
    // the canvas listener above using the native, canvas-relative `e.offsetX`.
    // Re-routing those here with `clientX - rect.left` would DOUBLE-handle them,
    // and the window value would clobber the canvas one — on the worker path the
    // two computations diverge, so the chosen point snapped to a wrong world
    // coord (feature E regression). Only handle the off-canvas / over-overlay
    // case the canvas listener can't see.
    //
    // CAPTURE PHASE (P3.5 follow-still-broken, 2026-06-13): registered with
    // `{ capture: true }` so it fires on the way DOWN, BEFORE any element under
    // the pointer (the MUI speed-dial / its tooltips) can `stopPropagation` a
    // bubble-phase listener away. `window` is the outermost capture target, so
    // nothing can intercept it — this is the true "connect to the ENTIRE window
    // mouse move" the placement follow needs. Removed (with matching capture
    // flag) in dispose().
    const onWindowPlacementMove = (e: PointerEvent): void => {
      if (!this._placementActive || e.target === canvas) return;
      const rect = canvas.getBoundingClientRect();
      this.routePlacementPointer('pointermove', e.clientX - rect.left, e.clientY - rect.top, e.button, e.pointerType);
    };
    window.addEventListener('pointermove', onWindowPlacementMove, true);
    this._placementWindowMoveHandler = onWindowPlacementMove as EventListener;
  }

  /**
   * Position the placement blueprint ghost from a canvas pointer event. Shared
   * by the main-thread path (`installCanvasEventListeners`) and the worker path
   * (`forwardPointerEvent`). `screenX/Y` are canvas-relative. `screenToWorld`
   * returns pixi-world coords, so `gameY = -that.y`.
   *
   * Follow model: `_placementFollowing` starts true when placement begins, so
   * the ghost tracks the pointer (desktop HOVER move / mobile DRAG). Releasing
   * (pointer-up) parks the ghost (`following = false`).
   *
   * WS-10 (R2.5) — DESKTOP one-click placement: a MOUSE left-click (pointerup,
   * `button === 0`, `pointerType === 'mouse'`) COMMITS the blueprint at the
   * cursor by bumping `feedback.placementConfirmSeq` (gameRafLoop edge-detects it
   * and places at the chosen point, then clears `placementKind`). TOUCH never
   * commits here — a touch pointer-up just parks the ghost so the Confirm banner
   * appears (the tap-to-position flow), so the two-step touch UX is unchanged.
   */
  private routePlacementPointer(
    type: string,
    screenX: number,
    screenY: number,
    button: number,
    pointerType: string,
  ): void {
    const w = this.camera.screenToWorld(screenX, screenY);
    const gameX = w.x;
    const gameY = -w.y;
    // Pure state machine (placementPointerDecision.ts) — the load-bearing rule
    // is that `pointerleave` does NOT park the follow (P3.5 follow-still-broken):
    // desktop hover-follow has no pointer capture, so leaving the canvas (over
    // the speed-dial / off-screen) must not break the lock. Unit-locked.
    const outcome = decidePlacementPointer(type, pointerType, button, this._placementFollowing);
    if (outcome.following !== null) this._placementFollowing = outcome.following;
    if (outcome.updateChosen) {
      this._placementChosenX = gameX;
      this._placementChosenY = gameY;
    }
    if (outcome.commit) this.feedback.placementConfirmSeq++;
  }

  /** Remove every listener `installCanvasEventListeners` added (dispose). */
  removeEventListeners(canvas: HTMLCanvasElement | undefined): void {
    if (canvas) {
      for (const { type, handler, options } of this.canvasListeners) {
        canvas.removeEventListener(type, handler, options);
      }
    }
    this.canvasListeners.length = 0;
    // P3.5 — the window-level placement-drag pointermove (lives on `window`,
    // capture phase — the removal flag MUST match the add or it won't detach).
    if (this._placementWindowMoveHandler) {
      window.removeEventListener('pointermove', this._placementWindowMoveHandler, true);
      this._placementWindowMoveHandler = null;
    }
  }
}
