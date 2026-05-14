/**
 * Unit tests for the renderer-worker `Camera`. Replaces the subset of
 * pixi-viewport we used; this file is the regression lock.
 *
 * Camera is pure — operates on a `CameraTarget` (anything with
 * `{ x, y, scale: { x, y, set } }`). Tests pass a plain object; no
 * Pixi runtime needed.
 */
import { describe, it, expect } from 'vitest';
import { Camera, type CameraTarget } from './Camera.js';

function makeTarget(): CameraTarget {
  return {
    x: 0,
    y: 0,
    scale: {
      x: 1,
      y: 1,
      set(s: number) {
        this.x = s;
        this.y = s;
      },
    },
  };
}

describe('Camera — pan', () => {
  it('a single pointer drag translates the target', () => {
    const target = makeTarget();
    const cam = new Camera(target);
    cam.setScreenSize(800, 600);

    cam.onPointerDown(1, 100, 100, 0);
    cam.onPointerMove(1, 150, 130);
    cam.onPointerUp(1, 150, 130, 50);

    // Drag of (50, 30) → target translated by (50, 30).
    expect(target.x).toBe(50);
    expect(target.y).toBe(30);
  });

  it('the tail-velocity drives momentum after release', () => {
    const target = makeTarget();
    const cam = new Camera(target, { decelFactor: 0.5, momentumEpsilon: 0.001 });

    cam.onPointerDown(1, 0, 0, 0);
    cam.onPointerMove(1, 10, 0);
    cam.onPointerMove(1, 30, 0); // last move dx = 20
    cam.onPointerUp(1, 200, 0, 500); // wasn't a tap (long distance), velocity preserved

    expect(cam.getVelocity().vx).toBe(20);

    cam.tick();
    expect(target.x).toBe(30 + 20); // post-pan target + one momentum step
    expect(cam.getVelocity().vx).toBe(20 * 0.5);
  });

  it('momentum decays below epsilon and stops', () => {
    const target = makeTarget();
    const cam = new Camera(target, { decelFactor: 0.5, momentumEpsilon: 1 });

    cam.onPointerDown(1, 0, 0, 0);
    cam.onPointerMove(1, 3, 0); // vx = 3
    cam.onPointerUp(1, 100, 0, 500);

    // Each tick: check |vx| > epsilon; if true, apply decay; else zero.
    // 3 > 1 → vx = 1.5
    // 1.5 > 1 → vx = 0.75
    // 0.75 < 1 → vx = 0
    cam.tick();
    cam.tick();
    cam.tick();

    expect(cam.getVelocity().vx).toBe(0);
  });
});

describe('Camera — tap vs drag', () => {
  it('a short, low-distance pointerdown → up is a tap', () => {
    const target = makeTarget();
    const cam = new Camera(target);

    cam.onPointerDown(1, 100, 100, 0);
    cam.onPointerMove(1, 101, 100); // pan dx = 1 → target.x becomes 1
    const result = cam.onPointerUp(1, 101, 100, 50);

    expect(result.wasTap).toBe(true);
    // worldX = (101 - target.x)/scale = (101 - 1)/1 = 100. The pan moved
    // the world to compensate by 1 px, so the world point under the
    // user's finger at release is still the originally-touched point.
    expect(result.worldX).toBe(100);
    expect(result.worldY).toBe(100);
  });

  it('a long-distance pointerdown → up is NOT a tap', () => {
    const target = makeTarget();
    const cam = new Camera(target);

    cam.onPointerDown(1, 100, 100, 0);
    cam.onPointerMove(1, 200, 200);
    const result = cam.onPointerUp(1, 200, 200, 50);

    expect(result.wasTap).toBe(false);
  });

  it('a long-duration pointerdown → up is NOT a tap', () => {
    const target = makeTarget();
    const cam = new Camera(target, { tapThresholdMs: 100 });

    cam.onPointerDown(1, 100, 100, 0);
    const result = cam.onPointerUp(1, 100, 100, 500);

    expect(result.wasTap).toBe(false);
  });
});

