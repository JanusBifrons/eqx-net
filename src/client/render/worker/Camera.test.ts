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

describe('Camera — wheel zoom (eased)', () => {
  // Helper: drive enough ticks for the exp-ease to converge to target.
  const settle = (cam: Camera): void => {
    for (let i = 0; i < 200; i++) cam.tick(16.67);
  };

  it('onWheel sets a target but leaves the live scale unchanged until tick()', () => {
    const target = makeTarget();
    const cam = new Camera(target);
    cam.onWheel(-100, 400, 300);
    expect(target.scale.x).toBe(1);
    cam.tick(16.67);
    expect(target.scale.x).toBeGreaterThan(1);
  });

  it('wheel up eases in toward 1.1 (scale increases)', () => {
    const target = makeTarget();
    const cam = new Camera(target);
    cam.onWheel(-100, 400, 300);
    settle(cam);
    expect(target.scale.x).toBeCloseTo(1.1, 5);
  });

  it('wheel down eases out toward 0.9 (scale decreases)', () => {
    const target = makeTarget();
    const cam = new Camera(target);
    cam.onWheel(100, 400, 300);
    settle(cam);
    expect(target.scale.x).toBeCloseTo(0.9, 5);
  });

  it('the ease is monotonic toward the target on each tick', () => {
    const target = makeTarget();
    const cam = new Camera(target);
    cam.onWheel(-100, 400, 300);
    let prev = target.scale.x;
    for (let i = 0; i < 20; i++) {
      cam.tick(16.67);
      expect(target.scale.x).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(target.scale.x).toBeLessThanOrEqual(1.1 + 1e-9);
      prev = target.scale.x;
    }
  });

  it('the ease is framerate-independent (one 33.34ms tick ≈ two 16.67ms ticks)', () => {
    const a = makeTarget();
    const camA = new Camera(a);
    camA.onWheel(-100, 400, 300);
    camA.tick(33.34);

    const b = makeTarget();
    const camB = new Camera(b);
    camB.onWheel(-100, 400, 300);
    camB.tick(16.67);
    camB.tick(16.67);

    expect(a.scale.x).toBeCloseTo(b.scale.x, 3);
  });

  it('keeps the world point under the pointer fixed at every tick of the ease', () => {
    const target = makeTarget();
    const cam = new Camera(target); // free camera (no follow) → anchor at cursor
    const worldXBefore = (100 - target.x) / target.scale.x;
    const worldYBefore = (50 - target.y) / target.scale.y;
    cam.onWheel(-100, 100, 50);
    for (let i = 0; i < 30; i++) {
      cam.tick(16.67);
      const screenX = target.x + worldXBefore * target.scale.x;
      const screenY = target.y + worldYBefore * target.scale.y;
      expect(screenX).toBeCloseTo(100, 5);
      expect(screenY).toBeCloseTo(50, 5);
    }
  });

  it('scale clamps to maxScale after the ease', () => {
    const target = makeTarget();
    const cam = new Camera(target, { maxScale: 1.05 });
    cam.onWheel(-100, 0, 0);
    cam.onWheel(-100, 0, 0);
    settle(cam);
    expect(target.scale.x).toBeLessThanOrEqual(1.05 + 1e-9);
    expect(target.scale.x).toBeCloseTo(1.05);
  });

  it('scale clamps to minScale after the ease', () => {
    const target = makeTarget();
    const cam = new Camera(target, { minScale: 0.95 });
    cam.onWheel(100, 0, 0);
    cam.onWheel(100, 0, 0);
    settle(cam);
    expect(target.scale.x).toBeGreaterThanOrEqual(0.95 - 1e-9);
    expect(target.scale.x).toBeCloseTo(0.95);
  });
});

