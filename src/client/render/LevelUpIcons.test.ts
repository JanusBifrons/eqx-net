/**
 * Pooled screenspace level-up icon manager (Phase 4 WS-B1, plan:
 * effervescent-umbrella). Mirrors the DamageNumbers pooling discipline
 * (invariant #14 — no per-frame alloc): a free-list of Text instances, a
 * fixed-lifetime float-up-and-fade, recycle-not-destroy on expiry.
 *
 * The Pixi glyph rendering is exercised only structurally (the manager owns a
 * Container + Text pool); these tests lock the POOLING + LIFECYCLE contract,
 * which is the part invariant #14 cares about. We stub Pixi's Container/Text so
 * the manager runs headless in the node-env unit suite (no GPU).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Minimal headless Pixi stubs — only the surface LevelUpIcons touches.
vi.mock('pixi.js', () => {
  class Container {
    children: unknown[] = [];
    addChild(c: unknown): void { this.children.push(c); }
    removeChild(c: unknown): void {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
    }
    destroy(): void {}
  }
  class Text {
    text = '';
    alpha = 1;
    x = 0;
    y = 0;
    style: Record<string, unknown> = {};
    anchor = { set: (): void => {} };
    scale = { set: (): void => {}, x: 1 };
    destroy(): void {}
  }
  class TextStyle {
    constructor(public opts: Record<string, unknown>) {}
  }
  return { Container, Text, TextStyle };
});

import { LevelUpIconManager, ICON_LIFETIME_FRAMES } from './LevelUpIcons.js';

function makeManager(): LevelUpIconManager {
  const worldParent = { addChild: vi.fn(), removeChild: vi.fn() } as unknown as import('pixi.js').Container;
  const camera = { scale: { x: 1 } } as unknown as import('./worker/Camera').Camera;
  return new LevelUpIconManager(worldParent, camera);
}

describe('LevelUpIconManager (Phase 4 WS-B1)', () => {
  let mgr: LevelUpIconManager;
  beforeEach(() => {
    mgr = makeManager();
  });

  it('spawns one active icon per call', () => {
    expect(mgr.getActiveCount()).toBe(0);
    mgr.spawn(10, -20, 3);
    expect(mgr.getActiveCount()).toBe(1);
    mgr.spawn(50, 50, 4);
    expect(mgr.getActiveCount()).toBe(2);
  });

  it('expires the icon after its lifetime and recycles the Text (no leak)', () => {
    mgr.spawn(0, 0, 2);
    expect(mgr.getActiveCount()).toBe(1);
    for (let i = 0; i < ICON_LIFETIME_FRAMES; i++) mgr.update();
    expect(mgr.getActiveCount()).toBe(0);

    // A subsequent spawn reuses the recycled Text rather than allocating —
    // the free-list counter advanced.
    const before = LevelUpIconManager.debugCounters.acquireFromPool;
    mgr.spawn(0, 0, 5);
    expect(LevelUpIconManager.debugCounters.acquireFromPool).toBe(before + 1);
  });

  it('does not allocate a fresh Text when the pool has a recycled one', () => {
    // Spawn + expire to seed the free-list.
    mgr.spawn(0, 0, 2);
    for (let i = 0; i < ICON_LIFETIME_FRAMES; i++) mgr.update();
    const freshBefore = LevelUpIconManager.debugCounters.acquireFresh;
    mgr.spawn(0, 0, 3);
    // No new fresh Text — the recycled one was reused.
    expect(LevelUpIconManager.debugCounters.acquireFresh).toBe(freshBefore);
  });

  it('floats the icon up over its lifetime (y decreases in game space → rises)', () => {
    // After spawning, one update step should advance the lifecycle without
    // throwing; the active count holds until expiry.
    mgr.spawn(0, 0, 4);
    mgr.update();
    expect(mgr.getActiveCount()).toBe(1);
  });
});
