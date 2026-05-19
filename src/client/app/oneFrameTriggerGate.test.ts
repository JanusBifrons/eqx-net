/**
 * Phase 2 (plan: wrap-up-known-issues) — drone death explosion regression
 * lock.
 *
 * Reported: "the first ship I killed didn't show the explosion effect,
 * it just vanished." Root cause (verified in App.tsx:367-370): under the
 * worker renderer `renderer.update()` runs every 2nd frame but
 * `mirror.explodingShips.clear()` ran EVERY frame, so a kill added on a
 * skipped-render frame was wiped before the renderer saw it (~50% loss).
 *
 * LEVEL-OF-TEST (invariant #13 — "the level the bug LIVES"): the defect
 * is App.tsx main-thread loop sequencing — the clear decision decoupled
 * from the render decision. It is NOT the worker structured-clone
 * boundary (the 2026-05-14 damage-number bug class — a renderer probe
 * there is right; here it would test a layer the bug isn't in and pass
 * while broken). It is NOT `decideExplosionPosition` (the sprite is
 * still present when the explosion loop runs — pure-helper test passes
 * while broken; the rev-1 plan's trap). The faithful level is a
 * deterministic model of the loop's render/clear ordering, which this
 * is: it replays the EXACT App.tsx sequence (render-check THEN
 * clear-check) over the worker cadence and asserts a one-frame trigger
 * added on any frame is delivered to the renderer before it is cleared.
 */
import { describe, it, expect } from 'vitest';
import { computeFrameGate } from './oneFrameTriggerGate';

/**
 * Replays the App.tsx loop body ordering for `frames` ticks, injecting a
 * one-frame trigger at the start of `addOnFrame` (1-based), and reports
 * whether the renderer ever saw it. Mirrors App.tsx exactly:
 *   tickPhysics/updateMirror → if(shouldRender) renderer.update(mirror)
 *   → if(shouldClearOneFrameTriggers) explodingShips.clear()
 */
function rendererSawTrigger(useWorker: boolean, frames: number, addOnFrame: number): boolean {
  let counter = 0;
  const explodingShips = new Set<string>();
  let seen = false;
  for (let frame = 1; frame <= frames; frame++) {
    if (frame === addOnFrame) explodingShips.add('swarm-1'); // killSwarmEntity add
    const gate = computeFrameGate(useWorker, counter);
    counter = gate.nextCounter;
    if (gate.shouldRender && explodingShips.has('swarm-1')) seen = true; // renderer.update
    if (gate.shouldClearOneFrameTriggers) explodingShips.clear(); // App.tsx clear
  }
  return seen;
}

describe('computeFrameGate — one-frame trigger survival (Phase 2)', () => {
  it('INVARIANT: clearing one-frame triggers iff the renderer consumed them', () => {
    for (const useWorker of [true, false]) {
      for (let counter = 0; counter < 8; counter++) {
        const g = computeFrameGate(useWorker, counter);
        expect(g.shouldClearOneFrameTriggers).toBe(g.shouldRender);
      }
    }
  });

  it('worker renderer: a kill on a skipped-render frame still reaches the renderer', () => {
    // Counter is pre-incremented then % 2: under the worker, frame 1
    // (counter 0→1, 1%2≠0) is a SKIPPED-render frame. Pre-fix the
    // unconditional clear wiped the kill here before frame 2 rendered.
    expect(rendererSawTrigger(true, 4, 1)).toBe(true);
  });

  it('worker renderer: a kill on EVERY frame parity reaches the renderer', () => {
    // Both a skipped-render frame (odd) and a render frame (even) must
    // deliver — pre-fix only ~half (the render-frame adds) survived.
    expect(rendererSawTrigger(true, 6, 1)).toBe(true); // skipped-render frame
    expect(rendererSawTrigger(true, 6, 2)).toBe(true); // render frame
    expect(rendererSawTrigger(true, 6, 3)).toBe(true); // skipped-render frame
  });

  it('main-thread renderer: behaviour unchanged (renders + clears every frame)', () => {
    expect(rendererSawTrigger(false, 4, 1)).toBe(true);
    expect(rendererSawTrigger(false, 4, 2)).toBe(true);
  });
});
