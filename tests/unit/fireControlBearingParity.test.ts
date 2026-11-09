/**
 * Fire control's "does this barrel bear on its lock?" rule is one contract on
 * both sides of the wire (invariant #15). The server refuses a mount that
 * doesn't bear; the client must not draw a predicted bolt from it either, or a
 * capital group shows ghost bolts from turrets that never fired (fc handoff,
 * "Ghost bolts from off-target mounts"). This fails when either side stops
 * using the shared `barrelBearsOn`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { barrelBearsOn, FC_MOUNT_FIRE_TOLERANCE } from '../../src/core/combat/fireControlBearing.js';

describe('barrelBearsOn (#15)', () => {
  it('a barrel pointing at the target bears; one pointing away does not', () => {
    // Game space: angle 0 points +Y.
    expect(barrelBearsOn(0, 0, 0, 0, 100)).toBe(true);
    expect(barrelBearsOn(0, 0, Math.PI, 0, 100)).toBe(false);
    // Target to the +X side is at bearing -PI/2 (forward is (-sin a, cos a)).
    expect(barrelBearsOn(0, 0, -Math.PI / 2, 100, 0)).toBe(true);
  });

  it('honours the tolerance either side, across the ±PI wrap', () => {
    const t = FC_MOUNT_FIRE_TOLERANCE;
    expect(barrelBearsOn(0, 0, t * 0.9, 0, 100)).toBe(true);
    expect(barrelBearsOn(0, 0, t * 1.1, 0, 100)).toBe(false);
    // Target straight behind (bearing PI): a barrel at -PI + small still bears.
    expect(barrelBearsOn(0, 0, -Math.PI + t * 0.5, 0, -100)).toBe(true);
  });

  it('the server fire gate and the client ghost pass both call it', () => {
    const server = readFileSync('src/server/rooms/SectorRoom.ts', 'utf8');
    const client = readFileSync('src/client/net/ColyseusClient.ts', 'utf8');
    expect(server).toMatch(/barrelBearsOn\(/);
    expect(client).toMatch(/barrelBearsOn\(/);
    expect(server).not.toMatch(/const FC_MOUNT_FIRE_TOLERANCE =/);
    expect(client).not.toMatch(/const FC_MOUNT_FIRE_TOLERANCE =/);
  });
});
