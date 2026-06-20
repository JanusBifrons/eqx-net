/**
 * Phase 4 WS-A1 — spectator-mode pure decisions.
 *
 * Spectator (D3/D4/D5) is a CLIENT-LOCAL, un-networked, invulnerable free-roam
 * construction camera. These pure helpers carry the two decisions the live
 * client wiring composes (so they're unit-lockable without a renderer/room):
 *
 *   1. `shouldEnterSpectatorOnDeath` — death of the LOCAL ship (and only the
 *      local ship) flips us into spectator instantly (no modal). A remote
 *      ship dying never changes the local pilot mode.
 *   2. `isSpectating` — the discrete mode read the camera/input/placement
 *      branches gate on.
 */
import { describe, it, expect } from 'vitest';
import { shouldEnterSpectatorOnDeath, isSpectating } from './spectatorMode.js';

describe('spectatorMode — death → spectator (WS-A1)', () => {
  it('enters spectator when the LOCAL ship is the destroyed entity', () => {
    expect(shouldEnterSpectatorOnDeath('player-1', 'player-1')).toBe(true);
  });

  it('does NOT enter spectator when a REMOTE ship dies', () => {
    expect(shouldEnterSpectatorOnDeath('player-2', 'player-1')).toBe(false);
  });

  it('does NOT enter spectator before the local id is known (null)', () => {
    expect(shouldEnterSpectatorOnDeath('player-1', null)).toBe(false);
  });
});

describe('spectatorMode — isSpectating (WS-A1)', () => {
  it('true only for the spectator mode', () => {
    expect(isSpectating('spectator')).toBe(true);
    expect(isSpectating('pilot')).toBe(false);
  });
});
