/**
 * RTS Part B slice 7: hold fire for player-owned ships (the AI pilot brain,
 * players side).
 *
 * Hold fire = no fire and no chase: the ship picks no target at all (not on
 * sight, not in retaliation), never pulls the trigger, never turns toward or
 * closes on an attacker, and carries on with its job (holds its post, flies
 * its search). Attackers still land on the retaliation ledger, so switching
 * back to Defensive answers one that hit recently.
 *
 * Driven through the kinematic model of `applyShipInput` (player controls).
 */
import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour } from './HostileDroneBehaviour.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import type { AiEntity, AiSwarmView, AiWorldView } from '../contracts/IAiBehaviour.js';
import { stepKinematic } from './pilotTestKit.js';

const KIND = getShipKind('fighter');
const OWNER = 'owner-1';
const R = shipTuning(KIND).guardRadiusMin;

type Mut<T> = { -readonly [K in keyof T]: T[K] };
type Body = Mut<AiEntity> & { angvel: number };

function owned(): HostileDroneBehaviour {
  return new HostileDroneBehaviour(KIND, { side: 'players', ownerId: OWNER });
}

function body(x: number, y: number, angle = 0): Body {
  return { id: 'own-1', x, y, vx: 0, vy: 0, angle, angvel: 0 };
}

function robot(id: string, x: number, y: number): Mut<AiSwarmView> {
  return { id, x, y, vx: 0, vy: 0, allegiance: 'robots' };
}

/** Smallest absolute angle between two headings. */
function angleBetween(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}

