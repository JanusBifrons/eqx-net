/**
 * Phase 3a-6 — worker render / clear-gate explosion count lock
 * (plan: e2e-rebuild, master plan i-want-you-to-lively-tulip.md)
 *
 * Per-surface deterministic lock for the worker-renderer cadence-mismatch
 * bug class introduced by commit `a97fdcf` (2026-05-14 — Phase 4.9 of the
 * OffscreenCanvas migration). The renderer-update postMessage was
 * throttled to 30 Hz (every other rAF frame) but the per-frame
 * `mirror.explodingShips?.clear()` continued to run every rAF frame —
 * on skip frames the clear runs WITHOUT the renderer having read the
 * set, silently dropping the trigger.
 *
 * The visible symptom: in worker mode (default on Chromium with
 * OffscreenCanvas support, i.e. virtually every modern player),
 * approximately 50 % of explosion sprites silently fail to render.
 * Server still emits `destroy`, client still removes the entity from
 * the mirror — but the explosion FX never plays.
 *
 * Why no existing E2E catches this:
 *   - `tests/e2e/drone-destruction.spec.ts` asserts swarm-size drops
 *     after holding fire; the kill count is observable regardless of
 *     whether explosion sprites rendered.
 *   - The RendererFeedback closed-set deliberately does NOT expose
 *     explosion-count (per `src/client/CLAUDE.md` — adding a field
 *     "requires a phase-gate review").
 *   - The damage-number-probe probe-page pattern tests
 *     pendingDamageNumbers/pendingHealthBarHits drain; the
 *     explodingShips clear-gate is a sibling but distinct seam.
 *
 * The contract — locked here — is straight from the App.tsx rAF loop
 * comment ("renderer consumes then App.tsx clears", `ColyseusClient.ts`
 * line ~1345):
 *
 *   clear is gated on the same condition as renderer.update.
 *
 * Pure helper at `perFrameTriggers.ts`; App.tsx calls it with
 * `didRender = shouldRender` after the optional `renderer.update(...)`.
 */
import { describe, it, expect } from 'vitest';
import { consumeOneFrameTriggers } from './perFrameTriggers.js';

describe('consumeOneFrameTriggers: clear-gate matches renderer-update gate', () => {
  it('clears explodingShips after a render frame', () => {
    const mirror = { explodingShips: new Set<string>(['drone-1', 'drone-2']) };

    consumeOneFrameTriggers(mirror, /* didRender */ true);

    expect(mirror.explodingShips.size, 'render frame must drain the trigger set').toBe(0);
  });

  it('preserves explodingShips on a skip frame (no render, no clear)', () => {
    // The bug class: prior to the fix, App.tsx cleared on every frame
    // including worker-mode skip frames. An explosion id added between
    // a render frame and the next render frame would be wiped by the
    // intermediate skip-frame clear — even though the renderer never
    // got to read it.
    const mirror = { explodingShips: new Set<string>(['drone-1']) };

    consumeOneFrameTriggers(mirror, /* didRender */ false);

    expect(
      mirror.explodingShips.size,
      [
        'Skip frame must NOT clear explodingShips — the renderer did not',
        'read this frame, so clearing now silently drops the trigger.',
        '',
        'Regression path: App.tsx rAF loop calls clear OUTSIDE the',
        '`if (shouldRender)` block. The pure helper here is the single',
        'source of truth; App.tsx must call it with',
        '`consumeOneFrameTriggers(mirror, shouldRender)`.',
      ].join('\n'),
    ).toBe(1);
    expect(mirror.explodingShips.has('drone-1')).toBe(true);
  });

  it('accumulates triggers across multiple skip frames until the next render', () => {
    // Worker mode runs render-frame, skip-frame alternately. Between
    // two render frames there is exactly ONE skip frame, but the
    // contract must hold for arbitrary skip-frame runs (e.g. a long
    // GC pause that compresses multiple rAF callbacks into the same
    // tick). Add entries across two skip frames, then a render frame
    // consumes all of them.
    const mirror = { explodingShips: new Set<string>() };

    // Skip 1: id arrives, gets stashed.
    mirror.explodingShips.add('drone-a');
    consumeOneFrameTriggers(mirror, false);
    expect(mirror.explodingShips.size).toBe(1);

    // Skip 2: another id arrives, both stashed.
    mirror.explodingShips.add('drone-b');
    consumeOneFrameTriggers(mirror, false);
    expect(mirror.explodingShips.size).toBe(2);
    expect(mirror.explodingShips.has('drone-a')).toBe(true);
    expect(mirror.explodingShips.has('drone-b')).toBe(true);

    // Render frame: both consumed (caller's `renderer.update(mirror)`
    // ran just before this), then cleared.
    consumeOneFrameTriggers(mirror, true);
    expect(mirror.explodingShips.size, 'render frame must drain accumulated triggers').toBe(0);
  });

  it('is a no-op when explodingShips is undefined', () => {
    // The trigger surface is optional on the mirror type (mirrors
    // started without `explodingShips` exist in some test harnesses).
    // The helper must not throw — match the `?.clear()` semantic of
    // the original inline code.
    const mirror = {};
    expect(() => consumeOneFrameTriggers(mirror, true)).not.toThrow();
    expect(() => consumeOneFrameTriggers(mirror, false)).not.toThrow();
  });

  it('is a no-op on a skip frame even when the set is empty', () => {
    // Defensive: empty set + skip frame should still be a no-op, not
    // a silent re-allocation that could change Set identity (the
    // mirror reference is persistent across frames; a re-allocation
    // here would break that contract for downstream consumers).
    const mirror = { explodingShips: new Set<string>() };
    const setRef = mirror.explodingShips;

    consumeOneFrameTriggers(mirror, false);

    expect(mirror.explodingShips).toBe(setRef);
    expect(mirror.explodingShips.size).toBe(0);
  });
});

