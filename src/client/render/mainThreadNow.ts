import type { RenderMirror } from '@core/contracts/IRenderer';

/**
 * The main thread's time for this frame (`mirror.frameTimeMs`, the RAF time),
 * falling back to the renderer's own clock when the mirror carries none.
 *
 * Use it wherever the renderer compares "now" against a stamp the main thread
 * wrote (pose-ring arrivals, laser `expiresAt`). On desktop the renderer is a
 * worker whose `performance.now()` counts from the worker's own `timeOrigin`,
 * set when the worker started (later than the page's), so its clock sits that
 * far behind every main-thread stamp. Pure animation clocks (pulses, fades
 * stamped by the renderer itself) keep the renderer's clock.
 */
export function mainThreadNowMs(mirror: Pick<RenderMirror, 'frameTimeMs'>, rendererNowMs: number): number {
  const t = mirror.frameTimeMs;
  return t !== undefined && Number.isFinite(t) ? t : rendererNowMs;
}
