/**
 * Owner play-test (2026-11-21): a Shipyard still under construction read
 * "UNPOWERED" on a grid with +150 to spare. An unbuilt structure is not on the
 * grid yet (the server's `powerSummaryFor` reports unbuilt as unpowered), so
 * it is not drawing power: the line says BUILDING instead. Built and really
 * unpowered still says UNPOWERED.
 */
import { describe, it, expect } from 'vitest';
import { inspectorPowerLine } from './structureSettingsPower.js';

describe('inspectorPowerLine', () => {
  it('an UNBUILT consumer never reads UNPOWERED: it reads BUILDING', () => {
    expect(inspectorPowerLine(-180, false, false)).toBe('BUILDING');
    expect(inspectorPowerLine(-180, true, false)).toBe('BUILDING');
  });

  it('a BUILT consumer reads its draw when powered, UNPOWERED when not', () => {
    expect(inspectorPowerLine(-180, true, true)).toBe('PWR -180');
    expect(inspectorPowerLine(-180, false, true)).toBe('UNPOWERED');
  });

  it('a generator always shows its output, built or not', () => {
    expect(inspectorPowerLine(120, false, true)).toBe('PWR +120');
    expect(inspectorPowerLine(120, false, false)).toBe('PWR +120');
  });
});
