/**
 * Camera ↔ cinematic director precedence (docs/architecture/cinematic-camera.md).
 * Locks: director beats follow + glide + pan; the spring converges without
 * overshoot and shows intermediate frames; smoothMs 0 is a hard cut; zoom is
 * clamped; clearDirector hands control back to follow.
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

function makeCam(): { cam: Camera; target: CameraTarget } {
  const target = makeTarget();
  const cam = new Camera(target, { minScale: 0.15, maxScale: 3, followLerpFactor: 1 });
  cam.setScreenSize(800, 600);
  cam.moveCenter(0, 0);
  return { cam, target };
}

describe('Camera — cinematic director', () => {
  it('converges on the target with intermediate frames and no overshoot', () => {
    const { cam } = makeCam();
    cam.setDirectorTarget(1000, 0, 1, 300);
    const xs: number[] = [];
    for (let i = 0; i < 120; i++) {
      cam.tick(16.67);
      xs.push(cam.center.x);
    }
    expect(xs[3]!).toBeGreaterThan(0);
    expect(xs[3]!).toBeLessThan(1000); // eased, not a snap
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThanOrEqual(xs[i - 1]! - 1e-9);
    expect(Math.max(...xs)).toBeLessThanOrEqual(1000 + 1e-6); // no overshoot
    expect(xs[xs.length - 1]!).toBeCloseTo(1000, 0);
  });

  it('smoothMs 0 cuts on the next tick', () => {
    const { cam, target } = makeCam();
    cam.setDirectorTarget(-500, 250, 2, 0);
    cam.tick(16.67);
    expect(cam.center.x).toBeCloseTo(-500, 6);
    expect(cam.center.y).toBeCloseTo(250, 6);
    expect(target.scale.x).toBe(2);
  });

  it('overrides an existing follow target and an in-flight glide', () => {
    const { cam } = makeCam();
    cam.follow({ x: 9999, y: 9999 });
    cam.glideTo(-9999, 0, 1000);
    cam.setDirectorTarget(100, 100, 1, 0);
    for (let i = 0; i < 10; i++) cam.tick(16.67);
    expect(cam.isGliding()).toBe(false);
    expect(cam.center.x).toBeCloseTo(100, 6);
    expect(cam.center.y).toBeCloseTo(100, 6);
  });

  it('ignores WASD pan velocity while directed', () => {
    const { cam } = makeCam();
    cam.setPanVelocity(800, 0);
    cam.setDirectorTarget(0, 0, 1, 0);
    for (let i = 0; i < 30; i++) cam.tick(16.67);
    expect(cam.center.x).toBeCloseTo(0, 6);
  });

  it('clamps the requested zoom to the camera range', () => {
    const { cam, target } = makeCam();
    cam.setDirectorTarget(0, 0, 50, 0);
    cam.tick(16.67);
    expect(target.scale.x).toBe(3);
    cam.setDirectorTarget(0, 0, 0.001, 0);
    cam.tick(16.67);
    expect(target.scale.x).toBe(0.15);
  });

  it('zoom eases geometrically toward the target', () => {
    const { cam, target } = makeCam();
    cam.setDirectorTarget(0, 0, 0.25, 400);
    cam.tick(16.67);
    const first = target.scale.x;
    expect(first).toBeLessThan(1);
    expect(first).toBeGreaterThan(0.25);
    for (let i = 0; i < 200; i++) cam.tick(16.67);
    expect(target.scale.x).toBeCloseTo(0.25, 3);
  });

  it('clearDirector hands control back to follow', () => {
    const { cam } = makeCam();
    cam.setDirectorTarget(500, 0, 1, 0);
    cam.tick(16.67);
    cam.clearDirector();
    expect(cam.isDirected()).toBe(false);
    cam.follow({ x: -200, y: 0 });
    cam.tick(16.67);
    expect(cam.center.x).toBeCloseTo(-200, 6);
  });
});
