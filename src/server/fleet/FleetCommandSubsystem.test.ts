/**
 * Lock for `FleetCommandSubsystem` (RTS command layer): ownership filtering,
 * the 64-id cap, squad limits, the group-move spread, the kill switch,
 * detach, the orders each command leaves, and status contents. Driven
 * through injected hooks (no live room). The AI pilot brain that flies the
 * hulls is the room's (integration tests).
 */
import { describe, it, expect } from 'vitest';
import {
  FleetCommandSubsystem,
  FLEET_MAX_IDS_PER_COMMAND,
  isWingmenDisabled,
  patrolPassRadiusFor,
  type FleetCommandHooks,
  type FleetPose,
} from './FleetCommandSubsystem.js';
import { clearFleetOrder, stepFleetPatrol } from './fleetShipOrders.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';

const FIGHTER = { kind: getShipKind('fighter') };

function harness(opts: { disabled?: boolean } = {}, extra: Partial<FleetCommandHooks> = {}) {
  const owners = new Map<string, string>();
  const poses = new Map<string, FleetPose>();
  const issued: string[] = [];
  const modes: string[] = [];
  const hooks: FleetCommandHooks = {
    ownerOf: (id) => owners.get(id) ?? null,
    readPose: (id, out) => {
      const p = poses.get(id);
      if (!p) return false;
      Object.assign(out, p);
      return true;
    },
    orderIssued: (id) => issued.push(id),
    modeSet: (id) => modes.push(id),
    ...extra,
  };
  const sys = new FleetCommandSubsystem(hooks, { disabled: opts.disabled ?? false });
  const add = (id: string, owner: string, x = 0, y = 0): void => {
    owners.set(id, owner);
    poses.set(id, { x, y, vx: 0, vy: 0, angle: 0, angvel: 0 });
    sys.attach(id, owner, FIGHTER, { x, y });
  };
  return { sys, owners, poses, add, issued, modes };
}

