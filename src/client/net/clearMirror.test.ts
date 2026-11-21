/**
 * Phone play-test 2026-11-21: leaving via the Lost Connection overlay logged
 * `cleanup_step_failed {step: gameClient.dispose, error: "Cannot assign to read
 * only property 'length'"}`. `tickPhysics` parks the frozen `EMPTY_AIM_IDS` on
 * `mirror.localAimMountIds`, and the reflection walk did `v.length = 0` on it,
 * throwing (ESM is strict mode) and skipping the rest of dispose.
 */
import { describe, it, expect } from 'vitest';
import { clearMirror } from './clearMirror.js';

describe('clearMirror', () => {
  it('does not throw on a frozen empty array and still clears its siblings', () => {
    const owned = [1, 2, 3];
    const m: Record<string, unknown> = {
      frozen: Object.freeze([]) as readonly string[],
      owned,
      map: new Map([['a', 1]]),
    };
    expect(() => clearMirror(m)).not.toThrow();
    expect(owned.length).toBe(0);
    expect((m['map'] as Map<string, number>).size).toBe(0);
  });

  it('replaces a frozen non-empty array with an empty one', () => {
    const shared = Object.freeze(['x']);
    const m: Record<string, unknown> = { ids: shared };
    clearMirror(m);
    expect((m['ids'] as unknown[]).length).toBe(0);
    expect(shared.length).toBe(1); // the shared constant is untouched
  });
});
