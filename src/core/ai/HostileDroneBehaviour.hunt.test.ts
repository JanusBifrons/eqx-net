/**
 * RTS Part B slice 6: Hunt mode and the Aggressive / Defensive attitudes for
 * player-owned ships (the AI pilot brain, players side).
 *
 * Owner (2026-11-15): "Hunt would mean it seeks and destroys within sector.
 * Aggressive would mean it holds place and waits and engages anyone it sees."
 *   - Hunt: no leash; with nothing in sight the ship searches the sector (an
 *     expanding square round where it began, never the old origin orbit) and
 *     engages what it finds.
 *   - Aggressive (`setEngageOnSight(true)`, the default): engages anything
 *     hostile it sees, inside its leash when it guards a post.
 *   - Defensive (`setEngageOnSight(false)`): only hits back.
 *   - A guarding ship shot from outside its radius answers out to the radius
 *     plus its weapon reach, then goes back to its post.
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

function drone(id: string, x: number, y: number): Mut<AiSwarmView> {
  return { id, x, y, vx: 0, vy: 0, allegiance: 'drones' };
}

/** Fly `ticks` ticks from `tick0`; `each` runs before every tick. Returns the
 *  tick after the last. */
function fly(
  b: HostileDroneBehaviour, self: Body, view: Mut<AiWorldView>, tick0: number, ticks: number,
  each?: (tick: number) => boolean | void,
): number {
  let t = tick0;
  for (let i = 0; i < ticks; i++, t++) {
    view.tick = t;
    if (each?.(t) === true) return t;
    stepKinematic(self, KIND, b.tick(self, view));
  }
  return t;
}

describe('HostileDroneBehaviour — Hunt (RTS Part B slice 6)', () => {
  const S = owned().getSensorRange();

  it('with nothing in sight it searches away from its start, never orbiting the origin', () => {
    // Start well off the origin, nose pointing AWAY from it (+y), alone.
    const b = owned();
    b.setHunt(true);
    const self = body(8000, 0, 0);
    const view: Mut<AiWorldView> = { players: [], tick: 0, dtSec: 1 / 60 };
    let minFromOrigin = Infinity;
    let maxFromStart = 0;
    fly(b, self, view, 100, 60 * 90, () => {
      minFromOrigin = Math.min(minFromOrigin, Math.hypot(self.x, self.y));
      maxFromStart = Math.max(maxFromStart, Math.hypot(self.x - 8000, self.y));
    });
    // The old idle (no post) orbits the origin at 1800 u; a hunter searches
    // round where it began instead.
    expect(minFromOrigin, 'drifted toward the world origin').toBeGreaterThan(8000 - 2 * HUNT_SPACING(S));
    expect(maxFromStart, 'never went looking').toBeGreaterThan(1.5 * S);
    // Control: the same ship without Hunt (no post) heads for the origin orbit.
    const idle = owned();
    const s2 = body(8000, 0, 0);
    const v2: Mut<AiWorldView> = { players: [], tick: 0, dtSec: 1 / 60 };
    fly(idle, s2, v2, 100, 60 * 90);
    expect(Math.hypot(s2.x, s2.y)).toBeLessThan(8000 - 1000);
  });

  it('finds and engages an on-sight enemy that starts out of its sensor range', () => {
    const b = owned();
    b.setHunt(true);
    const self = body(5000, 5000, 0);
    // To its left (the expanding square turns left), 2.2 sensor ranges off.
    const foe = robot('r1', 5000 - 2.2 * S, 5000);
    const view: Mut<AiWorldView> = { players: [], swarms: [foe], tick: 0, dtSec: 1 / 60 };
    // Out of sight at the start: nothing picked.
    view.tick = 100;
    b.tick(self, view);
    expect(b.getTargetId()).toBeNull();
    let found = -1;
    fly(b, self, view, 101, 60 * 120, (t) => {
      if (b.getTargetId() === 'r1') { found = t; return true; }
    });
    expect(found, 'the hunter never found the robot').toBeGreaterThan(0);
    // It closes on it.
    const before = Math.hypot(foe.x - self.x, foe.y - self.y);
    fly(b, self, view, found, 60 * 5);
    expect(b.getTargetId()).toBe('r1');
    expect(Math.hypot(foe.x - self.x, foe.y - self.y)).toBeLessThan(before);
  });

  it('lifts the guard leash: a hunter engages an on-sight enemy far outside its old guard radius', () => {
    const R = shipTuning(KIND).guardRadiusMin;
    const b = owned();
    b.setGuardPost(0, 0, 0);
    const self = body(0, 0, 0);
    const view: Mut<AiWorldView> = { players: [], swarms: [robot('r1', 0, R + 0.5 * (S - R))], tick: 0, dtSec: 1 / 60 };
    fly(b, self, view, 100, 30);
    expect(b.getTargetId(), 'leashed: out of its radius').toBeNull();
    b.setHunt(true);
    expect(b.getGuardRadius()).toBe(0);
    fly(b, self, view, 130, 30);
    expect(b.getTargetId()).toBe('r1');
  });

  it('a guard post (a hold) ends the hunt', () => {
    const b = owned();
    b.setHunt(true);
    b.setGuardPost(0, 0, 0);
    expect(b.isHunting()).toBe(false);
  });
});

