import { describe, expect, it, vi } from 'vitest';
import type { Room } from 'colyseus.js';
import { FLEET_WARP_HINT, fleetWarpRequest, sendWarpHere } from './fleetWarp';

describe('fleetWarp — "Warp here" per control mode (RTS fleet warp UI)', () => {
  const room = {} as Room;

  it('Fly mode: unchanged, no ship ids', () => {
    expect(fleetWarpRequest('pilot', ['a'])).toEqual({ allowed: true });
    const engage = vi.fn();
    expect(sendWarpHere(room, 'k', undefined, 'pilot', ['a'], engage)).toBe(true);
    expect(engage).toHaveBeenCalledWith(room, 'k', undefined, undefined, undefined);
  });

  it('Command view with ships selected: sends the selection ids', () => {
    const engage = vi.fn();
    expect(sendWarpHere(room, 'k', { x: 1, y: 2 }, 'spectator', ['a', 'b'], engage)).toBe(true);
    expect(engage).toHaveBeenCalledWith(room, 'k', { x: 1, y: 2 }, undefined, ['a', 'b']);
  });

  it('Command view with nothing selected: blocked with the hint, nothing sent', () => {
    expect(fleetWarpRequest('spectator', [])).toEqual({ allowed: false, hint: FLEET_WARP_HINT });
    const engage = vi.fn();
    expect(sendWarpHere(room, 'k', undefined, 'spectator', [], engage)).toBe(false);
    expect(engage).not.toHaveBeenCalled();
    expect(FLEET_WARP_HINT).toBe('Select ships to warp');
  });
});
