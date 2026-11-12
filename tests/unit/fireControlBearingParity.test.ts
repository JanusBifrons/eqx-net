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
import { barrelBearsOn, FC_MOUNT_FIRE_TOLERANCE, mountBearsOn, mountFireTolerance } from '../../src/core/combat/fireControlBearing.js';
import { TURRET_FIRE_MISS, TURRET_FIRE_TOLERANCE } from '../../src/core/combat/mountFireControl.js';

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

  it('the server fire gate and the client ghost pass both call the per-weapon rule', () => {
    const server = readFileSync('src/server/rooms/SectorRoom.ts', 'utf8');
    const client = readFileSync('src/client/net/ColyseusClient.ts', 'utf8');
    expect(server).toMatch(/mountBearsOn\(weaponId,/);
    expect(client).toMatch(/mountBearsOn\(/);
    // A bare barrelBearsOn call would skip the naval window on that side.
    expect(server).not.toMatch(/[^.\w]barrelBearsOn\(/);
    expect(client).not.toMatch(/[^.\w]barrelBearsOn\(/);
    expect(server).not.toMatch(/const FC_MOUNT_FIRE_TOLERANCE =/);
    expect(client).not.toMatch(/const FC_MOUNT_FIRE_TOLERANCE =/);
  });
});

/**
 * Naval shell guns use the turret rule NPC capitals use (owner, 2026-11-12:
 * the player's 16" turrets fired while training and "missed by miles").
 */
describe('mountFireTolerance', () => {
  it('a naval gun must pass within TURRET_FIRE_MISS of the target; other guns keep the flat window', () => {
    expect(mountFireTolerance('naval_xl', 30_000)).toBeCloseTo(Math.atan2(TURRET_FIRE_MISS, 30_000), 9);
    expect(mountFireTolerance('naval_xl', 300)).toBe(TURRET_FIRE_TOLERANCE);
    expect(mountFireTolerance('laser', 30_000)).toBe(FC_MOUNT_FIRE_TOLERANCE);
    expect(mountFireTolerance('autocannon', 100)).toBe(FC_MOUNT_FIRE_TOLERANCE);
  });

  it('a 16" barrel 3° off a battleship 30 km out does not bear; dead on, it does', () => {
    const three = (3 * Math.PI) / 180;
    expect(mountBearsOn('naval_xl', 0, 0, three, 0, 30_000)).toBe(false);
    expect(mountBearsOn('naval_xl', 0, 0, 0, 0, 30_000)).toBe(true);
    // The old flat window would have accepted it.
    expect(barrelBearsOn(0, 0, three, 0, 30_000)).toBe(true);
  });
});