describe('HostileDroneBehaviour — Aggressive / Defensive attitude (RTS Part B slice 6)', () => {
  const R = shipTuning(KIND).guardRadiusMin;

  function guarding(engageOnSight: boolean): HostileDroneBehaviour {
    const b = owned();
    b.setGuardPost(0, 0, 0);
    b.setEngageOnSight(engageOnSight);
    return b;
  }

  it('Aggressive, guarding: engages an on-sight robot inside its radius', () => {
    const b = guarding(true);
    const self = body(0, 0);
    const view: Mut<AiWorldView> = { players: [], swarms: [robot('r1', 0, R * 0.5)], tick: 0, dtSec: 1 / 60 };
    fly(b, self, view, 100, 30);
    expect(b.getTargetId()).toBe('r1');
  });

  it("Aggressive: engages a drone hostile to its OWNER (the owner's hostile list)", () => {
    const b = owned();
    const self = body(0, 0);
    const d = drone('d1', 0, 400);
    const view: Mut<AiWorldView> = { players: [], swarms: [d], tick: 0, dtSec: 1 / 60 };
    fly(b, self, view, 100, 10);
    expect(b.getTargetId(), 'a neutral drone is no enemy').toBeNull();
    view.hostileToPlayer = (id, pid) => id === 'd1' && pid === OWNER;
    fly(b, self, view, 110, 10);
    expect(b.getTargetId()).toBe('d1');
  });

  it('Defensive, guarding: ignores the on-sight robot until it is shot, then answers', () => {
    const b = guarding(false);
    const self = body(0, 0);
    const view: Mut<AiWorldView> = { players: [], swarms: [robot('r1', 0, R * 0.5)], tick: 0, dtSec: 1 / 60 };
    const t = fly(b, self, view, 100, 120);
    expect(b.getTargetId(), 'Defensive started a fight').toBeNull();
    b.markHostile('r1', t);
    fly(b, self, view, t, 30);
    expect(b.getTargetId()).toBe('r1');
  });

  it('Defensive: a hunter ignores on-sight enemies too (it only hits back)', () => {
    const b = owned();
    b.setEngageOnSight(false);
    b.setHunt(true);
    const self = body(0, 0);
    const view: Mut<AiWorldView> = { players: [], swarms: [robot('r1', 0, 400)], tick: 0, dtSec: 1 / 60 };
    fly(b, self, view, 100, 60);
    expect(b.getTargetId()).toBeNull();
  });

  it('shot from outside its radius (within weapon reach of the edge), a guarding ship answers, then returns to its post', () => {
    const b = guarding(false);
    const self = body(0, 0);
    // The brain's weapon reach.
    const reach = b.getFireRange();
    expect(reach).toBeGreaterThan(0);
    const shooter = robot('r1', 0, R + 0.6 * reach);
    const view: Mut<AiWorldView> = { players: [], swarms: [shooter], tick: 0, dtSec: 1 / 60 };
    let t = fly(b, self, view, 100, 30);
    expect(b.getTargetId()).toBeNull();
    // The robot shoots: it is now on the ledger (the room re-stamps every hit).
    b.markHostile('r1', t);
    let answered = false;
    t = fly(b, self, view, t, 60 * 3, (tk) => {
      b.markHostile('r1', tk);
      if (b.getTargetId() === 'r1') answered = true;
    });
    expect(answered, 'ignored an attacker shooting from just outside its radius').toBe(true);
    // Out past radius + reach: let go and back to the post.
    shooter.y = R + 3 * reach;
    t = fly(b, self, view, t, 60 * 25, (tk) => { b.markHostile('r1', tk); });
    expect(b.getTargetId()).toBeNull();
    expect(Math.hypot(self.x, self.y), 'did not return to its post').toBeLessThan(R * 0.25);
  });

  it('drones keep on-sight engagement by default (unchanged)', () => {
    const b = new HostileDroneBehaviour(getShipKind('fighter'));
    const self = body(0, 0);
    const view: Mut<AiWorldView> = { players: [], swarms: [robot('r1', 0, 400)], tick: 100, dtSec: 1 / 60 };
    b.tick(self, view);
    expect(b.getTargetId()).toBe('r1');
  });
});

/** The search leg spacing (1.5 sensor ranges, `HUNT_LEG_SPACING_MUL`). */
function HUNT_SPACING(sensor: number): number { return 1.5 * sensor; }
