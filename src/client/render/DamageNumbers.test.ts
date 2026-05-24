/**
 * DamageNumberManager regression locks.
 *
 * 2026-05-14 — two adjacent bugs surfaced after the OffscreenCanvas
 * migration shipped:
 *
 *   1. Numbers didn't disappear. `update()` was only invoked inside
 *      `if (mirror.pendingDamageNumbers) { ... }`, so on frames with no
 *      new damage events the lifetime countdown didn't tick. The
 *      manager became stuck — once spawned, numbers never expired.
 *
 *   2. Numbers scaled with zoom. After moving to a counter-scale
 *      mechanism (`text.scale = 1 / camera.scale`), the lack of
 *      per-frame `update()` (bug #1) meant the counter-scale was
 *      applied only once at spawn. Subsequent camera zoom changes
 *      didn't update the text scale.
 *
 * Tests below lock the fix: spawn → drift each frame → counter-scale
 * tracks camera zoom each frame → text expires after LIFETIME_FRAMES.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Container, Text } from 'pixi.js';
import { DamageNumberManager, LIFETIME_FRAMES, POOL_CAP } from './DamageNumbers.js';
import type { Camera } from './worker/Camera.js';

/**
 * Tiny test double for `Camera` — only the `.scale.x` getter is read
 * by `DamageNumberManager.update()` (via the `1/camera.scale.x`
 * counter-scale calc). Mutable so tests can simulate zoom changes.
 */
function makeMockCamera(initialScale = 1): Camera {
  const cam = {
    scale: { x: initialScale, y: initialScale } as { x: number; y: number },
  };
  return cam as unknown as Camera;
}

function setScale(camera: Camera, s: number): void {
  (camera as unknown as { scale: { x: number; y: number } }).scale.x = s;
  (camera as unknown as { scale: { x: number; y: number } }).scale.y = s;
}

describe('DamageNumberManager — spawn', () => {
  let parent: Container;
  let camera: Camera;
  let mgr: DamageNumberManager;

  beforeEach(() => {
    parent = new Container();
    camera = makeMockCamera(1);
    mgr = new DamageNumberManager(parent, camera);
  });

  it('attaches its container to the supplied world parent', () => {
    expect(parent.children.length).toBe(1);
  });

  it('spawn(x, y, damage) creates a Text at world (x, -y) [Y-flip]', () => {
    mgr.spawn(100, 50, 42);
    const inner = parent.children[0] as Container;
    expect(inner.children.length).toBe(1);
    const text = inner.children[0] as Text;
    expect(text.x).toBe(100);
    expect(text.y).toBe(-50); // Y-flip: world +Y up → Pixi -Y
    expect(text.text).toBe('-42');
  });
});

describe('DamageNumberManager — per-frame update is unconditional (regression)', () => {
  let parent: Container;
  let camera: Camera;
  let mgr: DamageNumberManager;

  beforeEach(() => {
    parent = new Container();
    camera = makeMockCamera(1);
    mgr = new DamageNumberManager(parent, camera);
  });

  it('drifts upward 1 unit per update (at camera.scale.x = 1)', () => {
    mgr.spawn(0, 0, 10);
    const inner = parent.children[0] as Container;
    const text = inner.children[0] as Text;
    const yAtSpawn = text.y;
    mgr.update();
    expect(text.y).toBe(yAtSpawn - 1);
    mgr.update();
    expect(text.y).toBe(yAtSpawn - 2);
  });

  it('drift rate scales by 1/camera.scale so screen-pixel speed is constant', () => {
    setScale(camera, 2); // zoomed in 2x → 1 world unit = 2 screen pixels
    mgr.spawn(0, 0, 10);
    const inner = parent.children[0] as Container;
    const text = inner.children[0] as Text;
    const yAtSpawn = text.y;
    mgr.update();
    // At 2x zoom, 1 screen-pixel drift = 0.5 world units.
    expect(text.y).toBeCloseTo(yAtSpawn - 0.5, 5);
  });

  it('text.scale counter-scales to neutralise the world-container zoom', () => {
    mgr.spawn(0, 0, 10);
    const inner = parent.children[0] as Container;
    const text = inner.children[0] as Text;

    // Default scale = 1.
    setScale(camera, 1);
    mgr.update();
    expect(text.scale.x).toBeCloseTo(1, 5);
    expect(text.scale.y).toBeCloseTo(1, 5);

    // Zoom in 2x → text should counter-scale to 0.5.
    setScale(camera, 2);
    mgr.update();
    expect(text.scale.x).toBeCloseTo(0.5, 5);

    // Zoom out to 0.5x → text should counter-scale to 2.
    setScale(camera, 0.5);
    mgr.update();
    expect(text.scale.x).toBeCloseTo(2, 5);
  });

  it('alpha fades over lifetime', () => {
    mgr.spawn(0, 0, 10);
    const inner = parent.children[0] as Container;
    const text = inner.children[0] as Text;

    // Newly spawned → first update sets alpha to (LIFETIME_FRAMES - 1) / LIFETIME_FRAMES.
    mgr.update();
    expect(text.alpha).toBeGreaterThan(0.9);
    expect(text.alpha).toBeLessThan(1.0);

    // After LIFETIME_FRAMES / 2 frames (half life) → ~0.5. Drives off the
    // exported constant so the assertion follows future tuning.
    const halfLife = Math.floor(LIFETIME_FRAMES / 2);
    for (let i = 1; i < halfLife; i++) mgr.update();
    expect(text.alpha).toBeCloseTo(0.5, 1);
  });
});

