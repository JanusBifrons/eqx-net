/**
 * Plan: combat-fx-hunt (2026-05-31) — regression lock for the
 * HealthBarManager dirty-flag optimisation.
 *
 * Pre-fix: `update()` called `gfx.clear() + rect() + fill()` every
 * frame on every active bar. With 25 hostile drones it ran ~9k Pixi
 * geometry ops/sec (25 × 6 × 60 Hz), each allocating Pixi v8 internal
 * ShapePath / _Circle / GpuGraphicsContext / _Bounds. Snapshot-diff
 * named this as the rank-1 contributor to the user's 2 MB/sec heap
 * climb during combat (2026-05-31 capture `5sef0w` lag-spike report).
 *
 * Post-fix: geometry is rebuilt ONLY when health / shield / hasShield
 * has changed since the last paint. Position + alpha updates run every
 * frame via the Graphics container's transform (cheap, no rebuild).
 *
 * This spec drives a fake Graphics with spy methods through a fast-
 * forward update loop and asserts:
 *  - First update() after onHit() rebuilds geometry (clear called).
 *  - Subsequent updates without onHit() do NOT call clear() again.
 *  - A fresh onHit() that changes health/shield DOES re-rebuild.
 *  - Position update (gfx.x / gfx.y) runs every frame regardless.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { HealthBarManager } from './HealthBars.js';

// Mock Pixi.js — we don't need a real GPU renderer for this test.
// All we care about is the call sequence on the Graphics instance.
vi.mock('pixi.js', () => {
  class FakeContainer {
    x = 0;
    y = 0;
    alpha = 1;
    children: unknown[] = [];
    addChild(c: unknown): void { this.children.push(c); }
    removeChild(c: unknown): void {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
    }
    destroy(_opts?: unknown): void { /* noop */ }
  }
  class FakeGraphics extends FakeContainer {
    clear = vi.fn();
    rect = vi.fn().mockReturnThis();
    fill = vi.fn().mockReturnThis();
    destroy = vi.fn();
  }
  return { Container: FakeContainer, Graphics: FakeGraphics };
});

interface MutableMirror {
  ships: Map<string, { x: number; y: number }>;
}

function makeMirror(): RenderMirror {
  const m: MutableMirror = { ships: new Map() };
  return m as unknown as RenderMirror;
}

describe('HealthBarManager — dirty-flag optimisation', () => {
  let parent: { addChild: ReturnType<typeof vi.fn>; removeChild: ReturnType<typeof vi.fn> };
  let mgr: HealthBarManager;
  let mirror: RenderMirror;

  beforeEach(() => {
    parent = { addChild: vi.fn(), removeChild: vi.fn() };
    mgr = new HealthBarManager(parent as never);
    mirror = makeMirror();
    (mirror as unknown as MutableMirror).ships.set('ship-A', { x: 100, y: 200 });
  });

  it('first update() after onHit() rebuilds geometry exactly once', () => {
    mgr.onHit('ship-A', 0.8, 0.5);
    mgr.update(mirror);
    const gfx = (mgr as unknown as { bars: Map<string, { gfx: { clear: { mock: { calls: unknown[] } }; rect: { mock: { calls: unknown[] } }; fill: { mock: { calls: unknown[] } } } }> }).bars.get('ship-A')!.gfx;
    expect(gfx.clear.mock.calls.length).toBe(1);
    // Shield + hull = 2 bg + 2 fg = 4 rect+fill pairs.
    expect(gfx.rect.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(gfx.fill.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('subsequent update() with unchanged state does NOT rebuild', () => {
    mgr.onHit('ship-A', 0.8, 0.5);
    mgr.update(mirror); // first paint
    const gfx = (mgr as unknown as { bars: Map<string, { gfx: { clear: { mock: { calls: unknown[] } }; rect: { mock: { calls: unknown[] } } } }> }).bars.get('ship-A')!.gfx;
    const clearCallsAfterFirstPaint = gfx.clear.mock.calls.length;
    const rectCallsAfterFirstPaint = gfx.rect.mock.calls.length;

    // Move the entity (position updates should still happen, no rebuild).
    (mirror as unknown as MutableMirror).ships.set('ship-A', { x: 150, y: 250 });
    mgr.update(mirror);
    mgr.update(mirror);
    mgr.update(mirror);
    mgr.update(mirror);
    mgr.update(mirror);

    // Zero additional clear / rect / fill calls — the cache held.
    expect(gfx.clear.mock.calls.length).toBe(clearCallsAfterFirstPaint);
    expect(gfx.rect.mock.calls.length).toBe(rectCallsAfterFirstPaint);
  });

  it('position transform updates EVERY frame regardless of state cache', () => {
    mgr.onHit('ship-A', 0.8, 0.5);
    mgr.update(mirror);
    const gfx = (mgr as unknown as { bars: Map<string, { gfx: { x: number; y: number } }> }).bars.get('ship-A')!.gfx;
    const xAfterFirst = gfx.x;
    const yAfterFirst = gfx.y;

    (mirror as unknown as MutableMirror).ships.set('ship-A', { x: 999, y: -50 });
    mgr.update(mirror); // no onHit, should still reposition
    expect(gfx.x).not.toBe(xAfterFirst);
    expect(gfx.y).not.toBe(yAfterFirst);
    // Bar offset is 20px upward, Y flipped.
    expect(gfx.x).toBe(999);
    expect(gfx.y).toBe(50 - 20); // -(-50) - 20 = 30
  });

  it('a fresh onHit() with different health REBUILDS geometry', () => {
    mgr.onHit('ship-A', 0.8, 0.5);
    mgr.update(mirror);
    const gfx = (mgr as unknown as { bars: Map<string, { gfx: { clear: { mock: { calls: unknown[] } } } }> }).bars.get('ship-A')!.gfx;
    const clearCallsBeforeNewHit = gfx.clear.mock.calls.length;

    // Hit again with lower health.
    mgr.onHit('ship-A', 0.4, 0.0);
    mgr.update(mirror);

    expect(gfx.clear.mock.calls.length).toBe(clearCallsBeforeNewHit + 1);
  });

  it('a fresh onHit() with same health does NOT rebuild', () => {
    mgr.onHit('ship-A', 0.8, 0.5);
    mgr.update(mirror);
    const gfx = (mgr as unknown as { bars: Map<string, { gfx: { clear: { mock: { calls: unknown[] } } } }> }).bars.get('ship-A')!.gfx;
    const clearCallsBeforeRepeatHit = gfx.clear.mock.calls.length;

    // Same health, same shield — common case: shield-down drone taking
    // beam fire, every tick reports the same hull/shield %.
    mgr.onHit('ship-A', 0.8, 0.5);
    mgr.update(mirror);
    mgr.onHit('ship-A', 0.8, 0.5);
    mgr.update(mirror);

    expect(gfx.clear.mock.calls.length).toBe(clearCallsBeforeRepeatHit);
  });

  it('60 frames of held-fire on a stable target = 1 rebuild (not 60)', () => {
    // The high-leverage workload: held-fire combat. With the dirty-flag
    // optimisation, the per-frame clear+rect+fill churn collapses to a
    // single rebuild at the start. Pre-fix this would have been 60.
    mgr.onHit('ship-A', 1.0, 1.0);
    for (let i = 0; i < 60; i++) {
      mgr.update(mirror);
    }
    const gfx = (mgr as unknown as { bars: Map<string, { gfx: { clear: { mock: { calls: unknown[] } } } }> }).bars.get('ship-A')!.gfx;
    expect(gfx.clear.mock.calls.length).toBe(1);
  });
});
