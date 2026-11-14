import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour } from './HostileDroneBehaviour.js';
import type { AiEntity, AiEntityPoseOut, AiWorldView } from '../contracts/IAiBehaviour.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { FLOCK_FOLLOW_DISTANCE } from './flocking.js';
import { boostOf, stepKinematic, throttleOf, turnOf } from './pilotTestKit.js';
import { makePilotHandling } from './virtualPilot.js';
import { shipBodyMass } from '../../shared-types/shipScale/tuning.js';

const KIND = getShipKind('fighter');
/** The fighter's thrust cruise speed as an NPC body (virtual pilot handling). */
const CRUISE = makePilotHandling(KIND, shipBodyMass(KIND)).cruiseSpeed;
/** Non-combat travel flies at this share of cruise (CALM_CRUISE_FRAC). */
const CALM = CRUISE * 0.45;

/** Fly `b` for `ticks` from rest at the origin facing +y with a kinematic
 *  model of the player controls; returns the top and final speeds and
 *  whether boost was ever pressed. */
function flyFor(b: HostileDroneBehaviour, view: AiWorldView, ticks: number): { top: number; end: number; boosted: boolean } {
  const body = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
  let top = 0;
  let boosted = false;
  for (let i = 0; i < ticks; i++) {
    const intent = b.tick({ id: 'f0', ...body }, view);
    if (boostOf(intent)) boosted = true;
    stepKinematic(body, KIND, intent);
    top = Math.max(top, Math.hypot(body.vx, body.vy));
  }
  return { top, end: Math.hypot(body.vx, body.vy), boosted };
}

function self(over: Partial<AiEntity> = {}): AiEntity {
  return { id: 'f0', x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, ...over };
}

/** Build a view whose `resolveEntityInto` serves the given fixed poses by id. */
function viewWith(poses: Record<string, { x: number; y: number; angle?: number }>): AiWorldView {
  return {
    players: [],
    tick: 100,
    dtSec: 1 / 60,
    resolveEntityInto: (id: string, out: AiEntityPoseOut): boolean => {
      const p = poses[id];
      if (!p) return false;
      out.x = p.x;
      out.y = p.y;
      out.vx = 0;
      out.vy = 0;
      out.angle = p.angle ?? 0;
      out.angvel = 0;
      return true;
    },
  };
}