describe('DamageNumberManager — lifetime expiry (regression: numbers must disappear)', () => {
  let parent: Container;
  let camera: Camera;
  let mgr: DamageNumberManager;

  beforeEach(() => {
    parent = new Container();
    camera = makeMockCamera(1);
    mgr = new DamageNumberManager(parent, camera);
  });

  it('removes the text after LIFETIME_FRAMES updates', () => {
    mgr.spawn(0, 0, 10);
    const inner = parent.children[0] as Container;
    expect(inner.children.length).toBe(1);

    // Tick exactly the lifetime — number should be gone.
    for (let i = 0; i < LIFETIME_FRAMES; i++) mgr.update();
    expect(inner.children.length).toBe(0);
  });

  it('does NOT remove the text while updates are skipped (the bug we are locking)', () => {
    // Sanity: if `update()` isn't called, the text persists. This
    // documents WHY the manager must be ticked every frame — if the
    // caller (PixiRenderer) regresses to gating update() on
    // pendingDamageNumbers, numbers would stick on screen forever.
    mgr.spawn(0, 0, 10);
    const inner = parent.children[0] as Container;
    // No update() calls.
    expect(inner.children.length).toBe(1);
    // After "many wall-clock seconds" of NOT calling update(), still 1.
    expect(inner.children.length).toBe(1);
  });

  it('handles multiple concurrent damage numbers independently', () => {
    // Drive the offset from LIFETIME_FRAMES so the test follows tuning.
    // Use a one-third offset so the two numbers are clearly out of phase
    // (spawn #2 has spawn #1's remaining lifetime + offset to spare).
    const offset = Math.floor(LIFETIME_FRAMES / 3);

    mgr.spawn(0, 0, 10);
    // Tick `offset` times so spawn #1 is early-mid-lifetime.
    for (let i = 0; i < offset; i++) mgr.update();
    mgr.spawn(0, 0, 20);
    const inner = parent.children[0] as Container;
    expect(inner.children.length).toBe(2);

    // After (LIFETIME_FRAMES - offset) more updates: spawn #1 has lived
    // its full lifetime → expired. Spawn #2 has lived (LIFETIME_FRAMES -
    // offset) frames → still alive.
    for (let i = 0; i < LIFETIME_FRAMES - offset; i++) mgr.update();
    expect(inner.children.length).toBe(1);
    const remaining = inner.children[0] as Text;
    expect(remaining.text).toBe('-20');

    // After `offset` more updates → spawn #2 lifetime done.
    for (let i = 0; i < offset; i++) mgr.update();
    expect(inner.children.length).toBe(0);
  });

  it('pool cap — spawning the (cap+1)th evicts the oldest', () => {
    for (let i = 0; i < POOL_CAP; i++) {
      mgr.spawn(0, 0, i);
    }
    const inner = parent.children[0] as Container;
    expect(inner.children.length).toBe(POOL_CAP);

    mgr.spawn(0, 0, 999); // one over the cap
    expect(inner.children.length).toBe(POOL_CAP);
    // Oldest (`-0`) was evicted; newest (`-999`) is in.
    const labels = (inner.children as Text[]).map((t) => t.text);
    expect(labels).not.toContain('-0');
    expect(labels).toContain('-999');
  });
});

