import { describe, it, expect } from 'vitest';
import { resolveRadarReference } from './radarReference.js';

describe('resolveRadarReference (Phase 5 — camera-relative spectator ring)', () => {
  it('SPECTATING — references the camera centre (Y un-flipped to game space), decoupled from any ship', () => {
    const out = { x: 0, y: 0 };
    // camera.center is pixi(Y-down): (300, 120) → game(Y-up): (300, -120).
    const has = resolveRadarReference(true, 9999, 8888, 300, 120, out);
    expect(has).toBe(true);
    expect(out).toEqual({ x: 300, y: -120 }); // the SHIP pose (9999,8888) is ignored
  });

  it('SPECTATING with NO local ship still references the camera (the decouple works shipless)', () => {
    const out = { x: 0, y: 0 };
    const has = resolveRadarReference(true, null, null, -50, 30, out);
    expect(has).toBe(true);
    expect(out).toEqual({ x: -50, y: -30 });
  });

  it('PILOTING — references the local ship pose (game space, unchanged)', () => {
    const out = { x: 0, y: 0 };
    const has = resolveRadarReference(false, 42, -17, 999, 999, out);
    expect(has).toBe(true);
    expect(out).toEqual({ x: 42, y: -17 }); // the camera centre is ignored
  });

  it('PILOTING with no local ship → no reference (caller hides the ring)', () => {
    const out = { x: 7, y: 7 };
    const has = resolveRadarReference(false, null, null, 1, 2, out);
    expect(has).toBe(false);
    expect(out).toEqual({ x: 7, y: 7 }); // untouched
  });
});
