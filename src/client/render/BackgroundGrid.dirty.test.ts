/**
 * Plan: combat-fx-hunt (2026-05-31) — regression lock for the
 * BackgroundGrid dirty-flag optimisation.
 *
 * Pre-fix: `update(camera)` cleared + rebuilt the micro AND macro
 * grid `Graphics` every frame regardless of whether the camera had
 * moved past a cell boundary. With ~30 visible grid lines × 3 Pixi
 * ops (moveTo + lineTo + stroke) × 60 Hz, that's ~5400 graphics
 * ops/sec — the #2 source of per-frame Pixi v8 ShapePath /
 * GpuGraphicsContext churn under combat after HealthBars.
 *
 * Post-fix: bounds-cache (`prevMicro*` / `prevMacro*`) — rebuild
 * only when the snapped bounds change. A stationary or slowly-moving
 * camera (typical held-fire combat) skips the rebuild every frame
 * after the first. Sentinels (NaN) force the first paint.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BackgroundGrid } from './BackgroundGrid.js';

vi.mock('pixi.js', () => {
  class FakeContainer {
    x = 0;
    y = 0;
    scale = { x: 1, y: 1, set: vi.fn() };
    children: unknown[] = [];
    addChild(c: unknown): void { this.children.push(c); }
    destroy(_opts?: unknown): void { /* noop */ }
  }
  class FakeGraphics extends FakeContainer {
    clear = vi.fn().mockReturnThis();
    moveTo = vi.fn().mockReturnThis();
    lineTo = vi.fn().mockReturnThis();
    stroke = vi.fn().mockReturnThis();
    rect = vi.fn().mockReturnThis();
    fill = vi.fn().mockReturnThis();
    destroy = vi.fn();
  }
  class FakeText extends FakeContainer {
    alpha = 1;
    position = { set: vi.fn() };
    destroy = vi.fn();
    constructor(_opts?: unknown) { super(); }
  }
  return {
    Container: FakeContainer,
    Graphics: FakeGraphics,
    Text: FakeText,
    TextStyle: class {},
  };
});

interface MockCamera {
  center: { x: number; y: number };
  worldScreenWidth: number;
  worldScreenHeight: number;
  scale: { x: number };
  addChild: (c: unknown) => void;
}

function makeCamera(cx: number, cy: number, scale = 1.0): MockCamera {
  return {
    center: { x: cx, y: cy },
    worldScreenWidth: 800 / scale,
    worldScreenHeight: 600 / scale,
    scale: { x: scale },
    addChild: vi.fn(),
  };
}

describe('BackgroundGrid — dirty-flag optimisation', () => {
  let grid: BackgroundGrid;

  beforeEach(() => {
    grid = new BackgroundGrid();
  });

  it('first update() builds grid geometry', () => {
    const camera = makeCamera(0, 0);
    grid.attach(camera as never);
    grid.update(camera as never);
    const micro = (grid as unknown as { microLines: { clear: { mock: { calls: unknown[] } }; moveTo: { mock: { calls: unknown[] } } } }).microLines;
    expect(micro.clear.mock.calls.length).toBe(1);
    expect(micro.moveTo.mock.calls.length).toBeGreaterThan(0);
  });

  it('subsequent update() with same camera position SKIPS the rebuild', () => {
    const camera = makeCamera(0, 0);
    grid.attach(camera as never);
    grid.update(camera as never); // first paint
    const micro = (grid as unknown as { microLines: { clear: { mock: { calls: unknown[] } }; moveTo: { mock: { calls: unknown[] } } } }).microLines;
    const macro = (grid as unknown as { macroLines: { clear: { mock: { calls: unknown[] } } } }).macroLines;
    const microClearAfterFirst = micro.clear.mock.calls.length;
    const microMoveToAfterFirst = micro.moveTo.mock.calls.length;
    const macroClearAfterFirst = macro.clear.mock.calls.length;

    // Five identical update calls — bounds unchanged, no rebuild.
    grid.update(camera as never);
    grid.update(camera as never);
    grid.update(camera as never);
    grid.update(camera as never);
    grid.update(camera as never);

    expect(micro.clear.mock.calls.length).toBe(microClearAfterFirst);
    expect(micro.moveTo.mock.calls.length).toBe(microMoveToAfterFirst);
    expect(macro.clear.mock.calls.length).toBe(macroClearAfterFirst);
  });

  it('sub-cell camera motion (< 500u) keeps the cache', () => {
    const camera = makeCamera(0, 0);
    grid.attach(camera as never);
    grid.update(camera as never);
    const micro = (grid as unknown as { microLines: { clear: { mock: { calls: unknown[] } } } }).microLines;
    const before = micro.clear.mock.calls.length;

    // Move by 50u — strictly within the same snapped CELL_SIZE bucket.
    // The bounds snap to multiples of 500u; small motion inside the
    // same bucket leaves the snapped min/max unchanged. (At halfW =
    // 2900 the right-edge snap-distance margin is ~100u from origin,
    // so 50u is safely inside.)
    camera.center.x = 50;
    camera.center.y = 50;
    grid.update(camera as never);
    expect(micro.clear.mock.calls.length).toBe(before);

    // Another sub-cell nudge.
    camera.center.x = 80;
    camera.center.y = 80;
    grid.update(camera as never);
    expect(micro.clear.mock.calls.length).toBe(before);
  });

  it('crossing a cell boundary (>= 500u) DOES rebuild micro grid', () => {
    const camera = makeCamera(0, 0);
    grid.attach(camera as never);
    grid.update(camera as never);
    const micro = (grid as unknown as { microLines: { clear: { mock: { calls: unknown[] } } } }).microLines;
    const before = micro.clear.mock.calls.length;

    // Move 1500u — crosses ~3 cell boundaries; bounds shift.
    camera.center.x = 1500;
    grid.update(camera as never);
    expect(micro.clear.mock.calls.length).toBe(before + 1);
  });

  it('60 frames of stationary camera = exactly 1 grid build (not 60)', () => {
    const camera = makeCamera(0, 0);
    grid.attach(camera as never);
    for (let i = 0; i < 60; i++) {
      grid.update(camera as never);
    }
    const micro = (grid as unknown as { microLines: { clear: { mock: { calls: unknown[] } } } }).microLines;
    const macro = (grid as unknown as { macroLines: { clear: { mock: { calls: unknown[] } } } }).macroLines;
    expect(micro.clear.mock.calls.length).toBe(1);
    expect(macro.clear.mock.calls.length).toBe(1);
  });
});