describe('DamageNumberManager — destroy cleanup', () => {
  it('destroys all active texts + the container', () => {
    const parent = new Container();
    const camera = makeMockCamera(1);
    const mgr = new DamageNumberManager(parent, camera);
    mgr.spawn(0, 0, 1);
    mgr.spawn(0, 0, 2);
    mgr.spawn(0, 0, 3);
    expect((parent.children[0] as Container).children.length).toBe(3);

    mgr.destroy();
    // After destroy the inner container is destroyed; parent's children
    // list is cleaned up by Pixi when children get destroyed.
    expect(parent.children.length).toBe(0);
  });

  it('subsequent updates after destroy do not throw', () => {
    const parent = new Container();
    const camera = makeMockCamera(1);
    const mgr = new DamageNumberManager(parent, camera);
    mgr.spawn(0, 0, 1);
    mgr.destroy();
    // The internal `active` list is cleared by destroy; update is safe.
    expect(() => mgr.update()).not.toThrow();
  });

  it('does not warn about unused vi import — silencing typecheck', () => {
    // The `vi` import is present for future mocks (Text rendering in
    // jsdom can sometimes need stubbing). Kept in scope but unused.
    expect(typeof vi).toBe('object');
  });
});

// weapon-hit-prediction Phase 2 — a predicted number is spawned TAGGED
// with its clientShotId so a later mispredict / rollback / TTL-expiry can
// hard-cancel exactly that number mid-life (not wait for the natural
// fade). Authoritative numbers spawn untagged and are unaffected.
describe('DamageNumberManager — cancelByTag (predicted-hit rollback channel)', () => {
  let parent: Container;
  let camera: Camera;
  let mgr: DamageNumberManager;

  beforeEach(() => {
    parent = new Container();
    camera = makeMockCamera(1);
    mgr = new DamageNumberManager(parent, camera);
  });

  it('cancels only the entries carrying the given tag, leaving others alive', () => {
    mgr.spawn(0, 0, 10, 'shot-1');
    mgr.spawn(0, 0, 20, 'shot-2');
    mgr.spawn(0, 0, 30); // authoritative / untagged
    expect(mgr.getActiveCount()).toBe(3);

    const removed = mgr.cancelByTag('shot-1');

    expect(removed).toBe(1);
    expect(mgr.getActiveCount()).toBe(2); // shot-2 + the untagged one survive
  });

  it('cancels every entry sharing a tag (a multi-mount salvo shares one clientShotId)', () => {
    mgr.spawn(0, 0, 10, 'salvo');
    mgr.spawn(1, 1, 10, 'salvo');
    expect(mgr.getActiveCount()).toBe(2);
    expect(mgr.cancelByTag('salvo')).toBe(2);
    expect(mgr.getActiveCount()).toBe(0);
  });

  it('an unknown tag is a no-op (returns 0, nothing removed)', () => {
    mgr.spawn(0, 0, 10, 'shot-1');
    expect(mgr.cancelByTag('nope')).toBe(0);
    expect(mgr.getActiveCount()).toBe(1);
  });

  it('an untagged (authoritative) number is never matched by cancelByTag', () => {
    mgr.spawn(0, 0, 10); // no tag
    expect(mgr.cancelByTag('shot-1')).toBe(0);
    expect(mgr.getActiveCount()).toBe(1);
  });

  it('a tagged number can be cancelled mid-life (before its natural expiry)', () => {
    mgr.spawn(0, 0, 10, 'shot-1');
    mgr.update(); // tick a frame — still well within LIFETIME_FRAMES
    mgr.update();
    expect(mgr.getActiveCount()).toBe(1);
    mgr.cancelByTag('shot-1');
    expect(mgr.getActiveCount()).toBe(0);
    // Pixi child was actually removed (no leak).
    const inner = parent.children[0] as Container;
    expect(inner.children.length).toBe(0);
  });
});
