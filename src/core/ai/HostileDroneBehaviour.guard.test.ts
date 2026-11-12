/**
 * Guarding capitals hold their post (owner decision 2026-11-11, verbatim):
 * "If it's DEFENDING an area, why would it back off to 'best gun distance'?
 * For what? Shooting the thing it's defending?! It should stay close to the
 * thing it's defending, obviously."
 *
 * Under real naval ranges (`EQX_NAVAL_RANGE=real`) the broadside stand-off is
 * ~29 km, so a capital spawned to guard a pocket steamed far away from it to
 * hold "best gun distance" (or chased a target beyond its reach). A capital
 * with a GUARD POST fights from its post: it never commands motion that takes
 * it beyond its guard radius. A capital with no post keeps the stand-off.
 *
 * The brain is driven through a simple integrator matching the worker's AI
 * path: the intent's (fx, fy) is an impulse per tick (dv = f / mass), the turn
 * is the commanded angvel, and the body sheds speed by its kind's
 * `linearDamping`.
 */
import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour, BROADSIDE_STANDOFF } from './HostileDroneBehaviour.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import type { AiEntity, AiWorldView } from '../contracts/IAiBehaviour.js';

const KIND = getShipKind('battleship');
const DT = 1 / 60;
const MASS = KIND.mass!;

type Mut<T> = { -readonly [K in keyof T]: T[K] };

interface Run { maxFromPost: number; finalFromPost: number; finalFromTarget: number }

function simulate(b: HostileDroneBehaviour, start: AiEntity, target: { x: number; y: number }, post: { x: number; y: number }, seconds: number): Run {
  const self: Mut<AiEntity> = { ...start };
  const view: Mut<AiWorldView> = { players: [{ id: 'p', x: target.x, y: target.y, vx: 0, vy: 0 }], tick: 200, dtSec: DT };
  let maxFromPost = 0;
  for (let i = 0; i < seconds * 60; i++) {
    view.tick = 200 + i;
    // A live fight keeps the capital hostile (the room re-stamps it on every
    // hit and lock step); without this it forgets the target after 30 s.
    b.markHostile('p', view.tick);
    const intent = b.tick(self, view);
    self.vx += intent.fx / MASS;
    self.vy += intent.fy / MASS;
    const damp = 1 / (1 + KIND.linearDamping * DT);
    self.vx *= damp;
    self.vy *= damp;
    if (intent.setAngvel !== undefined) self.angvel = intent.setAngvel;
    self.angle += self.angvel * DT;
    self.x += self.vx * DT;
    self.y += self.vy * DT;
    maxFromPost = Math.max(maxFromPost, Math.hypot(self.x - post.x, self.y - post.y));
  }
  return { maxFromPost, finalFromPost: Math.hypot(self.x - post.x, self.y - post.y), finalFromTarget: Math.hypot(self.x - target.x, self.y - target.y) };
}

function hostile(): HostileDroneBehaviour {
  const b = new HostileDroneBehaviour(KIND);
  b.markHostile('p', 100);
  return b;
}

describe('HostileDroneBehaviour — a guarding capital holds its post', () => {
  const reach = hostile().getFireRange();
  const post = { x: 0, y: 0 };
  const atPost = (angle = 0): AiEntity => ({ id: 'bs', x: 0, y: 0, vx: 0, vy: 0, angle, angvel: 0 });

  it('target beyond reach: an unguarded capital chases it; a guarding one never leaves its guard radius', () => {
    const target = { x: 0, y: reach * 3 }; // dead ahead, well out of reach
    const free = simulate(hostile(), atPost(), target, post, 90);
    const guard = hostile();
    guard.setGuardPost(post.x, post.y, 0);
    const radius = guard.getGuardRadius();
    expect(radius).toBeGreaterThanOrEqual(shipTuning(KIND).guardRadiusMin);
    // The control arm: without a post it closes on the target and leaves the area.
    expect(free.maxFromPost).toBeGreaterThan(radius);
    const held = simulate(guard, atPost(), target, post, 90);
    expect(held.maxFromPost, 'a guarding capital chased a target out of its area').toBeLessThanOrEqual(radius);
  });

  it('target in reach and close: an unguarded capital backs off to the stand-off; a guarding one holds station', () => {
    const target = { x: reach * 0.3, y: 0 }; // off the starboard beam, inside the stand-off
    const free = simulate(hostile(), atPost(), target, post, 120);
    // Control arm: it opens the range toward fireRange × BROADSIDE_STANDOFF.
    expect(free.finalFromTarget).toBeGreaterThan(reach * 0.3 + (reach * BROADSIDE_STANDOFF - reach * 0.3) * 0.3);
    const guard = hostile();
    guard.setGuardPost(post.x, post.y, 0);
    const held = simulate(guard, atPost(), target, post, 120);
    expect(held.maxFromPost, 'a guarding capital backed off from what it guards').toBeLessThan(free.maxFromPost * 0.25);
    expect(held.maxFromPost).toBeLessThanOrEqual(guard.getGuardRadius());
  });

  it('pushed outside its radius while fighting, it drives back toward the post', () => {
    const guard = hostile();
    guard.setGuardPost(post.x, post.y, 0);
    const radius = guard.getGuardRadius();
    // Beyond the radius, drifting further out, target in reach on the far side.
    const start: AiEntity = { id: 'bs', x: radius * 1.2, y: 0, vx: 20, vy: 0, angle: Math.PI / 2, angvel: 0 };
    const target = { x: radius * 1.2 + reach * 0.5, y: 0 };
    const run = simulate(guard, start, target, post, 240);
    expect(run.maxFromPost, 'it kept drifting away').toBeLessThan(radius * 1.2 + 2000);
    expect(run.finalFromPost, 'it never came back inside its guard radius').toBeLessThanOrEqual(radius);
  });

  it('clearGuardPost restores the stand-off behaviour', () => {
    const target = { x: 0, y: reach * 3 };
    const b = hostile();
    b.setGuardPost(0, 0, 0);
    b.clearGuardPost();
    const run = simulate(b, atPost(), target, post, 90);
    expect(run.maxFromPost).toBeGreaterThan(shipTuning(KIND).guardRadiusMin);
  });
});
