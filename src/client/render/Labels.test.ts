import { describe, it, expect } from 'vitest';
import { formatDroneName, formatPlayerLabel } from './Labels.js';

describe('formatDroneName', () => {
  it('zero-pads small ids to 3 hex chars', () => {
    expect(formatDroneName(1)).toBe('AI 001');
    expect(formatDroneName(15)).toBe('AI 00F');
    expect(formatDroneName(255)).toBe('AI 0FF');
  });

  it('uppercases hex digits', () => {
    expect(formatDroneName(2639)).toBe('AI A4F'); // 0xA4F
    expect(formatDroneName(0xfff)).toBe('AI FFF');
  });

  it('does not truncate ids that exceed 3 hex chars', () => {
    expect(formatDroneName(0x1000)).toBe('AI 1000');
    expect(formatDroneName(0xffff)).toBe('AI FFFF');
  });

  it('is deterministic — same id always returns the same string', () => {
    const a = formatDroneName(42);
    const b = formatDroneName(42);
    expect(a).toBe(b);
  });
});

describe('formatPlayerLabel', () => {
  it('uses the displayName when set', () => {
    expect(formatPlayerLabel('player-abc', 'Alice')).toBe('Alice');
  });

  it('trims whitespace from the displayName', () => {
    expect(formatPlayerLabel('player-abc', '  Alice  ')).toBe('Alice');
  });

  it('falls back to a plain "Pilot" label — NEVER any part of the playerId', () => {
    // No ids in the UI: the fallback must not leak even a slice of the id.
    expect(formatPlayerLabel('abcd-efghij')).toBe('Pilot');
    expect(formatPlayerLabel('abcd-efghij', '')).toBe('Pilot');
    expect(formatPlayerLabel('abcd-efghij', '   ')).toBe('Pilot');
    expect(formatPlayerLabel('xyzw-rest')).toBe('Pilot');
  });
});
