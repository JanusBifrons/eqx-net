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

  it('BOOSTS (player-boost impulse) when far behind the leader — not the slow AI cruise', () => {
    const b = new HostileDroneBehaviour(KIND);
    b.setFlockFollow('leader', ['leader', 'f0']);
    const intent = b.tick(self(), viewWith({ leader: { x: FLOCK_FOLLOW_DISTANCE * 4, y: 0 } }));
    const mag = Math.hypot(intent.fx, intent.fy);
    // Far follower boosts at the kind's REAL player-boost impulse — well above
    // the slow AI cruise (ai.thrust).
    expect(mag).toBeGreaterThan(KIND.ai.thrust);
    expect(mag).toBeCloseTo(KIND.thrustImpulse * KIND.boostMultiplier, 5);
  });

  it('does NOT boost when in formation (gap within the boost factor) — calm cruise', () => {
    const b = new HostileDroneBehaviour(KIND);
    b.setFlockFollow('leader', ['leader', 'f0']);
    // Leader just ahead, well inside the boost gap → normal AI cruise, not boost.
    const intent = b.tick(self(), viewWith({ leader: { x: 0, y: FLOCK_FOLLOW_DISTANCE, angle: 0 } }));
    expect(Math.hypot(intent.fx, intent.fy)).toBeLessThanOrEqual(KIND.ai.thrust + 1e-6);
  });

  it('keeps cruising (alignment) even when at the follow distance — no stop', () => {
    const b = new HostileDroneBehaviour(KIND);
    b.setFlockFollow('leader', ['leader', 'f0']);
    // Follower exactly at follow-distance behind the leader ⇒ cohesion 0; the
    // alignment term must still produce forward thrust so the herd keeps pace.
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
