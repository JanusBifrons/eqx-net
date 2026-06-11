import { describe, it, expect } from 'vitest';
import { clampStored, chargeStep, dischargeStep, drainPower } from './batteryPower.js';

describe('batteryPower — pure stored-power math', () => {
  describe('clampStored', () => {
    it('clamps into [0, capacity] and maps negatives/NaN to 0', () => {
      expect(clampStored(50, 300)).toBe(50);
      expect(clampStored(-5, 300)).toBe(0);
      expect(clampStored(400, 300)).toBe(300);
      expect(clampStored(Number.NaN, 300)).toBe(0);
    });
  });

  describe('chargeStep', () => {
    it('absorbs surplus up to the remaining headroom', () => {
      expect(chargeStep(100, 300, 50)).toEqual({ stored: 150, absorbed: 50 });
    });
    it('caps at capacity and reports only what it took', () => {
      expect(chargeStep(280, 300, 50)).toEqual({ stored: 300, absorbed: 20 });
    });
    it('is a no-op when full or no surplus', () => {
      expect(chargeStep(300, 300, 40)).toEqual({ stored: 300, absorbed: 0 });
      expect(chargeStep(100, 300, 0)).toEqual({ stored: 100, absorbed: 0 });
      expect(chargeStep(100, 300, -10)).toEqual({ stored: 100, absorbed: 0 });
    });
  });

  describe('dischargeStep', () => {
    it('supplies up to its stored level to cover a deficit', () => {
      expect(dischargeStep(200, 60)).toEqual({ stored: 140, supplied: 60 });
    });
    it('supplies only what it has when the deficit exceeds storage', () => {
      expect(dischargeStep(40, 100)).toEqual({ stored: 0, supplied: 40 });
    });
    it('is a no-op when empty or no deficit', () => {
      expect(dischargeStep(0, 50)).toEqual({ stored: 0, supplied: 0 });
      expect(dischargeStep(120, 0)).toEqual({ stored: 120, supplied: 0 });
    });
  });

  describe('drainPower (shield-wall hit)', () => {
    it('drains up to its stored level and reports the amount', () => {
      expect(drainPower(200, 30)).toEqual({ stored: 170, drained: 30, emptied: false });
    });
    it('empties and flags it when the hit exceeds storage', () => {
      expect(drainPower(20, 100)).toEqual({ stored: 0, drained: 20, emptied: true });
    });
    it('reports emptied for an already-empty battery, draining nothing', () => {
      expect(drainPower(0, 50)).toEqual({ stored: 0, drained: 0, emptied: true });
    });
  });

  it('charge→discharge round-trips conservatively (never creates energy)', () => {
    let stored = 0;
    const cap = 300;
    // Charge from a +30/pulse surplus for 12 pulses → caps at 300.
    for (let i = 0; i < 12; i++) stored = chargeStep(stored, cap, 30).stored;
    expect(stored).toBe(300);
    // Discharge against a -60/pulse deficit until empty → exactly 5 pulses.
    let pulses = 0;
    while (stored > 0) {
      stored = dischargeStep(stored, 60).stored;
      pulses++;
    }
    expect(pulses).toBe(5);
    expect(stored).toBe(0);
  });
});
