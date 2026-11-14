/**
 * Fixed-gun trigger discipline (owner 2026-11-14: fire only when the shot will
 * hit; pilot skill, not a special power). An AI pilot with fixed guns pulls the
 * trigger only while its nose is inside the cone the target's hull covers,
 * atan((hit radius + bolt radius) / distance), never wider than the player's
 * window (`FC_MOUNT_FIRE_TOLERANCE`). Outside that cone it eases the nose on
 * with one-tick taps (`easedSnapTurn` with `aimCone`) instead of firing.
 */
import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour, hullFireCone } from './HostileDroneBehaviour.js';
import { FC_MOUNT_FIRE_TOLERANCE } from '../combat/fireControlBearing.js';
import { shipBubbleRadius } from '../combat/shipHitShape.js';
import { easedSnapTurn, makeSnapTurnState } from './virtualPilot.js';

const R = shipBubbleRadius('fighter');

function firesAt(bearing: number, dist: number, hitRadius: number | undefined): boolean {
  const brain = new HostileDroneBehaviour('fighter');
  brain.markHostile('p', 0);
  const p = { id: 'p', x: -Math.sin(bearing) * dist, y: Math.cos(bearing) * dist, vx: 0, vy: 0, hitRadius };
  const intent = brain.tick({ id: 'd', x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 }, { players: [p], tick: 100, dtSec: 1 / 60 });
  return intent.fire !== undefined;
}

describe('fixed-gun fire gate: the hull cone', () => {
  it('the cone is the angle the hull covers, capped at the player window', () => {
    expect(hullFireCone(44, 600)).toBeCloseTo(Math.atan(44 / 600), 6);
    expect(hullFireCone(44, 40)).toBe(FC_MOUNT_FIRE_TOLERANCE);
    expect(hullFireCone(Infinity, 600)).toBe(FC_MOUNT_FIRE_TOLERANCE);
    for (let d = 1; d < 2000; d += 37) expect(hullFireCone(R, d)).toBeLessThanOrEqual(FC_MOUNT_FIRE_TOLERANCE);
  });

  it('fires with the nose inside the hull cone at range', () => {
    const cone = Math.atan(R / 600);
    expect(cone).toBeLessThan(FC_MOUNT_FIRE_TOLERANCE);
    expect(firesAt(cone * 0.5, 600, R)).toBe(true);
  });

  it('holds fire outside the hull cone, even inside the 0.2 rad player window', () => {
    const cone = Math.atan((R + 3) / 600);
    const between = (cone + FC_MOUNT_FIRE_TOLERANCE) / 2;
    expect(between).toBeLessThan(FC_MOUNT_FIRE_TOLERANCE);
    expect(firesAt(between, 600, R)).toBe(false);
  });

  it('never fires wider than 0.2 rad, however close or big the target', () => {
    expect(firesAt(FC_MOUNT_FIRE_TOLERANCE * 0.9, 40, R)).toBe(true);
    expect(firesAt(FC_MOUNT_FIRE_TOLERANCE * 1.2, 40, R)).toBe(false);
    expect(firesAt(FC_MOUNT_FIRE_TOLERANCE * 1.2, 300, 10_000)).toBe(false);
  });

  it('eases onto the lead: a small error inside the dead-band gets a one-tick tap only when aiming', () => {
    const step = 0.07;
    const coarse = makeSnapTurnState();
    expect(easedSnapTurn(coarse, 0.1, step), 'no aim cone: left alone in the dead-band').toBe(0);
    const fine = makeSnapTurnState();
    fine.aimCone = 0.05;
    expect(easedSnapTurn(fine, 0.1, step)).toBe(1);
    // After the tap the nose is inside the cone: no more keys.
    expect(easedSnapTurn(fine, 0.03, step)).toBe(0);
    // Inside the cone from the start: no tap.
    const inside = makeSnapTurnState();
    inside.aimCone = 0.05;
    expect(easedSnapTurn(inside, 0.04, step)).toBe(0);
  });
});
