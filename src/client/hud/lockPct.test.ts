/**
 * Frame review 2026-11-10 (pack-battle a005, 0.4 s): the banner read
 * "Gunship LOCKING ON YOU 100%" while the lock was still acquiring. The
 * server rounds progress to an integer (99.6 → 100) before the LOCKED stage
 * arrives, so every acquiring readout must floor and cap at 99.
 */
import { describe, it, expect } from 'vitest';
import { acquiringPct } from './lockPct';

describe('acquiringPct', () => {
  it('never shows 100 while still acquiring', () => {
    expect(acquiringPct(100)).toBe(99);
    expect(acquiringPct(99.6)).toBe(99);
  });
  it('floors fractional progress instead of rounding up', () => {
    expect(acquiringPct(62.9)).toBe(62);
    expect(acquiringPct(0.4)).toBe(0);
  });
  it('clamps junk to 0..99', () => {
    expect(acquiringPct(-5)).toBe(0);
    expect(acquiringPct(250)).toBe(99);
    expect(acquiringPct(Number.NaN)).toBe(0);
  });
});
