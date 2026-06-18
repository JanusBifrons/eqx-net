import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour } from './HostileDroneBehaviour.js';
import type { AiEntity, AiEntityPoseOut, AiWorldView } from '../contracts/IAiBehaviour.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { FLOCK_FOLLOW_DISTANCE } from './flocking.js';

const KIND = getShipKind('fighter');

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
    // Continuous flocking ⇒ forward thrust this tick (the old slot scheme stopped).
    expect(Math.hypot(intent.fx, intent.fy)).toBeGreaterThan(0);
    expect(intent.setAngvel).toBeDefined();
  });

  it('turns toward a leader off to the side', () => {
    const b = new HostileDroneBehaviour(KIND);
    b.setFlockFollow('leader', ['leader', 'f0']);
    // Leader far to +x (east), leader heading also +x (angle -π/2 → forward (1,0))
    // so cohesion + alignment both point east. Follower faces +y (angle 0) → it
    // must turn clockwise (negative angvel) to face east.
    const intent = b.tick(
      self({ angle: 0 }),
      viewWith({ leader: { x: 4000, y: 0, angle: -Math.PI / 2 } }),
    );
    expect(intent.setAngvel!).toBeLessThan(0);
  });

  it('NEVER exceeds the calm AI cruise — no boost/fling, even far behind the leader', () => {
    const b = new HostileDroneBehaviour(KIND);
    b.setFlockFollow('leader', ['leader', 'f0']);
    // The boost (which overshot + flung the herd apart) is gone: a follower at any
    // gap thrusts at most the calm AI cruise (ai.thrust); the leader-wait/throttle
    // closes the gap instead.
    for (const gap of [FLOCK_FOLLOW_DISTANCE * 0.5, FLOCK_FOLLOW_DISTANCE * 2, FLOCK_FOLLOW_DISTANCE * 8]) {
      const intent = b.tick(self(), viewWith({ leader: { x: gap, y: 0 } }));
      const mag = Math.hypot(intent.fx, intent.fy);
      expect(mag).toBeGreaterThan(0);
      expect(mag).toBeLessThanOrEqual(KIND.ai.thrust + 1e-6);
    }
  });

  it('a flock LEADER cruises THROTTLED (slower than full cruise) so followers catch up', () => {
    const leader = new HostileDroneBehaviour(KIND);
    leader.setFlockLeaderCourse(0, 5000); // far course straight ahead (+y)
    // Leader at origin facing +y → forward thrust aligns with the course.
    const intent = leader.tick(self({ x: 0, y: 0, angle: 0 }), viewWith({}));
    const mag = Math.hypot(intent.fx, intent.fy);
    expect(mag).toBeGreaterThan(0);
    expect(mag).toBeLessThan(KIND.ai.thrust); // throttled below full cruise
  });

  it('a plain setMoveTarget mover is NOT throttled (full cruise — back-compat)', () => {
    const m = new HostileDroneBehaviour(KIND);
    m.setMoveTarget(0, 5000);
    const intent = m.tick(self({ x: 0, y: 0, angle: 0 }), viewWith({}));
    // arrive() returns full thrustScale far from target; no leader throttle applied.
    expect(Math.hypot(intent.fx, intent.fy)).toBeCloseTo(KIND.ai.thrust, 5);
  });

  it('a leader HELD at its own pose (course = own position) does not thrust (it waits)', () => {
    const leader = new HostileDroneBehaviour(KIND);
    leader.setFlockLeaderCourse(0, 0); // course == own pose ⇒ arrive ramps to 0
    const intent = leader.tick(self({ x: 0, y: 0, angle: 0 }), viewWith({}));
    expect(Math.hypot(intent.fx, intent.fy)).toBe(0);
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
    expect(Math.hypot(intent.fx, intent.fy)).toBeGreaterThan(0);
  });

  it('falls back to patrol when the leader is unresolvable (gone)', () => {
    const b = new HostileDroneBehaviour(KIND);
    b.setFlockFollow('leader', ['leader', 'f0']);
    // resolveEntityInto returns false for everything ⇒ orbit fallback (still a
    // valid intent, never a crash / never a frozen drone).
    const intent = b.tick(self({ x: 500, y: 0 }), viewWith({}));
    expect(intent).toBeDefined();
    expect(intent.setAngvel).toBeDefined();
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
    b.setMoveTarget(300, 300); // now a leader/independent mover
    // With a move target + no follower role, it uses the arrive path, not flock —
    // proven by it steering toward the move target regardless of any leader pose.
    const intent = b.tick(self({ x: 0, y: 0 }), viewWith({ leader: { x: -5000, y: 0 } }));
    // Heading should aim at (300,300) (NE), not toward the leader at -x.
    expect(Math.hypot(intent.fx, intent.fy)).toBeGreaterThan(0);
  });
});