describe('Camera — setZoom', () => {
  it('sets the scale immediately and clamps to [min,max]', () => {
    const target = makeTarget();
    const cam = new Camera(target, { minScale: 0.4, maxScale: 3 });
    cam.setScreenSize(800, 600);
    cam.setZoom(0.7);
    expect(target.scale.x).toBeCloseTo(0.7);
    cam.setZoom(99);
    expect(target.scale.x).toBeCloseTo(3);
    cam.setZoom(0.01);
    expect(target.scale.x).toBeCloseTo(0.4);
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

  it('the FINAL release of a pinch is NOT a tap (Phase 2 #1 — pinch must not select)', () => {
    const target = makeTarget();
    const cam = new Camera(target);

    // Pinch: two fingers down, lift the second (resumes pan from the first),
    // then lift the first quickly + near where it is — which WOULD classify as a
    // tap on the resumed single-pointer drag without the multi-touch latch.
    cam.onPointerDown(1, 100, 100, 0);
    cam.onPointerDown(2, 200, 100, 0);
    cam.onPointerUp(2, 200, 100, 50);
    const result = cam.onPointerUp(1, 101, 100, 90); // small distance, short time

    expect(result.wasTap).toBe(false);
  });

  it('a clean single tap still works AFTER a completed pinch (latch resets)', () => {
    const target = makeTarget();
    const cam = new Camera(target);

    // Complete a pinch.
    cam.onPointerDown(1, 100, 100, 0);
    cam.onPointerDown(2, 200, 100, 0);
    cam.onPointerUp(2, 200, 100, 50);
    cam.onPointerUp(1, 101, 100, 90); // ends the gesture → latch clears

    // A subsequent clean single-finger tap registers normally.
    cam.onPointerDown(3, 300, 300, 200);
    cam.onPointerMove(3, 301, 300);
    const result = cam.onPointerUp(3, 301, 300, 240);

    expect(result.wasTap).toBe(true);
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

describe('Camera — one-shot glide (Phase 4 WS-A2 smooth ship-switch)', () => {
  it('glideTo eases a world point to screen-centre over the duration, then clears', () => {
    const target = makeTarget();
    const cam = new Camera(target, { followLerpFactor: 1 });
    cam.setScreenSize(800, 600);

    // Camera starts centred on world (0,0): target = screenCentre - 0 = (400,300).
    cam.moveCenter(0, 0);
    expect(cam.center.x).toBeCloseTo(0, 5);
    expect(cam.center.y).toBeCloseTo(0, 5);

    // Glide the view to world (1000, 0) over 200 ms.
    cam.glideTo(1000, 0, 200);
    expect(cam.isGliding()).toBe(true);

    // Half-way through the glide the centre is NOT yet at the target and NOT
    // still at the start — it's an intermediate point (asserts a LERP, not a
    // jump). With an ease curve the midpoint isn't exactly 500, but it must be
    // strictly between the endpoints.
    cam.tick(100);
    const mid = cam.center.x;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1000);

    // Drive past the duration — the glide completes AT the target and clears.
    cam.tick(100);
    cam.tick(16);
    expect(cam.center.x).toBeCloseTo(1000, 3);
    expect(cam.center.y).toBeCloseTo(0, 3);
    expect(cam.isGliding()).toBe(false);
  });

  it('an active glide OVERRIDES the follow target (so a high-lerp follow cannot snap mid-glide)', () => {
    const target = makeTarget();
    // followLerpFactor:1 == the production gameplay camera (instant snap each tick).
    const cam = new Camera(target, { followLerpFactor: 1 });
    cam.setScreenSize(800, 600);
    cam.moveCenter(0, 0);

    // The follow target is the NEW ship at (1000,0); a glide to the same point.
    cam.follow({ x: 1000, y: 0 });
    cam.glideTo(1000, 0, 200);

    // One tick: follow alone (lerp 1) would SNAP the centre to 1000 immediately.
    // The glide must override → the centre is an intermediate point, not 1000.
    cam.tick(50);
    expect(cam.center.x).toBeLessThan(1000);
    expect(cam.center.x).toBeGreaterThan(0);

    // Once the glide finishes, follow resumes (the centre tracks the target).
    cam.tick(160);
    cam.tick(16);
    expect(cam.isGliding()).toBe(false);
    cam.tick(16);
    expect(cam.center.x).toBeCloseTo(1000, 3);
  });

  it('cancelGlide stops the ease and hands the camera back to follow/pan', () => {
    const target = makeTarget();
    const cam = new Camera(target, { followLerpFactor: 1 });
    cam.setScreenSize(800, 600);
    cam.moveCenter(0, 0);
    cam.glideTo(1000, 0, 400);
    cam.tick(50);
    expect(cam.isGliding()).toBe(true);
    cam.cancelGlide();
    expect(cam.isGliding()).toBe(false);
  });
});

describe('Camera — WASD free-pan velocity (Phase 5 spectator)', () => {
  it('integrates the pan velocity into the target each tick (px/sec × dt)', () => {
    const target = makeTarget();
    const cam = new Camera(target);
    cam.setScreenSize(800, 600);
    cam.setPanVelocity(-800, 565.7);
    cam.tick(1000); // 1 s → the full velocity is applied
    expect(target.x).toBeCloseTo(-800, 3);
    expect(target.y).toBeCloseTo(565.7, 3);
    cam.tick(500); // +0.5 s → half again
    expect(target.x).toBeCloseTo(-1200, 3);
    expect(target.y).toBeCloseTo(565.7 + 282.85, 2);
  });

  it('a zero velocity does not move the camera', () => {
    const target = makeTarget();
    const cam = new Camera(target);
    cam.setScreenSize(800, 600);
    cam.setPanVelocity(0, 0);
    cam.tick(1000);
    expect(target.x).toBe(0);
    expect(target.y).toBe(0);
  });

  it('does NOT pan while a pointer drag owns the camera (the two sources do not fight)', () => {
    const target = makeTarget();
    const cam = new Camera(target);
    cam.setScreenSize(800, 600);
    cam.setPanVelocity(-800, 0);
    cam.onPointerDown(1, 100, 100, 0); // a drag is now active
    cam.tick(1000);
    expect(target.x).toBe(0); // WASD pan suppressed while dragging
  });
});
