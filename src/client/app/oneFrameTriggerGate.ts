/**
 * App render-loop frame gate (plan: wrap-up-known-issues, Phase 2).
 *
 * The App.tsx rAF loop runs every frame but, under the worker renderer
 * (`supportsOffscreenRenderer()` — the phone default), only hands the
 * mirror to the renderer every SECOND frame to halve structured-clone
 * marshaling cost. One-frame "trigger" sets on the mirror —
 * `explodingShips` (death VFX) — are consumed by the renderer and then
 * cleared so they fire exactly once.
 *
 * THE BUG this module fixes (2026-05-19): the loop cleared
 * `explodingShips` EVERY frame but rendered every 2nd frame, so a kill
 * added on a skipped-render frame was wiped before the renderer ever
 * saw it — ~50% of explosions silently dropped ("the first ship I
 * killed showed no explosion"). The defect is the decoupling of the
 * clear decision from the render decision; the invariant is that
 * one-frame triggers may be cleared ONLY on a frame the renderer
 * actually consumed them. A pure `decideExplosionPosition` test cannot
 * catch this (the sprite is present when the explosion loop runs — the
 * loss is upstream, in this gate) — see the test docstring for why this
 * loop-sequence model, not a renderer probe, is the level the bug lives.
 *
 * Kept pure + injected (no `useWorker` global, no counter closure) so
 * the loop ordering is unit-lockable. App.tsx owns the counter and the
 * side effects; this module owns only the decision.
 */
export interface FrameGate {
  /** The post-increment frame counter to store back. */
  nextCounter: number;
  /** Hand the mirror to the renderer this frame? */
  shouldRender: boolean;
  /**
   * Clear one-frame trigger sets (`explodingShips`) this frame?
   * INVARIANT: must equal {@link shouldRender} — clearing on a frame the
   * renderer never consumed drops the trigger.
   */
  shouldClearOneFrameTriggers: boolean;
}

/**
 * Decide, for one rAF tick, whether to render and whether it is now safe
 * to clear one-frame triggers. Mirrors App.tsx's pre-increment counter
 * semantics: `useWorker` renders on even post-increment counters
 * (every 2nd frame); the main-thread renderer renders every frame.
 */
export function computeFrameGate(useWorker: boolean, frameCounter: number): FrameGate {
  const nextCounter = frameCounter + 1;
  const shouldRender = !useWorker || nextCounter % 2 === 0;
  return {
    nextCounter,
    shouldRender,
    // FIX: clear one-frame triggers ONLY on a frame the renderer
    // consumed them. Under the worker cadence a kill added on a
    // skipped-render frame now survives (accumulates) until the next
    // render frame instead of being wiped (~50% explosion loss).
    shouldClearOneFrameTriggers: shouldRender,
  };
}
