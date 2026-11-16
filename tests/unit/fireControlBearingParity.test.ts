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
  newFireTargetShape,
} from '../../src/core/combat/fireControlBearing.js';
import { mountInReach } from '../../src/core/combat/mountReach.js';
import { shipHullDistance } from '../../src/core/combat/shipHitShape.js';
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
    // `mountFiresOn` = per-mount range to the hull (`mountInReach`) AND
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
describe('mountInReach on a FireTargetShape / mountFiresOn', () => {
  it('a battleship alongside is in an AA mount\'s reach by its hull, not its centre', () => {
    const t = newFireTargetShape();
    fillFireTargetShape(t, 1_700, 0, 0, true, 'battleship', true, 0);
    // Starboard AA mount of a battleship at the origin facing +y (aa-s1).
    expect(Math.hypot(1_700 - 168, 0 - 920)).toBeGreaterThan(1_428); // centre: out
    expect(mountInReach(t.x - 168, t.y - 920, 1_428, t)).toBe(true); // hull: in
    expect(mountInReach(t.x + 168, t.y - 920, 1_428, t)).toBe(false); // the port mount: out
  });

  it('a structure is reached by centre distance − its radius (its lock signature)', () => {
    const t = newFireTargetShape();
    fillFireTargetShape(t, 0, 500, 0, false, null, false, 100);
    expect(mountInReach(t.x, t.y, 401, t)).toBe(true);
    expect(mountInReach(t.x, t.y, 399, t)).toBe(false);
  });

  it('a ship with no kind is reached by the shape its hits use (the default kind\'s hull)', () => {
    const t = newFireTargetShape();
    fillFireTargetShape(t, 0, 0, 0.4, true, null, false, 0);
    // A mount 500 u from the default hull's nearest point along +x.
    let x = 1;
    while (shipHullDistance(null, false, x, 0, 0, 0, 0.4) < 500) x += 1;
    expect(mountInReach(t.x - x, t.y, 501, t)).toBe(true);
    expect(mountInReach(t.x - x, t.y, 497, t)).toBe(false);
  });

  it('the NPC turret / drone gate fills its range shape with the same shared fill', () => {
    // Two fills once disagreed for a ship with no kind (#15): the player gate
    // took the default kind's radius, the NPC gate the record's radius.
    const server = readFileSync('src/server/rooms/SectorRoom.ts', 'utf8');
    const method = (src: string, name: string): string => {
      const body = src.slice(src.indexOf(name));
      return body.slice(0, body.search(/\r?\n {2}\}\r?\n/));
    };
    expect(method(server, 'private writeSwarmRangeShape(')).toMatch(/fillRangeShape\(/);
    // Every pilot range shape too: no hand-written `kindId = …kind; … radius = 0` fills.
    expect(server).not.toMatch(/\.kindId = h\.ship\.kind;/);
    // The client's turret range shape (`fcTargetShape`) mirrors it.
    const client = readFileSync('src/client/net/ColyseusClient.ts', 'utf8');
    const fc = method(client, 'private fcTargetShape(');
    expect(fc).toMatch(/fillRangeShape\(/);
    expect(fc).not.toMatch(/\.kindId = /);
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
    expect(mountFireTolerance('railgun', 30_000)).toBeCloseTo(Math.atan2(TURRET_FIRE_MISS, 30_000), 9);
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

  it('a heavy-beam turret 2° off a target 5 km away does not bear; dead on, it does', () => {
    const two = (2 * Math.PI) / 180;
    expect(mountBearsOn('heavy_beam', 0, 0, two, 0, 5_000)).toBe(false);
    expect(mountBearsOn('heavy_beam', 0, 0, 0, 0, 5_000)).toBe(true);
    expect(mountFireTolerance('heavy_beam', 5_000)).toBeCloseTo(Math.atan2(TURRET_FIRE_MISS, 5_000), 9);
    // The mining laser is a capital turret beam too.
    expect(mountBearsOn('mining_laser', 0, 0, two, 0, 5_000)).toBe(false);
  });

  it("a fighter's fixed gun 5° off still bears (its 0.2 rad nose cone)", () => {
    const five = (5 * Math.PI) / 180;
    for (const id of ['hitscan', 'laser', 'autocannon']) {
      expect(mountBearsOn(id, 0, 0, five, 0, 5_000)).toBe(true);
      expect(mountFireTolerance(id, 5_000)).toBe(FC_MOUNT_FIRE_TOLERANCE);
    }
  });
});
