/**
 * RTS Part B slice 9: travel (an owner's Move / Retreat) on the AI pilot
 * brain, players side.
 *
 * Owner rule: Move = keep going and shoot on the way. The ship flies to the
 * point without entering combat manoeuvres: it fires at a target already in
 * its sights, never turns toward one, arrives and guards the point. A long
 * leg boosts (the virtual pilot's own gate), a short one does not. Stop
 * brakes along the course and guards the halt spot.
 *
 * Driven through the kinematic model of `applyShipInput` (player controls).
 */
import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour, TRAVEL_ARRIVED, TRAVEL_NONE, TRAVEL_ON_THE_WAY } from './HostileDroneBehaviour.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import type { AiEntity, AiSwarmView, AiWorldView } from '../contracts/IAiBehaviour.js';
import { stepKinematic } from './pilotTestKit.js';

const KIND = getShipKind('fighter');
const T = shipTuning(KIND);

type Mut<T> = { -readonly [K in keyof T]: T[K] };
type Body = Mut<AiEntity> & { angvel: number };

function owned(): HostileDroneBehaviour {
  const b = new HostileDroneBehaviour(KIND, { side: 'players', ownerId: 'owner-1' });
  b.setEngageOnSight(true); // Aggressive: it would fight what it sees
  return b;
}

function body(x: number, y: number, angle = 0): Body {
  return { id: 'own-1', x, y, vx: 0, vy: 0, angle, angvel: 0 };
}

function robot(id: string, x: number, y: number): Mut<AiSwarmView> {
  return { id, x, y, vx: 0, vy: 0, allegiance: 'robots', kindId: 'robot-square' };
}

/** Run until arrived (or `maxTicks`); returns what happened on the way. */
function fly(b: HostileDroneBehaviour, self: Body, view: Mut<AiWorldView>, tx: number, ty: number, maxTicks: number) {
  let fired = 0;
  let targeted = false;
  let worstCourse = 1;
  const activities = new Set<string>();
  let t = 100;
  for (; t < 100 + maxTicks && b.getTravelState() !== TRAVEL_ARRIVED; t++) {
    view.tick = t;
    const intent = b.tick(self, view);
    if (intent.fire) fired++;
    if (b.getTargetId() !== null) targeted = true;
    if (b.getTravelState() === TRAVEL_ON_THE_WAY) activities.add(b.getActivity());
    stepKinematic(self, KIND, intent);
    const dx = tx - self.x, dy = ty - self.y;
    const d = Math.hypot(dx, dy), sp = Math.hypot(self.vx, self.vy);
    if (d > 600 && sp > 50) worstCourse = Math.min(worstCourse, (self.vx * dx + self.vy * dy) / (sp * d));
  }
  return { fired, targeted, worstCourse, activities, ticks: t - 100 };
}

describe('HostileDroneBehaviour — travel (RTS Part B slice 9)', () => {
  it('flies past a robot on its route, firing at it while it is in the sights, and arrives', () => {
    const b = owned();
    const self = body(0, 0, 0); // nose +y
    const view: Mut<AiWorldView> = { players: [], swarms: [robot('r1', 0, 1500)], tick: 0, dtSec: 1 / 60 };
    b.setTravel(0, 3000);
    expect(b.getTravelState()).toBe(TRAVEL_ON_THE_WAY);
    const r = fly(b, self, view, 0, 3000, 60 * 30);
    expect(r.targeted, 'it saw the robot').toBe(true);
    expect(r.fired, 'it fired on the way').toBeGreaterThan(0);
    expect(r.worstCourse, 'it never turned back for the robot').toBeGreaterThan(0.9);
    expect(b.getTravelState(), 'arrived').toBe(TRAVEL_ARRIVED);
    expect(Math.hypot(self.x, self.y - 3000)).toBeLessThanOrEqual(T.wingmanArrive);
    expect(r.activities.has('moving'), 'the panel read Moving on the way').toBe(true);
    expect(r.activities.has('attacking') || r.activities.has('chasing'), 'never reported fighting while travelling').toBe(false);
    expect([b.getGuardPostX(), b.getGuardPostY()], 'guards the point').toEqual([0, 3000]);
  });

  it('never fires at nor turns toward a robot off its course', () => {
    const b = owned();
    const self = body(0, 0, 0);
    // Off the beam (+x), well inside sight; the course runs +y.
    const view: Mut<AiWorldView> = { players: [], swarms: [robot('r1', 450, 900)], tick: 0, dtSec: 1 / 60 };
    b.setTravel(0, 3000);
    let maxNose = 0;
    let fired = false;
    for (let t = 100; t < 100 + 60 * 4; t++) {
      view.tick = t;
      const intent = b.tick(self, view);
      if (intent.fire) fired = true;
      stepKinematic(self, KIND, intent);
      maxNose = Math.max(maxNose, Math.abs(self.angle));
    }
    expect(b.getTargetId(), 'it still tracks the robot (locks)').toBe('r1');
    expect(fired, 'no fire at a target outside the sights').toBe(false);
    expect(maxNose, 'the nose stays on the course').toBeLessThan(0.1);
  });

  it('a long leg boosts; a short leg does not', () => {
    const long = owned();
    const self = body(0, 0, 0);
    const view: Mut<AiWorldView> = { players: [], swarms: [], tick: 0, dtSec: 1 / 60 };
    long.setTravel(0, T.guardRadiusMin * 5);
    fly(long, self, view, 0, T.guardRadiusMin * 5, 60 * 40);
    expect(long.getBoostTicks()).toBeGreaterThan(0);
    expect(long.getTravelState()).toBe(TRAVEL_ARRIVED);

    const short = owned();
    const s2 = body(0, 0, 0);
    short.setTravel(0, T.guardRadiusMin * 2);
    fly(short, s2, view, 0, T.guardRadiusMin * 2, 60 * 40);
    expect(short.getBoostTicks()).toBe(0);
    expect(short.getTravelState()).toBe(TRAVEL_ARRIVED);
  });

  it('stopAt brakes along the course and guards the halt spot; a post or a hunt ends a travel', () => {
    const b = owned();
    const self = body(0, 0, 0);
    self.vy = 250;
    const view: Mut<AiWorldView> = { players: [], swarms: [], tick: 0, dtSec: 1 / 60 };
    b.setTravel(0, 5000);
    b.stopAt(self.x, self.y, self.vx, self.vy);
    expect(b.getTravelState()).toBe(TRAVEL_NONE);
    const py = b.getGuardPostY()!;
    expect(py, 'the post is ahead along the course').toBeGreaterThan(0);
    let maxNose = 0;
    for (let t = 100; t < 100 + 60 * 3; t++) {
      view.tick = t;
      stepKinematic(self, KIND, b.tick(self, view));
      maxNose = Math.max(maxNose, Math.abs(self.angle));
    }
    expect(maxNose, 'never turned around').toBeLessThan(0.1);
    expect(Math.hypot(self.vx, self.vy), 'stopped').toBeLessThan(KIND.maxSpeed * 0.01);
    expect(Math.abs(self.y - py), 'at the halt spot').toBeLessThanOrEqual(T.wingmanArrive);
    expect(b.getActivity()).toBe('guarding');

    b.setTravel(0, 5000);
    b.setHunt(true);
    expect(b.getTravelState()).toBe(TRAVEL_NONE);
    b.setTravel(0, 5000);
    b.setGuardPost(0, 0, 0);
    expect(b.getTravelState()).toBe(TRAVEL_NONE);
  });
});
