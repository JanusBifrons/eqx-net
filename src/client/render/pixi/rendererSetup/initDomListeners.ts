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
