import { describe, it, expect } from 'vitest';
import type { RenderMirror, ShipRenderState } from '@core/contracts/IRenderer';
import { localCameraKey } from './localCameraKey.js';

// Review 2026-11-12 (capital-lineup / capital-breakup takes): a camera cue on
// 'local' did nothing once the pilot spectated. The parked hull is drawn
// keyed by its ship-instance id, so the 'local' lookup (the player id) found
// no sprite and the shot fell back to a wide view. Since RTS Part A S3 the
// parked hull is in the one ship list (`mirror.ships`).
const pose = (o: Partial<ShipRenderState> = {}): ShipRenderState => ({ x: 0, y: 0, vx: 0, vy: 0, angle: 0, ...o });

function mirror(localPlayerId: string | null, ships: Array<[string, ShipRenderState]>): RenderMirror {
  return { localPlayerId, ships: new Map(ships) } as unknown as RenderMirror;
}

describe('localCameraKey', () => {
  const ships: Array<[string, ShipRenderState]> = [
    ['other', pose({ ownerPlayerId: 'other', isActive: true })],
    ['hull-a', pose({ ownerPlayerId: 'someone-else', isActive: false })],
    ['hull-b', pose({ ownerPlayerId: 'me', isActive: false })],
  ];

  it('piloting: the player id, when its sprite is drawn', () => {
    expect(localCameraKey(mirror('me', ships), (k) => k === 'me')).toEqual({ key: 'me', parked: false });
  });

  it('spectating: falls back to the pilot\'s own parked hull, never another ship', () => {
    expect(localCameraKey(mirror('me', ships), () => false)).toEqual({ key: 'hull-b', parked: true });
  });

  it('no local player, or nothing drawn and nothing parked: null', () => {
    expect(localCameraKey(mirror(null, ships), () => false)).toBeNull();
    expect(localCameraKey(mirror('me', []), () => false)).toBeNull();
    expect(localCameraKey(null, () => false)).toBeNull();
  });
});
