/**
 * Pointer-capture helper for the gameplay canvas during a structure placement
 * drag (playtest 2026-06-10 Issue 9 — "desktop build-drag breaks").
 *
 * A fast drag that leaves the canvas bounds — or another element grabbing the
 * pointer mid-drag — stops delivering `pointermove`, so the placement ghost
 * stalls at the last in-bounds point. `setPointerCapture` on pointerdown routes
 * every subsequent move/up for that pointer to the canvas until release,
 * regardless of where the cursor goes; `releasePointerCapture` on pointerup /
 * pointercancel ends it.
 *
 * Shared by the main-thread renderer (`PixiRenderer.installCanvasEventListeners`)
 * and the worker renderer's main-thread listeners
 * (`WorkerRendererClient.installEventListeners`) — both attach DOM listeners on
 * the same canvas element. Guarded: `set/releasePointerCapture` throw for stale
 * or invalid pointer ids on some browsers, and capture is a drag-robustness
 * optimisation, not a correctness requirement.
 */
export function setCanvasPointerCapture(
  canvas: { setPointerCapture(id: number): void; releasePointerCapture(id: number): void; hasPointerCapture(id: number): boolean },
  eventType: string,
  pointerId: number,
): void {
  try {
    if (eventType === 'pointerdown') {
      canvas.setPointerCapture(pointerId);
    } else if (eventType === 'pointerup' || eventType === 'pointercancel') {
      if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    }
  } catch {
    // Non-fatal — capture is best-effort drag robustness, never correctness.
  }
}
