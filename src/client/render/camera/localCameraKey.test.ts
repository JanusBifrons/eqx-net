import { describe, it, expect } from 'vitest';
import { localCameraKey } from './localCameraKey.js';

// Review 2026-11-12 (capital-lineup / capital-breakup takes): a camera cue on
// 'local' did nothing once the pilot spectated. The parked hull is drawn from
// the lingering sprites, keyed by its ship-instance id, so the 'local' lookup
// (the player id) found no sprite and the shot fell back to a wide view.
describe('localCameraKey', () => {
  const lingering = new Map([
    ['hull-a', { ownerPlayerId: 'someone-else' }],
    ['hull-b', { ownerPlayerId: 'me' }],
  ]);

  it('piloting: the player id, when its sprite is drawn', () => {
    expect(localCameraKey('me', (k) => k === 'me', lingering)).toEqual({ key: 'me', parked: false });
  });

  it('spectating: falls back to the pilot\'s own parked hull', () => {
    expect(localCameraKey('me', () => false, lingering)).toEqual({ key: 'hull-b', parked: true });
  });

  it('no local player, or nothing drawn and nothing parked: null', () => {
    expect(localCameraKey(null, () => false, lingering)).toBeNull();
    expect(localCameraKey('me', () => false, new Map())).toBeNull();
    expect(localCameraKey('me', () => false, undefined)).toBeNull();
  });
});
