/**
 * The guard leash for every ship (RTS Part B slice 5). Stop / Defend = the
 * ship guards a spot: it picks targets by their distance from its POST, only
 * inside its guard radius, drops one that leaves the radius, and with nothing
 * to fight flies back to the post. Broadside capitals keep their own guard
 * flying (`HostileDroneBehaviour.guard.test.ts`); a ship with no post is
 * unchanged.
 *
 * Driven through the kinematic model of `applyShipInput` (player controls).
 */
import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour } from './HostileDroneBehaviour.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import type { AiEntity, AiWorldView } from '../contracts/IAiBehaviour.js';
import { stepKinematic } from './pilotTestKit.js';

const KIND = getShipKind('fighter');
const DT = 1 / 60;

type Mut<T> = { -readonly [K in keyof T]: T[K] };
type Body = Mut<AiEntity> & { angvel: number };

interface Sim { self: Body; view: Mut<AiWorldView>; tick: number }

function start(b: HostileDroneBehaviour, target: { x: number; y: number }, at = { x: 0, y: 0 }): Sim {
  b.markHostile('p', 100);
  return {
    self: { id: 'f', x: at.x, y: at.y, vx: 0, vy: 0, angle: 0, angvel: 0 },
    view: { players: [{ id: 'p', x: target.x, y: target.y, vx: 0, vy: 0 }], tick: 200, dtSec: DT },
    tick: 200,
  };
}

/** Run `seconds`; the fight stays live (the room re-stamps hostility on every
 *  hit). Returns the furthest the ship got from (0, 0) and whether it ever
 *  held 'p' as its target. */
function run(b: HostileDroneBehaviour, s: Sim, seconds: number): { maxFromPost: number; everTargeted: boolean } {
  let maxFromPost = 0;
  let everTargeted = false;
  for (let i = 0; i < seconds * 60; i++) {
    s.view.tick = ++s.tick;
    b.markHostile('p', s.tick);
    stepKinematic(s.self, KIND, b.tick(s.self, s.view));
    if (b.getTargetId() === 'p') everTargeted = true;
    maxFromPost = Math.max(maxFromPost, Math.hypot(s.self.x, s.self.y));
  }
  return { maxFromPost, everTargeted };
}

function guarding(): HostileDroneBehaviour {
  const b = new HostileDroneBehaviour(KIND);
  b.setGuardPost(0, 0, 0);
  return b;
}

describe('HostileDroneBehaviour — the guard leash (every ship)', () => {
  const R = shipTuning(KIND).guardRadiusMin;

  it('the guard radius of a fighter is its guardRadiusMin', () => {
    expect(guarding().getGuardRadius()).toBe(R);
  });

  it('ignores a hostile at 2x its guard radius and stays at its post (control: unguarded chases)', () => {
    const target = { x: 0, y: 2 * R };
    const free = new HostileDroneBehaviour(KIND);
    const freeRun = run(free, start(free, target), 10);
    expect(freeRun.everTargeted).toBe(true);
    expect(freeRun.maxFromPost).toBeGreaterThan(R);

    const g = guarding();
    const held = run(g, start(g, target), 10);
    expect(held.everTargeted, 'a guarding fighter picked a target outside its radius').toBe(false);
    expect(held.maxFromPost, 'a guarding fighter left its post').toBeLessThan(R * 0.25);
  });

  it('engages a hostile inside its guard radius', () => {
    const g = guarding();
    const s = start(g, { x: 0, y: R * 0.5 });
    const r = run(g, s, 3);
    expect(r.everTargeted).toBe(true);
    expect(g.getTargetId()).toBe('p');
  });

  it('drops a target that leaves the radius and flies back to its post', () => {
    const g = guarding();
    const s = start(g, { x: 0, y: R * 0.5 });
    run(g, s, 3);
    expect(g.getTargetId()).toBe('p');
    // The target runs out to 2x the radius: the leash lets it go.
    s.view.players = [{ id: 'p', x: 0, y: 2 * R, vx: 0, vy: 0 }];
    run(g, s, 20);
    expect(g.getTargetId(), 'still held a target outside its guard radius').toBeNull();
    expect(Math.hypot(s.self.x, s.self.y), 'did not return to its post').toBeLessThan(R * 0.25);
  });

  it('clearGuardPost lifts the leash', () => {
    const g = guarding();
    g.clearGuardPost();
    const r = run(g, start(g, { x: 0, y: 2 * R }), 5);
    expect(r.everTargeted).toBe(true);
  });
});