describe('HostileDroneBehaviour — hold fire (RTS Part B slice 7)', () => {
  it('shot repeatedly, a guarding ship neither fires nor turns toward / closes on the attacker, and keeps its post', () => {
    const b = owned();
    b.setGuardPost(0, 0, 0);
    b.setMoveTarget(0, 0);
    b.setEngageOnSight(false);
    b.setHoldFire(true);
    // The attacker sits off the beam (+x; nose is +y, so a turn toward it
    // would swing the nose 90°), inside the guard radius.
    const self = body(0, 0, 0);
    const ax = R * 0.5;
    const view: Mut<AiWorldView> = { players: [], swarms: [robot('r1', ax, 0)], tick: 0, dtSec: 1 / 60 };
    // Bearing to the attacker in the brain's frame (nose = (-sin a, cos a)).
    const bearing = Math.atan2(-ax, 0);
    const startGap = Math.abs(self.angle - bearing);
    let fired = false;
    let targeted = false;
    let maxDrift = 0;
    let minGap = Infinity;
    let minDist = Infinity;
    for (let t = 100; t < 100 + 60 * 10; t++) {
      view.tick = t;
      b.markHostile('r1', t); // the room re-stamps every hit
      const intent = b.tick(self, view);
      if (intent.fire) fired = true;
      if (b.getTargetId() !== null) targeted = true;
      stepKinematic(self, KIND, intent);
      maxDrift = Math.max(maxDrift, Math.hypot(self.x, self.y));
      minGap = Math.min(minGap, angleBetween(self.angle, Math.atan2(-(ax - self.x), -self.y)));
      minDist = Math.min(minDist, Math.hypot(ax - self.x, self.y));
    }
    expect(fired, 'hold fire pulled the trigger').toBe(false);
    expect(targeted, 'hold fire picked a target').toBe(false);
    expect(minGap, 'turned its nose toward the attacker').toBeGreaterThan(startGap * 0.75);
    expect(minDist, 'closed on the attacker').toBeGreaterThan(ax * 0.9);
    expect(maxDrift, 'left its post').toBeLessThan(R * 0.1);
  });

  it('a hold-fire hunter keeps searching and never engages a robot it sees', () => {
    const b = owned();
    b.setEngageOnSight(true); // Aggressive underneath: hold fire still wins
    b.setHunt(true);
    b.setHoldFire(true);
    const self = body(0, 0, 0);
    // A robot just off the first search leg (the leg runs along the nose, +y).
    const view: Mut<AiWorldView> = { players: [], swarms: [robot('r1', 300, 600)], tick: 0, dtSec: 1 / 60 };
    let fired = false;
    let targeted = false;
    for (let t = 100; t < 100 + 60 * 20; t++) {
      view.tick = t;
      const intent = b.tick(self, view);
      if (intent.fire) fired = true;
      if (b.getTargetId() !== null) targeted = true;
      stepKinematic(self, KIND, intent);
    }
    expect(fired).toBe(false);
    expect(targeted, 'engaged a robot under hold fire').toBe(false);
    expect(b.isHunting()).toBe(true);
    // Searching: flew on well past the robot (twice its distance out).
    expect(Math.hypot(self.x, self.y), 'stopped searching').toBeGreaterThan(2 * Math.hypot(300, 600));
  });

  it('switching to Defensive afterwards answers the attacker that hit it under hold fire', () => {
    const b = owned();
    b.setGuardPost(0, 0, 0);
    b.setMoveTarget(0, 0);
    b.setEngageOnSight(false);
    b.setHoldFire(true);
    const self = body(0, 0, 0);
    const view: Mut<AiWorldView> = { players: [], swarms: [robot('r1', 0, R * 0.5)], tick: 0, dtSec: 1 / 60 };
    let t = 100;
    for (; t < 160; t++) {
      view.tick = t;
      if (t === 120) b.markHostile('r1', t); // one hit, then the robot stops
      stepKinematic(self, KIND, b.tick(self, view));
    }
    expect(b.getTargetId()).toBeNull();
    // Defensive (the room's applyHullStance: hold fire off, on-sight off).
    b.setHoldFire(false);
    b.setEngageOnSight(false);
    for (const end = t + 30; t < end; t++) {
      view.tick = t;
      stepKinematic(self, KIND, b.tick(self, view));
    }
    expect(b.getTargetId(), 'Defensive did not answer the earlier attacker').toBe('r1');
  });

  it('an attack order is obeyed under hold fire: only the ordered target is chased and fired on; after the order it holds fire again', () => {
    const b = owned();
    b.setEngageOnSight(false);
    b.setHoldFire(true);
    const self = body(0, 0, 0);
    // A nearer attacker shooting the ship, and the ordered target further out.
    const view: Mut<AiWorldView> = {
      players: [], swarms: [robot('near', 300, 0), robot('ordered', 0, 1500)], tick: 100, dtSec: 1 / 60,
    };
    b.setOrderedTarget('ordered', 100);
    let fired = false;
    let other = false;
    let picked = false;
    const startDist = 1500;
    for (let t = 100; t < 100 + 60 * 8; t++) {
      view.tick = t;
      b.markHostile('near', t);
      const intent = b.tick(self, view);
      const id = b.getTargetId();
      if (id === 'ordered') picked = true;
      else if (id !== null) other = true;
      if (intent.fire) fired = true;
      stepKinematic(self, KIND, intent);
    }
    expect(picked, 'ignored the attack order').toBe(true);
    expect(other, 'picked a target of its own under hold fire').toBe(false);
    expect(fired, 'never fired on the ordered target').toBe(true);
    expect(Math.hypot(self.x, self.y - 1500), 'did not close on the ordered target').toBeLessThan(startDist);
    // Order over: back to hold fire (no target, no trigger) despite the attacker.
    b.setOrderedTarget(null, view.tick);
    let after = false;
    const endTick = view.tick + 120; // fixed bound: the loop advances view.tick
    for (let t = view.tick + 1; t < endTick; t++) {
      view.tick = t;
      b.markHostile('near', t);
      const intent = b.tick(self, view);
      if (intent.fire || b.getTargetId() !== null) after = true;
      stepKinematic(self, KIND, intent);
    }
    expect(after, 'kept fighting after the order ended').toBe(false);
  });
});
