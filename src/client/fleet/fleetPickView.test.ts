import { describe, it, expect } from 'vitest';
import { canFinishFleetPick, fleetPickHint, modeNeedsPick } from './fleetPickView.js';

describe('fleetPickView (slice 14b)', () => {
  it('only patrol / escort / retreat need a map pick', () => {
    expect(modeNeedsPick('patrol')).toBe(true);
    expect(modeNeedsPick('escort')).toBe(true);
    expect(modeNeedsPick('retreat')).toBe(true);
    expect(modeNeedsPick('defend')).toBe(false);
    expect(modeNeedsPick('hunt')).toBe(false);
  });

  it('Done needs a patrol with 2+ points', () => {
    expect(canFinishFleetPick(null)).toBe(false);
    expect(canFinishFleetPick({ kind: 'patrol', points: 1 })).toBe(false);
    expect(canFinishFleetPick({ kind: 'patrol', points: 2 })).toBe(true);
    expect(canFinishFleetPick({ kind: 'escort', points: 5 })).toBe(false);
  });

  it('hints are plain and follow the pointer kind', () => {
    expect(fleetPickHint('patrol', 0, false)).toBe('Click points for the patrol route, then Done');
    expect(fleetPickHint('patrol', 3, true)).toBe('3 points. Tap to add more, or press Done');
    expect(fleetPickHint('patrol', 16, false)).toMatch(/most points \(16\)/);
    expect(fleetPickHint('escort', 0, true)).toBe('Tap one of your other ships to escort');
    expect(fleetPickHint('retreat', 0, false)).toBe('Click where to retreat to');
  });
});