describe('consumeOneFrameTriggers: pendingEffectTriggers (M2 — wiggly-puppy)', () => {
  // Same skip-frame gate discipline as explodingShips, applied to the
  // effects-subsystem one-shot queue. A drain without a preceding
  // renderer.update would silently lose every impact spark / destruction
  // burst in the queue.
  it('clears pendingEffectTriggers after a render frame', () => {
    const mirror = {
      pendingEffectTriggers: [
        { kind: 'impact' as const, worldX: 0, worldY: 0 },
        { kind: 'destruction' as const, worldX: 1, worldY: 2 },
      ],
    };
    const arrRef = mirror.pendingEffectTriggers;
    consumeOneFrameTriggers(mirror, /* didRender */ true);
    expect(mirror.pendingEffectTriggers.length).toBe(0);
    expect(mirror.pendingEffectTriggers).toBe(arrRef); // identity preserved (length = 0, not new array)
  });

  it('preserves pendingEffectTriggers on a skip frame', () => {
    const mirror = {
      pendingEffectTriggers: [{ kind: 'impact' as const, worldX: 0, worldY: 0 }],
    };
    consumeOneFrameTriggers(mirror, /* didRender */ false);
    expect(mirror.pendingEffectTriggers.length).toBe(1);
  });

  it('accumulates pendingEffectTriggers across skip frames + drains on next render', () => {
    const mirror = {
      pendingEffectTriggers: [] as Array<{ kind: 'impact'; worldX: number; worldY: number }>,
    };
    mirror.pendingEffectTriggers.push({ kind: 'impact', worldX: 0, worldY: 0 });
    consumeOneFrameTriggers(mirror, false);
    mirror.pendingEffectTriggers.push({ kind: 'impact', worldX: 5, worldY: 5 });
    consumeOneFrameTriggers(mirror, false);
    expect(mirror.pendingEffectTriggers.length).toBe(2);

    consumeOneFrameTriggers(mirror, true);
    expect(mirror.pendingEffectTriggers.length).toBe(0);
  });

  it('handles both surfaces together (the production case)', () => {
    const mirror = {
      explodingShips: new Set<string>(['drone-1']),
      pendingEffectTriggers: [{ kind: 'destruction' as const, worldX: 0, worldY: 0 }],
    };
    consumeOneFrameTriggers(mirror, true);
    expect(mirror.explodingShips.size).toBe(0);
    expect(mirror.pendingEffectTriggers.length).toBe(0);
  });

  it('is a no-op when pendingEffectTriggers is undefined', () => {
    const mirror = {};
    expect(() => consumeOneFrameTriggers(mirror, true)).not.toThrow();
  });
});
