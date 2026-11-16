/**
 * RTS Part B slice 11: a patrol leg (`setPatrolLeg`) on the AI pilot brain,
 * players side. A travel that fights, leashed to the guard radius
 * (`shipTuning.guardRadiusMin`) round the nearest point of the leg:
 *  - Aggressive engages what it sees near its route, turning to fight it;
 *  - it ignores what is in sight but further off the route than the radius;
 *  - hold fire just flies the leg;
 *  - the panel reads Patrolling while it flies the leg.
 *
 * Driven through the kinematic model of `applyShipInput` (player controls).
 */
import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour, TRAVEL_ARRIVED } from './HostileDroneBehaviour.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import { ON_SIGHT_ENGAGE_RANGE } from '../../shared-types/allegiances.js';
import type { AiEntity, AiSwarmView, AiWorldView } from '../contracts/IAiBehaviour.js';
import { stepKinematic } from './pilotTestKit.js';

const KIND = getShipKind('fighter');
const R = shipTuning(KIND).guardRadiusMin;

type Mut<T> = { -readonly [K in keyof T]: T[K] };
type Body = Mut<AiEntity> & { angvel: number };

function owned(): HostileDroneBehaviour {
  const b = new HostileDroneBehaviour(KIND, { side: 'players', ownerId: 'owner-1' });
  b.setEngageOnSight(true); // Aggressive
  return b;
}

function body(x: number, y: number, angle = 0): Body {
  return { id: 'own-1', x, y, vx: 0, vy: 0, angle, angvel: 0 };
}

function robot(id: string, x: number, y: number): Mut<AiSwarmView> {
  return { id, x, y, vx: 0, vy: 0, allegiance: 'robots', kindId: 'robot-square' };
}

function run(b: HostileDroneBehaviour, self: Body, view: Mut<AiWorldView>, ticks: number) {
  const activities = new Set<string>();
  const targets = new Set<string>();
  for (let t = 100; t < 100 + ticks && b.getTravelState() !== TRAVEL_ARRIVED; t++) {
    view.tick = t;
    const intent = b.tick(self, view);
    activities.add(b.getActivity());
    const id = b.getTargetId();
    if (id !== null) targets.add(id);
    stepKinematic(self, KIND, intent);
  }
  return { activities, targets };
}

describe('HostileDroneBehaviour — patrol leg (RTS Part B slice 11)', () => {
  it('reads Patrolling and arrives on an empty leg', () => {
    const b = owned();
    const self = body(0, 0, 0);
    const view: Mut<AiWorldView> = { players: [], swarms: [], tick: 0, dtSec: 1 / 60 };
    b.setPatrolLeg(0, 0, 0, 2000);
    expect(b.isPatrolling()).toBe(true);
    expect(b.getActivity()).toBe('patrolling');
    const r = run(b, self, view, 60 * 30);
    expect(r.activities.has('moving'), 'never reads Moving (that is a Move order)').toBe(false);
    expect(b.getTravelState()).toBe(TRAVEL_ARRIVED);
    expect(b.isPatrolling()).toBe(false);
  });

  it('Aggressive: turns and fights a robot inside its guard radius of the route', () => {
    const b = owned();
    const self = body(0, 0, 0); // nose +y, leg runs +y
    // Off the beam, inside the radius of the leg and inside sight.
    const view: Mut<AiWorldView> = { players: [], swarms: [robot('r1', R * 0.6, 900)], tick: 0, dtSec: 1 / 60 };
    b.setPatrolLeg(0, 0, 0, 4000);
    const r = run(b, self, view, 60 * 6);
    expect(r.targets.has('r1'), 'it engaged the robot').toBe(true);
    expect(r.activities.has('attacking') || r.activities.has('chasing'), 'the panel shows the fight').toBe(true);
    expect(b.getTravelState(), 'the leg is still to fly').not.toBe(TRAVEL_ARRIVED);
  });

  it('leaves alone a robot in sight but further off the route than its guard radius', () => {
    const b = owned();
    const self = body(0, 0, 0);
    const off = Math.min(ON_SIGHT_ENGAGE_RANGE * 0.9, R * 1.6);
    expect(off).toBeGreaterThan(R);
    const view: Mut<AiWorldView> = { players: [], swarms: [robot('r1', off, 600)], tick: 0, dtSec: 1 / 60 };
    b.setPatrolLeg(0, 0, 0, 4000);
    const r = run(b, self, view, 60 * 4);
    expect(r.targets.size, 'no target picked').toBe(0);
    expect([...r.activities]).toEqual(['patrolling']);
  });

  it('hold fire just flies the leg', () => {
    const b = owned();
    b.setHoldFire(true);
    const self = body(0, 0, 0);
    const view: Mut<AiWorldView> = { players: [], swarms: [robot('r1', R * 0.3, 900)], tick: 0, dtSec: 1 / 60 };
    b.setPatrolLeg(0, 0, 0, 3000);
    const r = run(b, self, view, 60 * 30);
    expect(r.targets.size).toBe(0);
    expect(b.getTravelState(), 'arrived at the waypoint').toBe(TRAVEL_ARRIVED);
  });

  it('a plain Move (setTravel) is not a patrol', () => {
    const b = owned();
    b.setTravel(0, 3000);
    expect(b.isPatrolling()).toBe(false);
    expect(b.getActivity()).toBe('moving');
  });
});
