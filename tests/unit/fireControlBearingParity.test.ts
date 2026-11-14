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
import {
  barrelBearsOn, FC_MOUNT_FIRE_TOLERANCE, fillFireTargetShape, mountBearsOn, mountFireTolerance, mountFiresOn,
  mountReachesTarget, newFireTargetShape,
} from '../../src/core/combat/fireControlBearing.js';
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

  it('the server fire gate and the client fire passes both call the shared gate (range + bearing)', () => {
    const server = readFileSync('src/server/rooms/SectorRoom.ts', 'utf8');
    const client = readFileSync('src/client/net/ColyseusClient.ts', 'utf8');
    // `mountFiresOn` = per-mount range to the hull (`mountReachesTarget`) AND
    // the per-weapon bearing rule (`mountBearsOn`), on a shape both fill with
    // `fillFireTargetShape`.
    expect(server).toMatch(/mountFiresOn\(weaponId,/);
    expect(client).toMatch(/mountFiresOn\(/);
    expect(server).toMatch(/fillFireTargetShape\(/);
    expect(client).toMatch(/fillFireTargetShape\(/);
    // A bare mountBearsOn call would skip the range half on that side.
    expect(server).not.toMatch(/[^.\w]mountBearsOn\(/);
    expect(client).not.toMatch(/[^.\w]mountBearsOn\(/);
    // A bare barrelBearsOn call would skip the naval window on that side.
    expect(server).not.toMatch(/[^.\w]barrelBearsOn\(/);
    expect(client).not.toMatch(/[^.\w]barrelBearsOn\(/);
    expect(server).not.toMatch(/const FC_MOUNT_FIRE_TOLERANCE =/);
    expect(client).not.toMatch(/const FC_MOUNT_FIRE_TOLERANCE =/);
  });
});

/**
 * Fire range is per mount to the target's hit shape (owner, 2026-11-14).
 */
describe('mountReachesTarget / mountFiresOn', () => {
  it('a battleship alongside is in an AA mount\'s reach by its hull, not its centre', () => {
    const t = newFireTargetShape();
    fillFireTargetShape(t, 1_700, 0, 0, true, 'battleship', true, 0);
    // Starboard AA mount of a battleship at the origin facing +y (aa-s1).
    expect(Math.hypot(1_700 - 168, 0 - 920)).toBeGreaterThan(1_428); // centre: out
    expect(mountReachesTarget(168, 920, 1_428, t)).toBe(true); // hull: in
    expect(mountReachesTarget(-168, 920, 1_428, t)).toBe(false); // the port mount: out
  });

  it('a structure is reached by centre distance − its radius (its lock signature)', () => {
    const t = newFireTargetShape();
    fillFireTargetShape(t, 0, 500, 0, false, null, false, 100);
    expect(mountReachesTarget(0, 0, 401, t)).toBe(true);
    expect(mountReachesTarget(0, 0, 399, t)).toBe(false);
  });

  it('mountFiresOn needs both the range and the bearing', () => {
    const t = newFireTargetShape();
    fillFireTargetShape(t, 0, 500, 0, false, null, false, 100);
    expect(mountFiresOn('laser', 450, 0, 0, 0, t)).toBe(true);
    expect(mountFiresOn('laser', 350, 0, 0, 0, t)).toBe(false); // out of reach
    expect(mountFiresOn('laser', 450, 0, 0, Math.PI / 2, t)).toBe(false); // off bearing
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