describe('FleetCommandSubsystem', () => {
  it('attach starts a ship in Defend / Defensive at its current spot', () => {
    const { sys, add } = harness();
    add('s1', 'alice', 100, -50);
    expect(sys.isAttached('s1')).toBe(true);
    const o = sys.ordersOf('s1')!;
    expect(o.mode).toBe('defend');
    expect(o.stance).toBe('defensive');
    expect(o.order).toBeNull();
    expect(o.guardPostX).toBe(100);
    expect(o.guardPostY).toBe(-50);
  });

  it('a move of several ships to one point gives each its own spot round it (RTS stop drift)', () => {
    const { sys, add, issued } = harness();
    // A column north-south, west of the target.
    add('n', 'alice', 0, 300);
    add('m', 'alice', 0, 0);
    add('s', 'alice', 0, -300);
    add('w', 'alice', -300, 0);
    sys.applyOrder('alice', ['n', 'm', 's', 'w'], { kind: 'move', x: 5000, y: 0 });
    expect([...issued].sort(), 'each ship is told its own order').toEqual(['m', 'n', 's', 'w']);
    const spacing = shipTuning(FIGHTER.kind).flockSeparation;
    const pts = ['n', 'm', 's', 'w'].map((id) => {
      const o = sys.ordersOf(id)!.order!;
      expect(o.kind).toBe('move');
      return o as { x: number; y: number };
    });
    for (let i = 0; i < pts.length; i++) {
      // Round the point: the cluster's first ring.
      expect(Math.hypot(pts[i]!.x - 5000, pts[i]!.y)).toBeLessThanOrEqual(spacing + 1e-6);
      for (let j = i + 1; j < pts.length; j++) {
        expect(Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.y - pts[j]!.y), 'spots a spacing apart')
          .toBeGreaterThanOrEqual(spacing - 1e-6);
      }
    }
    // Each keeps its side of the group: the north ship takes a northern spot.
    expect(pts[0]!.y).toBeGreaterThan(pts[2]!.y);
    // One ship goes to the very point.
    sys.applyOrder('alice', ['m'], { kind: 'move', x: 100, y: 200 });
    expect(sys.ordersOf('m')!.order).toEqual({ kind: 'move', x: 100, y: 200 });
  });

  it('commands apply only to the caller\'s own attached ships; foreign / unknown ids are dropped', () => {
    const { sys, add } = harness();
    add('a1', 'alice');
    add('a2', 'alice');
    add('b1', 'bob');
    const acc = [...sys.applyOrder('alice', ['a1', 'b1', 'ghost', 'a2', 'a1'], { kind: 'move', x: 500, y: 0 })];
    expect(acc).toEqual(['a1', 'a2']); // b1 foreign, ghost unknown, duplicate a1 once
    expect(sys.ordersOf('a1')!.order).toEqual({ kind: 'move', x: 500, y: 0 });
    expect(sys.ordersOf('b1')!.order).toBeNull();

    expect([...sys.setStance('bob', ['a1', 'b1'], 'aggressive')]).toEqual(['b1']);
    expect(sys.ordersOf('a1')!.stance).toBe('defensive');
    expect(sys.ordersOf('b1')!.stance).toBe('aggressive');

    expect([...sys.setMode('bob', ['a2'], 'patrol')]).toEqual([]);
    expect(sys.ordersOf('a2')!.mode).toBe('defend');
    expect([...sys.setMode('alice', ['a2'], 'defend', { x: 7, y: 9 })]).toEqual(['a2']);
    expect(sys.ordersOf('a2')!.guardPostX).toBe(7);
  });

  it('ownership is read live from the hook (a ship that changed hands is refused)', () => {
    const { sys, add, owners } = harness();
    add('s1', 'alice');
    owners.set('s1', 'bob');
    expect([...sys.applyOrder('alice', ['s1'], { kind: 'stop' })]).toEqual([]);
    expect([...sys.applyOrder('bob', ['s1'], { kind: 'stop' })]).toEqual(['s1']);
  });

  it(`reads at most ${FLEET_MAX_IDS_PER_COMMAND} ids per command`, () => {
    const { sys, add } = harness();
    const ids: string[] = [];
    for (let i = 0; i < 80; i++) { add(`s${i}`, 'alice'); ids.push(`s${i}`); }
    const acc = sys.setStance('alice', ids, 'holdFire');
    expect(acc.length).toBe(FLEET_MAX_IDS_PER_COMMAND);
    expect(sys.ordersOf('s63')!.stance).toBe('holdFire');
    expect(sys.ordersOf('s64')!.stance).toBe('defensive');
  });

  it('squads need 2–24 owned ships; re-forming moves members; disband is owner-only', () => {
    const { sys, add } = harness();
    for (let i = 0; i < 30; i++) add(`s${i}`, 'alice');
    add('b1', 'bob');
    expect(sys.formSquad('alice', ['s0'])).toBeNull();
    expect(sys.formSquad('alice', ['s0', 'b1'])).toBeNull(); // only 1 owned
    const ids25 = Array.from({ length: 25 }, (_, i) => `s${i}`);
    expect(sys.formSquad('alice', ids25)).toBeNull();
    const ids24 = ids25.slice(0, 24);
    const sq = sys.formSquad('alice', ids24)!;
    expect(sq.memberIds).toHaveLength(24);
    expect(sys.squad(sq.squadId)!.leaderId).toBe('s0');

    // s0, s1 move to a new squad; the old one keeps 22 and a new leader.
    const sq2 = sys.formSquad('alice', ['s0', 's1'])!;
    expect(sys.squad(sq.squadId)!.memberIds).toHaveLength(22);
    expect(sys.squad(sq.squadId)!.leaderId).toBe('s2');

    expect(sys.disbandSquad('bob', sq2.squadId)).toEqual([]);
    expect(sys.squad(sq2.squadId)).not.toBeNull();
    expect([...sys.disbandSquad('alice', sq2.squadId)]).toEqual(['s0', 's1']);
    expect(sys.squad(sq2.squadId)).toBeNull();
    expect(sys.statusFor('alice').find((s) => s.id === 's0')!.squadId).toBeNull();
  });

  it('a squad that drops below 2 members dissolves', () => {
    const { sys, add } = harness();
    add('a', 'alice'); add('b', 'alice');
    const sq = sys.formSquad('alice', ['a', 'b'])!;
    sys.detach('a');
    expect(sys.squad(sq.squadId)).toBeNull();
    expect(sys.statusFor('alice')[0]!.squadId).toBeNull();
  });

  it('kill switch: attach is a no-op and commands find nothing', () => {
    const { sys, add } = harness({ disabled: true });
    add('s1', 'alice');
    expect(sys.isAttached('s1')).toBe(false);
    expect(sys.ordersOf('s1')).toBeNull();
    expect(sys.applyOrder('alice', ['s1'], { kind: 'stop' })).toEqual([]);
  });

  it('isWingmenDisabled reads EQX_DISABLE_WINGMEN', () => {
    expect(isWingmenDisabled({ EQX_DISABLE_WINGMEN: '1' })).toBe(true);
    expect(isWingmenDisabled({ EQX_DISABLE_WINGMEN: 'true' })).toBe(true);
    expect(isWingmenDisabled({})).toBe(false);
  });

  it('detach forgets the ship; the others keep their orders', () => {
    const { sys, add } = harness();
    add('s1', 'alice'); add('s2', 'alice'); add('s3', 'alice');
    sys.setStance('alice', ['s3'], 'aggressive');
    sys.detach('s1');
    expect(sys.isAttached('s1')).toBe(false);
    expect(sys.ordersOf('s1')).toBeNull();
    expect(sys.size).toBe(2);
    expect(sys.ordersOf('s3')!.stance).toBe('aggressive');
    expect(sys.statusFor('alice').map((s) => s.id).sort()).toEqual(['s2', 's3']);
  });

  it('statusFor lists only the owner\'s ships with mode / stance / activity / target / order', () => {
    const { sys, add } = harness({}, { activityOf: (id) => (id === 'a1' ? 'chasing' : null) });
    add('a1', 'alice'); add('a2', 'alice'); add('b1', 'bob');
    sys.setStance('alice', ['a2'], 'aggressive');
    sys.applyOrder('alice', ['a1'], { kind: 'attack', targetId: 'swarm-7' });
    const st = sys.statusFor('alice').map((s) => ({ ...s }));
    expect(st.map((s) => s.id).sort()).toEqual(['a1', 'a2']);
    const a1 = st.find((s) => s.id === 'a1')!;
    expect(a1).toMatchObject({
      mode: 'defend', stance: 'defensive', activity: 'chasing', targetId: 'swarm-7',
      order: { kind: 'attack', targetId: 'swarm-7' }, squadId: null,
    });
    const a2 = st.find((s) => s.id === 'a2')!;
    expect(a2).toMatchObject({ stance: 'aggressive', order: null, targetId: null, activity: 'idle' });
    // The order done (the room completes it): the status follows.
    clearFleetOrder(sys.ordersOf('a1')!);
    const after = sys.statusFor('alice').find((s) => s.id === 'a1')!;
    expect(after.order).toBeNull();
    expect(after.targetId).toBeNull();
    expect(sys.statusFor('carol')).toEqual([]);
  });

  it('an attack order follows its target across a ship key move (hand-over)', () => {
    const { sys, add } = harness();
    add('a1', 'alice');
    sys.applyOrder('alice', ['a1'], { kind: 'attack', targetId: 'bob' });
    sys.shipKeyMoved('bob', 'bob-hull');
    expect(sys.ordersOf('a1')!.order).toEqual({ kind: 'attack', targetId: 'bob-hull' });
    expect(sys.statusFor('alice')[0]!.targetId).toBe('bob-hull');
  });
});