describe('HostileDroneBehaviour — leader-led flocking (non-combat herding)', () => {
  it('a follower accelerates toward a distant leader (does NOT sit still)', () => {
    const b = new HostileDroneBehaviour(KIND);
    b.setFlockFollow('leader', ['leader', 'f0']);
    const intent = b.tick(self(), viewWith({ leader: { x: FLOCK_FOLLOW_DISTANCE * 4, y: 0 } }));
    // Continuous flocking ⇒ it flies (keys held; the old slot scheme stopped).
    expect(intent.input ?? 0).not.toBe(0);
    expect(intent.fx).toBe(0);
    expect(intent.setAngvel).toBeUndefined();
  });

  it('turns toward a leader off to the side', () => {
    const b = new HostileDroneBehaviour(KIND);
    b.setFlockFollow('leader', ['leader', 'f0']);
    // Leader far to +x (east), leader heading also +x (angle -π/2 → forward (1,0))
    // so cohesion + alignment both point east. Follower faces +y (angle 0) → it
    // must turn clockwise (turn RIGHT) to face east.
    const intent = b.tick(
      self({ angle: 0 }),
      viewWith({ leader: { x: 4000, y: 0, angle: -Math.PI / 2 } }),
    );
    expect(turnOf(intent)).toBe(-1);
  });

  it('NEVER exceeds the calm AI cruise — no boost/fling, even far behind the leader', () => {
    // The boost (which overshot + flung the herd apart) is gone: a follower at any
    // gap cruises at most the calm cruise; the leader-wait/throttle closes the gap.
    for (const gap of [FLOCK_FOLLOW_DISTANCE * 2, FLOCK_FOLLOW_DISTANCE * 8]) {
      const b = new HostileDroneBehaviour(KIND);
      b.setFlockFollow('leader', ['leader', 'f0']);
      const r = flyFor(b, viewWith({ leader: { x: 0, y: gap } }), 240);
      expect(r.boosted).toBe(false);
      expect(r.top).toBeGreaterThan(0);
      // Bang-bang throttle may overshoot the wanted speed by about one tick of thrust.
      expect(r.top).toBeLessThanOrEqual(CALM + KIND.thrustImpulse / shipBodyMass(KIND) + 1e-6);
    }
  });

  it('a flock LEADER cruises THROTTLED (slower than full cruise) so followers catch up', () => {
    const leader = new HostileDroneBehaviour(KIND);
    leader.setFlockLeaderCourse(0, 50_000); // far course straight ahead (+y)
    const mover = new HostileDroneBehaviour(KIND);
    mover.setMoveTarget(0, 50_000);
    const l = flyFor(leader, viewWith({}), 600);
    const m = flyFor(mover, viewWith({}), 600);
    expect(l.end).toBeGreaterThan(0);
    expect(l.end).toBeLessThan(m.end * 0.7); // LEADER_CRUISE_THROTTLE 0.55
  });

  it('a plain setMoveTarget mover is NOT throttled (calm cruise — back-compat)', () => {
    const m = new HostileDroneBehaviour(KIND);
    m.setMoveTarget(0, 50_000);
    const r = flyFor(m, viewWith({}), 600);
    expect(r.boosted).toBe(false);
    expect(r.end).toBeGreaterThan(CALM * 0.9);
    expect(r.end).toBeLessThan(CALM * 1.1);
  });

  it('a leader HELD at its own pose (course = own position) does not thrust (it waits)', () => {
    const leader = new HostileDroneBehaviour(KIND);
    leader.setFlockLeaderCourse(0, 0); // course == own pose ⇒ arrive ramps to 0
    const intent = leader.tick(self({ x: 0, y: 0, angle: 0 }), viewWith({}));
    expect(intent.input).toBe(0);
  });

  it('keeps cruising (cohesion + alignment) at the follow distance — no stop', () => {
    const b = new HostileDroneBehaviour(KIND);
    b.setFlockFollow('leader', ['leader', 'f0']);
    // Follower at the follow-distance behind the leader: cohesion is still at full
    // gain here (the arrival ramp only fades it BELOW this distance), and alignment
    // adds the leader's heading — together a clear forward thrust, never a stop.
    const intent = b.tick(
      self({ x: 0, y: 0 }),
      viewWith({ leader: { x: 0, y: FLOCK_FOLLOW_DISTANCE, angle: 0 } }),
    );
    expect(throttleOf(intent)).toBe(1);
  });

  it('falls back to patrol when the leader is unresolvable (gone)', () => {
    const b = new HostileDroneBehaviour(KIND);
    b.setFlockFollow('leader', ['leader', 'f0']);
    // resolveEntityInto returns false for everything ⇒ orbit fallback (still a
    // valid intent, never a crash / never a frozen drone).
    const intent = b.tick(self({ x: 500, y: 0 }), viewWith({}));
    expect(intent).toBeDefined();
    expect(intent.input ?? 0).not.toBe(0);
  });

  it('falls back to patrol when the view has no resolver', () => {
    const b = new HostileDroneBehaviour(KIND);
    b.setFlockFollow('leader', ['leader', 'f0']);
    const intent = b.tick(self({ x: 500, y: 0 }), { players: [], tick: 1, dtSec: 1 / 60 });
    expect(intent).toBeDefined();
  });

  it('setMoveTarget clears the follower role (promoted leader stops flocking)', () => {
    const b = new HostileDroneBehaviour(KIND);
    b.setFlockFollow('leader', ['leader', 'f0']);
    b.setMoveTarget(3000, 3000); // now a leader/independent mover
    // With a move target + no follower role, it uses the arrive path, not flock —
    // proven by it steering toward the move target regardless of any leader pose.
    const intent = b.tick(self({ x: 0, y: 0 }), viewWith({ leader: { x: -5000, y: 0 } }));
    // Heading should aim at (3000,3000) (NE, clockwise of +y ⇒ turn right), not
    // toward the leader at -x (which would be a left turn).
    expect(turnOf(intent)).toBe(-1);
  });
});
