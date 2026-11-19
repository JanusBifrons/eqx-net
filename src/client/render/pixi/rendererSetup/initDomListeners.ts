/**
 * `PixiRenderer.init` setup step (DOM / main-thread path only): canvas
 * input listeners and the window / visualViewport / ResizeObserver resize
 * wiring. Body moved verbatim from `init`; renderer state that can change
 * after init (the app, `initialized`, the starfield) is read through getters.
 */
import type { Application } from 'pixi.js';
import type { RendererInputController } from '../rendererInputController.js';
import type { RendererCameraDirector } from '../cameraDirector.js';
import type { StarfieldBackground } from '../../StarfieldBackground.js';
import type { RendererFrameRefs } from '../frameCtx.js';
import { logEvent, isDiagEnabled } from '../../../debug/ClientLogger.js';

export interface DomListenerDeps {
  app: () => Application | undefined;
  domContainer: HTMLElement;
  input: RendererInputController;
  cameraDirector: RendererCameraDirector;
  isInitialized: () => boolean;
  resolutionFor: (dpr: number, w: number, h: number) => number;
  starfield: () => StarfieldBackground | null;
}

export function installDomListeners(deps: DomListenerDeps): void {
  const domContainer = deps.domContainer;
  const app = deps.app()!;
  // Install canvas pointer/wheel listeners → camera state machine.
  // Camera replaces pixi-viewport's automatic event subscription.
  // Worker context: events arrive via postMessage and the worker
  // scaffolding (renderer.worker.ts) calls forwardPointerEvent /
  // forwardWheelEvent directly — no DOM listener path.
  deps.input.installCanvasEventListeners(app.canvas);

  const measureSize = (): { w: number; h: number } => {
    const vv = window.visualViewport;
    const w = domContainer.clientWidth || vv?.width || window.innerWidth;
    const h = domContainer.clientHeight || vv?.height || window.innerHeight;
    return { w, h };
  };

  const resize = (): void => {
    // Late-fire guard: a queued `requestAnimationFrame(resize)` and the
    // ResizeObserver can both fire AFTER dispose() has destroyed the Pixi
    // application, leaving `app.renderer` null. Bailing on
    // !initialized is enough — dispose() flips that flag.
    const live = deps.app();
    if (!deps.isInitialized() || !live?.renderer) return;
    const { w, h } = measureSize();
    // Re-apply DPR so browser-zoom / monitor-move updates resolution
    // on the main-thread path too (parity with the worker resize).
    const dpr = window.devicePixelRatio ?? 1;
    live.renderer.resize(w, h, deps.resolutionFor(dpr, w, h));
    deps.cameraDirector.setViewSize(w, h);
    deps.starfield()?.resize(w, h);
  };
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
  window.visualViewport?.addEventListener('resize', resize);

  // Container-driven resize: catches layout settling on mobile (URL bar,
  // safe-area insets, dvh recalculation) that don't always fire window resize.
  const ro = new ResizeObserver(resize);
  ro.observe(domContainer);

  (app as unknown as Record<string, unknown>)['_resizeHandler'] = resize;
  (app as unknown as Record<string, unknown>)['_resizeObserver'] = ro;

  // Force one resize after the next frame to capture post-mount layout.
  requestAnimationFrame(resize);
}

/** The teardown of `installDomListeners` (from `dispose`): canvas pointer /
 *  wheel / touch listeners, then the resize handler and observer. */
export function removeDomListeners(app: Application | undefined, input: RendererInputController): void {
  // Remove canvas pointer / wheel / touch listeners so an in-flight
  // event doesn't reach a destroyed Camera.
  input.removeEventListeners(app?.canvas);
  const handler = (app as unknown as Record<string, unknown>)['_resizeHandler'];
  if (typeof handler === 'function') {
    window.removeEventListener('resize', handler as EventListener);
    window.removeEventListener('orientationchange', handler as EventListener);
    window.visualViewport?.removeEventListener('resize', handler as EventListener);
  }
  const ro = (app as unknown as Record<string, unknown>)['_resizeObserver'];
  if (ro instanceof ResizeObserver) ro.disconnect();
}

/** `installDomListeners` over the renderer's frame refs (the `init` call site). */
export function installRendererDomListeners(
  r: Pick<RendererFrameRefs, 'app' | 'input' | 'cameraDirector' | 'starfield'>, domContainer: HTMLElement,
  isInitialized: () => boolean, resolutionFor: (dpr: number, w: number, h: number) => number,
): void {
  installDomListeners({
    app: () => r.app, domContainer, input: r.input, cameraDirector: r.cameraDirector,
    isInitialized, resolutionFor, starfield: () => r.starfield,
  });
}

/**
 * Worker-context resize (`PixiRenderer.resize`; moved from `PixiRenderer`,
 * god-file split slice 12). The renderer worker calls it when it
 * receives a RESIZE message — replicates the DOM resize() handler for
 * the OffscreenCanvas path.
 */
export function resizeRenderer(
  r: Pick<RendererFrameRefs, 'app' | 'cameraDirector' | 'starfield' | 'world'>, initialized: boolean,
  resolutionFor: (dpr: number, w: number, h: number) => number, width: number, height: number, dpr?: number,
): void {
  if (!initialized || !r.app?.renderer) return;
  // Pass resolution through so a DPR change (monitor move / browser
  // zoom / some rotations) re-derives the backing buffer. Omitting it
  // (the old behaviour) kept the stale init resolution → blur after
  // such a change. `width`/`height` are LOGICAL (CSS) px.
  r.app.renderer.resize(width, height, dpr !== undefined ? resolutionFor(dpr, width, height) : r.app.renderer.resolution);
  r.cameraDirector.setViewSize(width, height);
  r.starfield?.resize(width, height);
  if (isDiagEnabled()) {
    logEvent('render_frame_diag', {
      phase: 'resize',
      mode: 'worker',
      appResolution: r.app.renderer.resolution,
      canvasW: r.app.canvas.width,
      canvasH: r.app.canvas.height,
      inW: width,
      inH: height,
      dpr: dpr ?? -1,
      worldScaleX: r.world.scale.x,
    });
  }
}
