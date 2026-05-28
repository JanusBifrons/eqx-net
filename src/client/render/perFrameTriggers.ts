/**
 * Per-frame one-shot trigger consumption — pure helper.
 *
 * App.tsx's rAF loop posts the mirror to the renderer every frame in
 * main-thread mode, and every OTHER frame in worker-renderer mode
 * (`workerUpdateCounter % 2 === 0`; see commit `a97fdcf` —
 * "perf(render-worker): throttle MIRROR_UPDATE postMessage to 30 Hz").
 *
 * One-frame trigger sets — `mirror.explodingShips` and (future)
 * siblings — are populated by event handlers in `ColyseusClient`
 * (e.g. `killEntity` adds the destroyed entity id at line ~1345 with
 * the comment "renderer consumes then App.tsx clears"). The renderer
 * reads them per frame and spawns transient sprites (explosion FX);
 * the trigger set must then be cleared so the next frame doesn't
 * re-spawn duplicates of the same id.
 *
 * The contract: the clear MUST be gated on the same condition as the
 * renderer-post. A clear without a preceding renderer.update() silently
 * drops the trigger — the visual effect is lost. In worker mode this
 * would surface as roughly half of all explosion sprites failing to
 * render (50 % of frames are skip frames).
 *
 * This pure helper expresses the contract: `consumeOneFrameTriggers`
 * is a no-op when `didRender` is false, so the trigger set survives
 * to the next render frame and the renderer eventually picks them up.
 *
 * Why pure: the rAF loop is hard to unit-test in isolation; extracting
 * this one-line gate makes the contract explicit and lockable. The
 * unit tests in `perFrameTriggers.test.ts` exercise both code paths.
 */

/** Mirror-side fields cleared as one-frame triggers. Currently:
 *   - `explodingShips`         (Phase 4 / 6b destruction trigger set)
 *   - `pendingEffectTriggers`  (effects subsystem one-shot queue, M2 —
 *                               plan `wiggly-puppy`)
 *
 *  Future entries here (kill-feed, screen flash etc.) must follow the
 *  same consume-after-render rule. */
export interface OneFrameTriggerSurface {
  explodingShips?: Set<string>;
  /** Effects subsystem one-shot queue. Structural type (any array-shaped
   *  field); the concrete element shape is `RenderMirror.pendingEffectTriggers`
   *  in `src/core/contracts/IRenderer.ts` but this helper doesn't need to
   *  know it — we only mutate `.length = 0`. */
  pendingEffectTriggers?: { length: number };
}

/**
 * Consume per-frame one-shot triggers AFTER the renderer has had a
 * chance to read them. MUST be called with `didRender=true` only when
 * the renderer's `update(mirror)` actually ran on this frame; pass
 * `didRender=false` on skip frames in worker mode (see commit `a97fdcf`).
 *
 * On a skip frame, the trigger set is left intact so the next render
 * frame consumes the accumulated entries — preventing the silent-loss
 * bug class the contract guards against.
 */
export function consumeOneFrameTriggers(
  mirror: OneFrameTriggerSurface,
  didRender: boolean,
): void {
  if (!didRender) return;
  mirror.explodingShips?.clear();
  // pendingEffectTriggers — visual-effects subsystem one-shot queue. SAME
  // skip-frame gate discipline as explodingShips: clearing on a skip frame
  // silently drops every queued trigger (impact sparks, destruction bursts).
  if (mirror.pendingEffectTriggers) mirror.pendingEffectTriggers.length = 0;
}
