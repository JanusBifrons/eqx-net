/**
 * Wheel-zoom ease at capital zoom (owner report 2026-11-12, long-guns clip:
 * "It chugs like crazy when zooming out"). The ease used to end by snapping to
 * the target once within an ABSOLUTE 0.001 of it. That was written when the
 * zoom floor was 0.15; a battleship's gunnery floor is ~0.0085, where 0.001 is
 * ~12 % of the scale, so the last part of every wheel notch landed in one
 * frame and the camera then sat still until the next notch (a measured
 * per-frame step trace of 17 14 12 10 9 7 6 5 4 3 **17** 0 0 …). The snap must
 * be relative to the scale, so an ease only ever slows down.
 */
import { describe, it, expect } from 'vitest';
import { Camera, type CameraTarget } from './Camera.js';

function makeCam(start: number): { cam: Camera; target: CameraTarget } {
  const target: CameraTarget = {
    x: 0, y: 0,
    scale: { x: 1, y: 1, set(s: number) { this.x = s; this.y = s; } },
  };
  const cam = new Camera(target, { minScale: 0.005, maxScale: 3, followLerpFactor: 1 });
  cam.setScreenSize(1280, 720);
  cam.setZoom(start);
  return { cam, target };
}

/** Per-frame zoom steps (|log ratio|) after one wheel-out notch. */
function notchSteps(start: number): number[] {
  const { cam, target } = makeCam(start);
  cam.onWheel(100, 640, 360);
  const steps: number[] = [];
  let prev = target.scale.x;
  for (let i = 0; i < 60; i++) {
    cam.tick(1000 / 60);
    const s = target.scale.x;
    steps.push(Math.abs(Math.log(prev / s)));
    prev = s;
  }
  return steps;
}

describe('Camera wheel-zoom ease', () => {
  for (const start of [1, 0.15, 0.05, 0.0127, 0.0085]) {
    it(`never jumps at the end of a notch (start scale ${start})`, () => {
      const steps = notchSteps(start);
      for (let i = 1; i < steps.length; i++) {
        // A step may only shrink (ease-out). The final settle may exceed the
        // step before it by at most 0.02 % of the scale (well under a pixel).
        expect(steps[i]!, `frame ${i}: ${steps.map((s) => (s * 1000).toFixed(1)).join(' ')}`)
          .toBeLessThanOrEqual(steps[i - 1]! + 2e-4);
      }
    });
  }

  it('still settles exactly on the target', () => {
    const { cam, target } = makeCam(0.0085 * 2);
    cam.onWheel(100, 640, 360);
    for (let i = 0; i < 600; i++) cam.tick(1000 / 60);
    const after = target.scale.x;
    cam.tick(1000 / 60);
    expect(target.scale.x).toBe(after);
  });
});
