/**
 * Heap-delta regression lock for the WarpScreen RAF self-terminate fix
 * (plan: melodic-engelbart Step 4).
 *
 * The bug: WarpScreen's progress-tick RAF loop allocated a template
 * literal `WARP STABILISATION ${pct}%` every frame at 60 Hz AND never
 * stopped — even after `pct` reached 100, even after the component
 * returned null on phase change. During steady-state gameplay the
 * component stays mounted (only the JSX returns null; the useEffect's
 * cleanup never runs), so the loop ran forever, allocating + writing
 * the same string every frame. Hostile CDP profile (2026-05-30) ranked
 * it #2 at 28 KB / 3.8 %.
 *
 * The fix: skip the allocation when `pct` is unchanged AND
 * `cancelAnimationFrame` once `pct` reaches 100.
 *
 * This test mocks `requestAnimationFrame` so we can count exactly how
 * many tick iterations the loop runs and how many textContent writes
 * happen. A reverter that brings back the per-frame template-literal
 * allocation will fail this lock.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { LayoutContext } from '../layout/useLayout.js';
import { WarpScreen } from './WarpScreen.js';
import { useUIStore } from '../state/store.js';

let host: HTMLDivElement;
let rafCallbacks: Array<{ id: number; cb: FrameRequestCallback }>;
let rafCounter: number;
let nowMs: number;
let originalRaf: typeof globalThis.requestAnimationFrame;
let originalCancel: typeof globalThis.cancelAnimationFrame;
let originalNow: typeof performance.now;

function flushRafs(): void {
  // Drain the currently-queued callbacks. Any callbacks scheduled by
  // these will queue for the NEXT flush.
  const pending = rafCallbacks;
  rafCallbacks = [];
  for (const { cb } of pending) cb(nowMs);
}

function advanceTime(deltaMs: number, framesAtSixtyHz?: number): void {
  // Step the synthetic clock + drive the requested number of RAF flushes.
  const frames = framesAtSixtyHz ?? Math.round(deltaMs / (1000 / 60));
  const perFrame = deltaMs / Math.max(1, frames);
  for (let i = 0; i < frames; i++) {
    nowMs += perFrame;
    flushRafs();
  }
}

describe('WarpScreen — RAF loop terminates at 100%', () => {
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    rafCallbacks = [];
    rafCounter = 0;
    nowMs = 1_000;
    originalRaf = globalThis.requestAnimationFrame;
    originalCancel = globalThis.cancelAnimationFrame;
    originalNow = performance.now;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      const id = ++rafCounter;
      rafCallbacks.push({ id, cb });
      return id;
    };
    globalThis.cancelAnimationFrame = (id: number): void => {
      rafCallbacks = rafCallbacks.filter((e) => e.id !== id);
    };
    performance.now = (): number => nowMs;
    // Steady "post-arrival" baseline — phase='game', all readiness gates
    // satisfied. WarpScreen will still mount its RAF loop in useEffect.
    useUIStore.setState({
      phase: 'game',
      connectionStatus: 'connected',
      localShipInstanceId: 'ship-1',
      firstSnapshotApplied: true,
      rendererFirstFrameRendered: true,
      joinMinimumElapsed: true,
    });
  });

  afterEach(() => {
    host.remove();
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
    performance.now = originalNow;
  });

  it('cancels the RAF once pct reaches 100 — no per-frame allocs in steady state', () => {
    const tree = (
      <LayoutContext.Provider value={{ fullscreen: host }}>
        <WarpScreen />
      </LayoutContext.Provider>
    );
    act(() => {
      render(tree);
    });

    // Initial mount queues the first RAF.
    expect(rafCallbacks.length).toBe(1);

    // Advance through the full 5 s warp window at 60 Hz (300 frames).
    act(() => advanceTime(5_000, 300));

    // After the warp window, the loop must self-terminate — no RAF in
    // the queue. Pre-fix this stayed at 1 (every tick re-queued).
    expect(rafCallbacks.length, 'RAF must be cancelled at pct=100').toBe(0);

    // Advance another full second — nothing should fire.
    act(() => advanceTime(1_000, 60));
    expect(rafCallbacks.length).toBe(0);

    // The element's textContent must have reached the terminal value.
    const timer = host.querySelector('[data-testid="warp-screen-timer"]');
    expect(timer?.textContent).toBe('WARP STABILISATION 100%');
  });

  it('only writes textContent when pct changes (no redundant string allocs)', () => {
    // Spy on the eventual DOM mutation by tracking textContent writes.
    // We wrap the timer span's setter so each assignment increments a
    // counter — fewer writes ⇒ fewer template-literal allocations.
    const tree = (
      <LayoutContext.Provider value={{ fullscreen: host }}>
        <WarpScreen />
      </LayoutContext.Provider>
    );
    act(() => {
      render(tree);
    });
    const timer = host.querySelector('[data-testid="warp-screen-timer"]') as HTMLElement;
    expect(timer).not.toBeNull();
    let writes = 0;
    const proto = Object.getPrototypeOf(timer);
    const originalDesc = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
    if (originalDesc?.set) {
      const wrappedSetter = originalDesc.set;
      Object.defineProperty(proto, 'textContent', {
        configurable: true,
        get: originalDesc.get,
        set(value: string) {
          writes++;
          wrappedSetter.call(this, value);
        },
      });
    }

    try {
      // Cover the full warp window at 60 Hz (300 frames). The fix caps
      // pct at integer percentages 0..100, so we expect ≤ 101 distinct
      // values (0, 1, ..., 100) — therefore ≤ 101 writes total. Pre-fix
      // it would be 300 (one per frame).
      act(() => advanceTime(5_000, 300));
      expect(writes, 'textContent writes capped to per-pct-change cardinality').toBeLessThanOrEqual(101);
      // Sanity — at least a few writes must have happened (the loop ran).
      expect(writes).toBeGreaterThan(10);

      // After warp completes, no more writes EVER (loop stopped).
      const writesAtComplete = writes;
      act(() => advanceTime(2_000, 120));
      expect(writes, 'no writes post-completion').toBe(writesAtComplete);
    } finally {
      if (originalDesc) Object.defineProperty(proto, 'textContent', originalDesc);
    }
  });
});
