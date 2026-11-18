/**
 * Navigation slice 10: squads go single file round rock (owner, 2026-11-17).
 * A follower asks the room's routes (`view.nav`) for the way to the ship ahead
 * of it in squad order; open space (no waypoint) keeps the boids herd, rock
 * between makes it fly the route and stop a follow distance behind.
 */
import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour } from './HostileDroneBehaviour.js';
import type { AiEntityPoseOut, AiWorldView, IAiNavRoutes } from '../contracts/IAiBehaviour.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import { stepKinematic, type KinematicBody } from './pilotTestKit.js';
import { makePilotHandling, pilotTurnRadius } from './virtualPilot.js';
import { shipBodyMass } from '../../shared-types/shipScale/tuning.js';

const KIND = getShipKind('fighter');

/** A routes stub: records each ask; `wp` (when set) is the answer for everyone. */
class FakeNav implements IAiNavRoutes {
  wpX = 0; wpY = 0; ahead = 0;
  wp: { x: number; y: number } | null = null;
  readonly asks: { id: string; tx: number; ty: number; keep: boolean | undefined }[] = [];
  readonly turns: { heading: number | undefined; turnRadius: number | undefined }[] = [];
  waypoint(id: string, x: number, y: number, tx: number, ty: number, _c: number, _a: number, keep?: boolean,
    heading?: number, turnRadius?: number): boolean {
    this.asks.push({ id, tx, ty, keep });
    this.turns.push({ heading, turnRadius });
    if (this.wp === null) return false;
    this.wpX = this.wp.x; this.wpY = this.wp.y; this.ahead = Math.hypot(this.wp.x - x, this.wp.y - y);
    return true;
  }
}

function view(poses: Record<string, KinematicBody>, nav: IAiNavRoutes): AiWorldView {
  return {
    players: [], tick: 100, dtSec: 1 / 60, nav,
    resolveEntityInto: (id: string, out: AiEntityPoseOut): boolean => {
      const p = poses[id];
      if (!p) return false;
      out.x = p.x; out.y = p.y; out.vx = p.vx; out.vy = p.vy; out.angle = p.angle; out.angvel = 0;
      return true;
    },
  };
}

const at = (x: number, y: number): KinematicBody => ({ x, y, vx: 0, vy: 0, angle: 0, angvel: 0 });

describe('HostileDroneBehaviour — single file round rock (navigation slice 10)', () => {
  it('each follower asks for the way to the ship ahead of it in squad order (the first to the leader), keeping a moving goal', () => {
    const nav = new FakeNav();
    const poses = { L: at(0, 3000), a: at(0, 1000), b: at(0, 0) };
    const members = ['L', 'a', 'b'];
    const A = new HostileDroneBehaviour(KIND), B = new HostileDroneBehaviour(KIND);
    A.setFlockFollow('L', members); B.setFlockFollow('L', members);
    const v = view(poses, nav);
    A.tick({ id: 'a', ...poses.a }, v);
    B.tick({ id: 'b', ...poses.b }, v);
    expect(nav.asks).toEqual([{ id: 'a', tx: 0, ty: 3000, keep: true }, { id: 'b', tx: 0, ty: 1000, keep: true }]);
  });

  it('rock between: flies the route waypoint, not at the leader; open space: the herd as before', () => {
    const nav = new FakeNav();
    // Leader straight ahead (+y); the route's waypoint off to +x.
    const poses = { L: at(0, 3000), f: at(0, 0) };
    nav.wp = { x: 2000, y: 0 };
    const routed = new HostileDroneBehaviour(KIND);
    routed.setFlockFollow('L', ['L', 'f']);
    const body = at(0, 0);
    for (let i = 0; i < 120; i++) stepKinematic(body, KIND, routed.tick({ id: 'f', ...body }, view({ ...poses, f: body }, nav)));
    expect(body.x).toBeGreaterThan(Math.abs(body.y - 0) * 2); // heading for the waypoint
    nav.wp = null;
    const herd = new HostileDroneBehaviour(KIND);
    herd.setFlockFollow('L', ['L', 'f']);
    const b2 = at(0, 0);
    for (let i = 0; i < 120; i++) stepKinematic(b2, KIND, herd.tick({ id: 'f', ...b2 }, view({ ...poses, f: b2 }, nav)));
    expect(b2.y).toBeGreaterThan(Math.abs(b2.x) * 2); // straight at the leader
  });

  it('on the route it stops a follow distance behind the ship ahead', () => {
    const nav = new FakeNav();
    const follow = shipTuning(KIND).flockFollow;
    const poses = { L: at(0, follow * 0.8), f: at(0, 0) };
    nav.wp = { x: 0, y: follow * 0.8 };
    const b = new HostileDroneBehaviour(KIND);
    b.setFlockFollow('L', ['L', 'f']);
    const body = at(0, 0);
    const intent = b.tick({ id: 'f', ...body }, view(poses, nav));
    expect(intent.input ?? 0).toBe(0);
  });
});

describe('HostileDroneBehaviour — a capital plans with its nose (navigation slice 11)', () => {
  it('a battleship on a Move sends its heading and turning radius; a fighter sends none', () => {
    const BS = getShipKind('battleship');
    for (const [kind, angle] of [[BS, 0.7], [KIND, 0.7]] as const) {
      const nav = new FakeNav(), b = new HostileDroneBehaviour(kind);
      b.setTravel(0, 40_000);
      b.tick({ id: 's', x: 0, y: 0, vx: 0, vy: 0, angle, angvel: 0 }, view({}, nav));
      const turn = nav.turns[0]!;
      if (kind === BS) {
        expect(turn.heading).toBe(0.7);
        expect(turn.turnRadius).toBeCloseTo(pilotTurnRadius(makePilotHandling(BS, shipBodyMass(BS))), 6);
        expect(turn.turnRadius!).toBeGreaterThan(shipTuning(BS).navClearance);
      } else {
        expect(turn.heading).toBeNaN();
        expect(turn.turnRadius).toBe(0);
      }
    }
  });
});
