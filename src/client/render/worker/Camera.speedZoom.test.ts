/**
 * Camera speed zoom-out (plan iridescent-seeking-rainbow v5, C3). The drawn
 * scale is the player's zoom × the speed factor. Locks: the player's zoom is
 * never changed by it (wheel, pinch, setZoom all compose with it, and it
 * comes back exactly when the speed drops), picking uses the drawn scale,
 * the centre stays put, and the cinematic director is never speed-zoomed.
 */
import { describe, it, expect } from 'vitest';
import { Camera, type CameraTarget } from './Camera.js';

function makeCam(): { cam: Camera; target: CameraTarget } {
  const target: CameraTarget = {
    x: 0, y: 0,
    scale: { x: 1, y: 1, set(s: number) { this.x = s; this.y = s; } },
  };
  const cam = new Camera(target, { minScale: 0.15, maxScale: 3, followLerpFactor: 1, zoomSmoothTimeMs: 1 });
  cam.setScreenSize(800, 600);
  cam.setZoom(1.5);
  cam.moveCenter(100, -200);
  return { cam, target };
}

describe('Camera — speed zoom', () => {
  it('draws at player zoom × factor, keeps the centre, and restores the exact player zoom', () => {
    const { cam, target } = makeCam();
    cam.follow({ x: 100, y: -200 });
    cam.setSpeedZoom(0.8);
    cam.tick();
    expect(target.scale.x).toBeCloseTo(1.2, 10);
    expect(cam.playerScale()).toBeCloseTo(1.5, 10);
    expect(cam.center.x).toBeCloseTo(100, 6);
    expect(cam.center.y).toBeCloseTo(-200, 6);
    for (let i = 0; i < 1000; i++) cam.tick();
    cam.setSpeedZoom(1);
    cam.tick();
    expect(target.scale.x).toBe(1.5);
  });

  it('picking (screenToWorld) uses the drawn scale', () => {
    const { cam } = makeCam();
    cam.follow({ x: 100, y: -200 });
    cam.setSpeedZoom(0.8);
    cam.tick();
    // 100 px right of the centre is 100 / 1.2 world units at the drawn scale.
    const w = cam.screenToWorld(500, 300);
    expect(w.x).toBeCloseTo(100 + 100 / 1.2, 6);
    expect(w.y).toBeCloseTo(-200, 6);
  });

  it('wheel and setZoom change the player zoom, not the factor', () => {
    const { cam, target } = makeCam();
    cam.follow({ x: 100, y: -200 });
    cam.setSpeedZoom(0.8);
    cam.tick();
    cam.onWheel(-1, 400, 300); // zoom in one step (×1.1)
    for (let i = 0; i < 60; i++) cam.tick();
    expect(cam.playerScale()).toBeCloseTo(1.65, 6);
    expect(target.scale.x).toBeCloseTo(1.65 * 0.8, 6);
    cam.setZoom(2);
    cam.tick();
    expect(cam.playerScale()).toBeCloseTo(2, 6);
    expect(target.scale.x).toBeCloseTo(1.6, 6);
  });

  it('a pinch during speed zoom scales the player zoom by the pinch ratio', () => {
    const { cam } = makeCam();
    cam.setSpeedZoom(0.8);
    cam.tick();
    cam.onPointerDown(1, 300, 300, 0);
    cam.onPointerDown(2, 500, 300, 0);
    cam.onPointerMove(2, 700, 300); // fingers twice as far apart
    cam.onPointerUp(2, 700, 300, 50);
    cam.onPointerUp(1, 300, 300, 50);
    cam.tick();
    expect(cam.playerScale()).toBeCloseTo(3, 6); // 1.5 × 2, clamped at max 3
    cam.setSpeedZoom(1);
    cam.tick();
    expect(cam.playerScale()).toBeCloseTo(3, 6);
  });

  it('the cinematic director is never speed-zoomed', () => {
    const { cam, target } = makeCam();
    cam.setSpeedZoom(0.8);
    cam.setDirectorTarget(0, 0, 2, 0);
    cam.tick();
    expect(target.scale.x).toBe(2);
    expect(cam.speedZoom()).toBe(1);
  });

  it('clamps the factor to 0.5..1', () => {
    const { cam } = makeCam();
    cam.setSpeedZoom(0.1); cam.tick();
    expect(cam.speedZoom()).toBe(0.5);
    cam.setSpeedZoom(3); cam.tick();
    expect(cam.speedZoom()).toBe(1);
  });
});