describe('Camera — wheel zoom', () => {
  it('wheel up zooms in (scale increases)', () => {
    const target = makeTarget();
    const cam = new Camera(target);

    cam.onWheel(-100, 400, 300);

    expect(target.scale.x).toBeCloseTo(1.1, 5);
  });

  it('wheel down zooms out (scale decreases)', () => {
    const target = makeTarget();
    const cam = new Camera(target);

    cam.onWheel(100, 400, 300);

    expect(target.scale.x).toBeCloseTo(0.9, 5);
  });

  it('zoom keeps the world point under the pointer fixed', () => {
    const target = makeTarget();
    const cam = new Camera(target);

    // World point at screen (100, 50) at scale 1 = world (100, 50).
    cam.onWheel(-100, 100, 50);

    // After zoom, world point (100, 50) should still be at screen (100, 50).
    const screenX = target.x + 100 * target.scale.x;
    const screenY = target.y + 50 * target.scale.y;
    expect(screenX).toBeCloseTo(100, 5);
    expect(screenY).toBeCloseTo(50, 5);
  });

  it('scale clamps to maxScale', () => {
    const target = makeTarget();
    const cam = new Camera(target, { maxScale: 1.05 });

    cam.onWheel(-100, 0, 0); // would scale to 1.1
    cam.onWheel(-100, 0, 0);

    expect(target.scale.x).toBeLessThanOrEqual(1.05);
  });

  it('scale clamps to minScale', () => {
    const target = makeTarget();
    const cam = new Camera(target, { minScale: 0.95 });

    cam.onWheel(100, 0, 0);
    cam.onWheel(100, 0, 0);

    expect(target.scale.x).toBeGreaterThanOrEqual(0.95);
  });
});

describe('Camera — pinch zoom', () => {
  it('two pointers spreading apart zooms in', () => {
    const target = makeTarget();
    const cam = new Camera(target);

    cam.onPointerDown(1, 100, 100, 0);
    cam.onPointerDown(2, 200, 100, 0); // initial distance 100
    cam.onPointerMove(2, 300, 100);   // new distance 200, ratio 2

    expect(target.scale.x).toBeCloseTo(2, 5);
  });

  it('two pointers pinching closer zooms out', () => {
    const target = makeTarget();
    const cam = new Camera(target);

    cam.onPointerDown(1, 100, 100, 0);
    cam.onPointerDown(2, 300, 100, 0); // distance 200
    cam.onPointerMove(2, 200, 100);   // distance 100, ratio 0.5

    expect(target.scale.x).toBeCloseTo(0.5, 5);
  });

  it('lifting one of two pinch pointers resumes single-pointer pan', () => {
    const target = makeTarget();
    const cam = new Camera(target);

    cam.onPointerDown(1, 100, 100, 0);
    cam.onPointerDown(2, 200, 100, 0);
    cam.onPointerUp(2, 200, 100, 100);

    expect(cam.getPointerCount()).toBe(1);
    expect(cam.isPanningNow()).toBe(true);
  });
});

describe('Camera — follow', () => {
  it('lerps toward the follow target each tick', () => {
    const target = makeTarget();
    const cam = new Camera(target, { followLerpFactor: 0.5 });
    cam.setScreenSize(800, 600);

    cam.follow({ x: 1000, y: 500 });

    // After one tick, target.x should have moved halfway to (screenCentre - 1000 * scale)
    // screenCentre.x = 400; target world position 1000 → screen target at 400 - 1000 = -600
    // half of distance from 0 to -600 = -300
    cam.tick();
    expect(target.x).toBe(-300);

    // After another tick, halfway again: -300 + (-600 - -300)/2 = -450
    cam.tick();
    expect(target.x).toBe(-450);
  });

  it('follow target null is a no-op on tick', () => {
    const target = makeTarget();
    const cam = new Camera(target);
    cam.setScreenSize(800, 600);

    target.x = 50;
    cam.follow(null);
    cam.tick();

    expect(target.x).toBe(50);
  });
});

describe('Camera — moveCenter / screenToWorld', () => {
  it('moveCenter positions target so a world point sits at screen-centre', () => {
    const target = makeTarget();
    const cam = new Camera(target);
    cam.setScreenSize(800, 600);

    cam.moveCenter(100, 50);

    // screen-centre = (400, 300); want world (100, 50) there.
    // target.x = 400 - 100 * 1 = 300
    // target.y = 300 - 50 * 1 = 250
    expect(target.x).toBe(300);
    expect(target.y).toBe(250);

    const { x, y } = cam.screenToWorld(400, 300);
    expect(x).toBeCloseTo(100, 5);
    expect(y).toBeCloseTo(50, 5);
  });

  it('screenToWorld inverts pan + zoom', () => {
    const target = makeTarget();
    target.x = 50;
    target.y = 30;
    target.scale.set(2);
    const cam = new Camera(target);

    // World (10, 20) at scale 2 + pan (50, 30) = screen (50 + 10*2, 30 + 20*2) = (70, 70).
    const { x, y } = cam.screenToWorld(70, 70);
    expect(x).toBeCloseTo(10, 5);
    expect(y).toBeCloseTo(20, 5);
  });
});
