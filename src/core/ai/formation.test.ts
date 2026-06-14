import { describe, it, expect } from 'vitest';
import {
  formationSlotOffset,
  formationSlotWorldPose,
  makeSlotOffset,
  type WorldPoint,
} from './formation.js';

describe('formation — slot offsets', () => {
  it('slot 0 is the leader anchor for every shape', () => {
    const o = makeSlotOffset();
    for (const shape of ['wedge', 'line', 'column'] as const) {
      formationSlotOffset(shape, 0, 8, 50, o);
      expect(o.forward).toBe(0);
      expect(o.right).toBe(0);
    }
  });

  it('column trails directly astern (no lateral spread)', () => {
    const o = makeSlotOffset();
    formationSlotOffset('column', 3, 8, 50, o);
    expect(o.forward).toBe(-150);
    expect(o.right).toBe(0);
  });

  it('wedge alternates starboard/port and steps astern by rank (asymmetric)', () => {
    const o = makeSlotOffset();
    formationSlotOffset('wedge', 1, 8, 50, o); // rank 1, starboard
    expect(o.right).toBe(50);
    expect(o.forward).toBe(-50);
    formationSlotOffset('wedge', 2, 8, 50, o); // rank 1, port
    expect(o.right).toBe(-50);
    expect(o.forward).toBe(-50);
    formationSlotOffset('wedge', 3, 8, 50, o); // rank 2, starboard
    expect(o.right).toBe(100);
    expect(o.forward).toBe(-100);
  });

  it('line spreads abreast (no fore/aft) symmetrically around the leader', () => {
    const o = makeSlotOffset();
    formationSlotOffset('line', 1, 8, 50, o);
    expect(o.forward).toBe(0);
    expect(o.right).toBe(50);
    formationSlotOffset('line', 2, 8, 50, o);
    expect(o.right).toBe(-50);
  });
});

describe('formation — world pose (rotate + translate, mirror-safe)', () => {
  it('at angle 0 the leader nose is +Y, starboard is +X', () => {
    // angle 0: forward axis (0, 1), right axis (1, 0).
    const out: WorldPoint = { x: 0, y: 0 };
    formationSlotWorldPose(100, 200, 0, { forward: 10, right: 5 }, out);
    expect(out.x).toBeCloseTo(105, 9); // +right → +X
    expect(out.y).toBeCloseTo(210, 9); // +forward → +Y
  });

  it('rotates the offset into the leader frame (asymmetric offset catches a flip)', () => {
    // angle +90° (π/2): forward axis (-1, 0), right axis (0, 1).
    // A purely-forward offset must land along -X; a purely-right offset along +Y.
    const out: WorldPoint = { x: 0, y: 0 };
    formationSlotWorldPose(0, 0, Math.PI / 2, { forward: 10, right: 0 }, out);
    expect(out.x).toBeCloseTo(-10, 9);
    expect(out.y).toBeCloseTo(0, 9);
    formationSlotWorldPose(0, 0, Math.PI / 2, { forward: 0, right: 7 }, out);
    expect(out.x).toBeCloseTo(0, 9);
    expect(out.y).toBeCloseTo(7, 9);
  });
});