describe('FleetCommandSubsystem — modes (RTS slice 8)', () => {
  it('setMode passes a patrol route through; a one-point route defends that point', () => {
    const { sys, add } = harness();
    add('a1', 'alice');
    add('a2', 'alice');
    sys.setMode('alice', ['a1'], 'patrol', { route: [[0, 1000], [1000, 1000], [1000, 0]] });
    const o = sys.ordersOf('a1')!;
    expect(o.mode).toBe('patrol');
    expect(o.routeLen).toBe(3);
    expect([o.route[2], o.route[3]]).toEqual([1000, 1000]);

    sys.setMode('alice', ['a2'], 'patrol', { route: [[40, 50]] });
    expect(sys.ordersOf('a2')!.mode).toBe('defend');
    expect(sys.ordersOf('a2')!.guardPostX).toBe(40);
  });

  it('a patrol starts at the waypoint nearest the ship and loops on the shared stepper', () => {
    const { sys, add } = harness();
    const pass = patrolPassRadiusFor(FIGHTER.kind);
    const D = pass * 20;
    add('a1', 'alice', D, pass * 4);
    sys.setMode('alice', ['a1'], 'patrol', { route: [[0, D], [D, D], [D, 0]] });
    const o = sys.ordersOf('a1')!;
    expect(stepFleetPatrol(o, D, pass * 4), 'nearest waypoint first').toBe(2);
    expect(stepFleetPatrol(o, D, 0), 'passed: on to the next, looping').toBe(0);
    expect(stepFleetPatrol(o, D / 2, D / 2), 'not there yet').toBe(0);
    // A finished order resumes from the waypoint nearest the ship.
    clearFleetOrder(o);
    expect(stepFleetPatrol(o, D, D - pass * 4)).toBe(1);
  });

  it('escort accepts an own ship or the caller\'s piloted ship; foreign ids and itself are dropped', () => {
    const { sys, add, owners } = harness({}, { pilotShipOf: (pid) => (pid === 'alice' ? 'alice-flagship' : null) });
    add('a1', 'alice');
    add('a2', 'alice');
    add('b1', 'bob');
    owners.set('bobs-ship', 'bob');

    sys.setMode('alice', ['a1'], 'escort', { escortId: 'a2' });
    expect(sys.ordersOf('a1')!.mode).toBe('escort');
    expect(sys.ordersOf('a1')!.escortId).toBe('a2');
    expect(sys.escortTargetOf('a1')).toBe('a2');

    sys.setMode('alice', ['a1'], 'escort', { escortId: 'alice-flagship' });
    expect(sys.ordersOf('a1')!.escortId).toBe('alice-flagship');

    sys.setMode('alice', ['a1'], 'escort', { escortId: 'bobs-ship' });
    expect(sys.ordersOf('a1')!.mode).toBe('defend');
    expect(sys.ordersOf('a1')!.escortId).toBeNull();

    // A group escort of a1: a1 itself is not told to escort itself.
    sys.setMode('alice', ['a1', 'a2'], 'escort', { escortId: 'a1' });
    expect(sys.ordersOf('a1')!.mode).toBe('defend');
    expect(sys.ordersOf('a2')!.escortId).toBe('a1');
  });

  it('retreat takes a point; without one it falls back to the post', () => {
    const { sys, add, modes } = harness();
    add('a1', 'alice', 0, 0);
    sys.setMode('alice', ['a1'], 'retreat', { x: 3000, y: 0 });
    const o = sys.ordersOf('a1')!;
    expect([o.mode, o.retreatPointX, o.retreatPointY]).toEqual(['retreat', 3000, 0]);
    expect(modes, 'the room is told (it flies the brain there)').toContain('a1');
    sys.setMode('alice', ['a1'], 'retreat');
    expect([o.retreatPointX, o.guardPostX]).toEqual([null, 0]);
  });

  it('patrolPassRadiusFor scales with the hull (#18)', () => {
    const f = getShipKind('fighter');
    const bb = getShipKind('battleship');
    expect(patrolPassRadiusFor(f)).toBeGreaterThanOrEqual(shipTuning(f).wingmanArrive * 2);
    expect(patrolPassRadiusFor(bb)).toBeGreaterThan(patrolPassRadiusFor(f));
  });
});
