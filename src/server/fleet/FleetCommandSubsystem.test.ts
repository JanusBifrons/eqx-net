/**
 * Lock for `FleetCommandSubsystem` (RTS command layer, slice 3): ownership
 * filtering, the 64-id cap, squad limits, the ~10 Hz staggered re-plan, the
 * boost energy gate, the kill switch, detach, and status contents. Driven
 * through injected hooks (no live room).
 */
import { describe, it, expect } from 'vitest';
import {
  FleetCommandSubsystem,
  FLEET_MAX_IDS_PER_COMMAND,
  FLEET_REPLAN_EVERY_TICKS,
  isWingmenDisabled,
  wingmanConfigFor,
  type FleetCommandHooks,
  type FleetPose,
} from './FleetCommandSubsystem.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipTuning, massOf } from '../../shared-types/shipScale/tuning.js';
import type { WingmanControls } from '../../core/ai/wingman/types.js';

const FIGHTER = { kind: getShipKind('fighter') };

interface Posted { id: string; tick: number; c: WingmanControls }

function harness(opts: { disabled?: boolean; replanEvery?: number; canBoost?: (id: string) => boolean } = {}) {
  const owners = new Map<string, string>();
  const poses = new Map<string, FleetPose>();
  const posted: Posted[] = [];
  const hooks: FleetCommandHooks = {
    ownerOf: (id) => owners.get(id) ?? null,
    readPose: (id, out) => {
      const p = poses.get(id);
      if (!p) return false;
      Object.assign(out, p);
      return true;
    },
    postInput: (id, c, tick) => posted.push({ id, tick, c: { ...c } }),
    ...(opts.canBoost ? { canBoost: opts.canBoost } : {}),
  };
  const sys = new FleetCommandSubsystem(hooks, {
    disabled: opts.disabled ?? false,
    ...(opts.replanEvery !== undefined ? { replanEvery: opts.replanEvery } : {}),
  });
  const add = (id: string, owner: string, x = 0, y = 0): void => {
    owners.set(id, owner);
    poses.set(id, { x, y, vx: 0, vy: 0, angle: 0, angvel: 0 });
    sys.attach(id, owner, FIGHTER, { x, y });
  };
  return { sys, owners, poses, posted, add };
}

describe('FleetCommandSubsystem', () => {
  it('attach starts a brain in Defend / Defensive at its current spot', () => {
    const { sys, add } = harness();
    add('s1', 'alice', 100, -50);
    expect(sys.isAttached('s1')).toBe(true);
    const b = sys.brainOf('s1')!;
    expect(b.mode).toBe('defend');
    expect(b.stance).toBe('defensive');
    expect(b.guardPostX).toBe(100);
    expect(b.guardPostY).toBe(-50);
  });

  it('a move of several ships to one point gives each its own spot round it (RTS stop drift)', () => {
    const { sys, add } = harness();
    // A column north-south, west of the target.
    add('n', 'alice', 0, 300);
    add('m', 'alice', 0, 0);
    add('s', 'alice', 0, -300);
    add('w', 'alice', -300, 0);
    sys.applyOrder('alice', ['n', 'm', 's', 'w'], { kind: 'move', x: 5000, y: 0 });
    const spacing = shipTuning(FIGHTER.kind).flockSeparation;
    const pts = ['n', 'm', 's', 'w'].map((id) => {
      const o = sys.brainOf(id)!.order!;
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
    expect(sys.brainOf('m')!.order).toEqual({ kind: 'move', x: 100, y: 200 });
  });

  it('commands apply only to the caller\'s own attached ships; foreign / unknown ids are dropped', () => {
    const { sys, add } = harness();
    add('a1', 'alice');
    add('a2', 'alice');
    add('b1', 'bob');
    const acc = [...sys.applyOrder('alice', ['a1', 'b1', 'ghost', 'a2', 'a1'], { kind: 'move', x: 500, y: 0 })];
    expect(acc).toEqual(['a1', 'a2']); // b1 foreign, ghost unknown, duplicate a1 once
    expect(sys.brainOf('a1')!.order).toEqual({ kind: 'move', x: 500, y: 0 });
    expect(sys.brainOf('b1')!.order).toBeNull();

    expect([...sys.setStance('bob', ['a1', 'b1'], 'aggressive')]).toEqual(['b1']);
    expect(sys.brainOf('a1')!.stance).toBe('defensive');
    expect(sys.brainOf('b1')!.stance).toBe('aggressive');

    expect([...sys.setMode('bob', ['a2'], 'patrol')]).toEqual([]);
    expect(sys.brainOf('a2')!.mode).toBe('defend');
    expect([...sys.setMode('alice', ['a2'], 'defend', { x: 7, y: 9 })]).toEqual(['a2']);
    expect(sys.brainOf('a2')!.guardPostX).toBe(7);
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
    expect(sys.brainOf('s63')!.stance).toBe('holdFire');
    expect(sys.brainOf('s64')!.stance).toBe('defensive');
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

  it('round-robin: each brain posts once per N ticks, staggered across ticks', () => {
    const N = FLEET_REPLAN_EVERY_TICKS;
    const { sys, add, posted } = harness();
    for (let i = 0; i < N * 2; i++) add(`s${i}`, 'alice', i * 1000, 0);
    const T0 = 1000;
    for (let t = T0; t < T0 + N * 5; t++) sys.tick(t);
    // Every brain posted exactly 5 times, N ticks apart.
    for (let i = 0; i < N * 2; i++) {
      const ticks = posted.filter((p) => p.id === `s${i}`).map((p) => p.tick);
      expect(ticks).toHaveLength(5);
      for (let k = 1; k < ticks.length; k++) expect(ticks[k]! - ticks[k - 1]!).toBe(N);
    }
    // Staggered: every tick carries the same share (2 of 12), not all at once.
    for (let t = T0; t < T0 + N * 5; t++) {
      expect(posted.filter((p) => p.tick === t)).toHaveLength(2);
    }
    // Posted ticks are the server tick handed to `tick`.
    expect(posted[0]!.tick).toBeGreaterThanOrEqual(T0);
  });

  it('a brain whose pose is gone skips its re-plan (no post)', () => {
    const { sys, add, posted, poses } = harness({ replanEvery: 1 });
    add('s1', 'alice');
    poses.delete('s1');
    sys.tick(1);
    expect(posted).toHaveLength(0);
  });

  it('move order produces thrust controls toward the point', () => {
    const { sys, add, posted } = harness({ replanEvery: 1 });
    add('s1', 'alice');
    // Fighter at angle 0 faces +Y; a point straight ahead ⇒ thrust, no turn.
    sys.applyOrder('alice', ['s1'], { kind: 'move', x: 0, y: 5000 });
    sys.tick(1);
    expect(posted[0]!.c.thrust).toBe(true);
    expect(posted[0]!.c.reverse).toBe(false);
    expect(sys.statusFor('alice')[0]!.activity).toBe('moving');
  });

  it('boost goes through the energy gate, and a held boost is stripped between re-plans', () => {
    let energyOk = false;
    const { sys, add, posted } = harness({ replanEvery: 6, canBoost: () => energyOk });
    add('s1', 'alice');
    // A long leg straight ahead: the brain asks for boost.
    sys.applyOrder('alice', ['s1'], { kind: 'move', x: 0, y: 100_000 });
    sys.tick(0); // phase 0 re-plans at tick 0
    expect(posted.at(-1)!.c.boost).toBe(false); // gate says no
    energyOk = true;
    sys.tick(6);
    expect(posted.at(-1)!.c.boost).toBe(true);
    const n = posted.length;
    sys.tick(7); // held, still affordable ⇒ nothing posted
    expect(posted.length).toBe(n);
    energyOk = false;
    sys.tick(8); // pool drained between re-plans ⇒ re-posted without boost
    expect(posted.length).toBe(n + 1);
    expect(posted.at(-1)!.c.boost).toBe(false);
    expect(posted.at(-1)!.c.thrust).toBe(true);
    sys.tick(9); // already stripped ⇒ no repeat
    expect(posted.length).toBe(n + 1);
  });

  it('kill switch: attach is a no-op and nothing is ever posted', () => {
    const { sys, add, posted } = harness({ disabled: true, replanEvery: 1 });
    add('s1', 'alice');
    expect(sys.isAttached('s1')).toBe(false);
    sys.tick(1);
    expect(posted).toHaveLength(0);
    expect(sys.applyOrder('alice', ['s1'], { kind: 'stop' })).toEqual([]);
  });

  it('isWingmenDisabled reads EQX_DISABLE_WINGMEN', () => {
    expect(isWingmenDisabled({ EQX_DISABLE_WINGMEN: '1' })).toBe(true);
    expect(isWingmenDisabled({ EQX_DISABLE_WINGMEN: 'true' })).toBe(true);
    expect(isWingmenDisabled({})).toBe(false);
  });

  it('detach stops posting and frees the slot (others keep their cadence)', () => {
    const { sys, add, posted } = harness({ replanEvery: 1 });
    add('s1', 'alice'); add('s2', 'alice'); add('s3', 'alice');
    sys.detach('s1');
    expect(sys.isAttached('s1')).toBe(false);
    for (let t = 0; t < 5; t++) sys.tick(t);
    expect(posted.some((p) => p.id === 's1')).toBe(false);
    expect(posted.filter((p) => p.id === 's2')).toHaveLength(5);
    expect(posted.filter((p) => p.id === 's3')).toHaveLength(5);
    expect(sys.size).toBe(2);
  });

  it('statusFor lists only the owner\'s ships with mode / stance / activity / target / order', () => {
    const { sys, add } = harness({ replanEvery: 1 });
    add('a1', 'alice'); add('a2', 'alice'); add('b1', 'bob');
    sys.setStance('alice', ['a2'], 'aggressive');
    sys.applyOrder('alice', ['a1'], { kind: 'attack', targetId: 'swarm-7' });
    const st = sys.statusFor('alice').map((s) => ({ ...s }));
    expect(st.map((s) => s.id).sort()).toEqual(['a1', 'a2']);
    const a1 = st.find((s) => s.id === 'a1')!;
    expect(a1).toMatchObject({ mode: 'defend', stance: 'defensive', targetId: 'swarm-7', order: { kind: 'attack', targetId: 'swarm-7' }, squadId: null });
    const a2 = st.find((s) => s.id === 'a2')!;
    expect(a2).toMatchObject({ stance: 'aggressive', order: null, targetId: null });
    sys.tick(1);
    // No resolver hook ⇒ the attack order completes; status follows.
    const after = sys.statusFor('alice').find((s) => s.id === 'a1')!;
    expect(after.order).toBeNull();
    expect(after.activity).toBe('guarding');
    expect(sys.statusFor('carol')).toEqual([]);
  });

  it('wingmanConfigFor: stats follow the kind, upgrades and tuning (#18)', () => {
    const kind = getShipKind('fighter');
    const base = wingmanConfigFor(kind);
    expect(base.stats.maxSpeed).toBe(kind.maxSpeed);
    expect(base.stats.maxAngvel).toBe(kind.maxAngvel);
    expect(base.stats.reverseAccel).toBeCloseTo((kind.thrustImpulse * kind.reverseFactor * 60) / massOf(kind, 1));
    expect(base.guardRadius).toBe(shipTuning(kind).guardRadiusMin);
    expect(base.arriveRadius).toBe(shipTuning(kind).wingmanArrive);
    const up = wingmanConfigFor(kind, { topSpeed: 2, turnRate: 2 });
    expect(up.stats.maxSpeed).toBeGreaterThan(base.stats.maxSpeed);
    expect(up.stats.maxAngvel).toBeGreaterThan(base.stats.maxAngvel);
    // A capital's arrive radius clears its hull.
    const bb = getShipKind('battleship');
    expect(shipTuning(bb).wingmanArrive).toBeGreaterThanOrEqual(bb.radius * 1.5);
  });
});

describe('FleetCommandSubsystem — modes (RTS slice 8)', () => {
  function modesHarness(extra: Partial<FleetCommandHooks> = {}) {
    const owners = new Map<string, string>();
    const poses = new Map<string, FleetPose>();
    const hooks: FleetCommandHooks = {
      ownerOf: (id) => owners.get(id) ?? null,
      readPose: (id, out) => {
        const p = poses.get(id);
        if (!p) return false;
        Object.assign(out, p);
        return true;
      },
      postInput: () => {},
      ...extra,
    };
    const sys = new FleetCommandSubsystem(hooks, { disabled: false, replanEvery: 1 });
    const add = (id: string, owner: string, x = 0, y = 0): void => {
      owners.set(id, owner);
      poses.set(id, { x, y, vx: 0, vy: 0, angle: 0, angvel: 0 });
      sys.attach(id, owner, FIGHTER, { x, y });
    };
    return { sys, owners, poses, add };
  }

  it('setMode passes a patrol route through; a one-point route defends that point', () => {
    const { sys, add } = modesHarness();
    add('a1', 'alice');
    add('a2', 'alice');
    sys.setMode('alice', ['a1'], 'patrol', { route: [[0, 1000], [1000, 1000], [1000, 0]] });
    expect(sys.brainOf('a1')!.mode).toBe('patrol');
    expect(sys.brainOf('a1')!.patrolRouteLength).toBe(3);
    sys.tick(0);
    expect(sys.statusFor('alice').find((s) => s.id === 'a1')!.activity).toBe('patrolling');

    sys.setMode('alice', ['a2'], 'patrol', { route: [[40, 50]] });
    expect(sys.brainOf('a2')!.mode).toBe('defend');
    expect(sys.brainOf('a2')!.guardPostX).toBe(40);
  });

  it('escort accepts an own ship or the caller\'s piloted ship; foreign ids and itself are dropped', () => {
    const { sys, add, owners } = modesHarness({ pilotShipOf: (pid) => (pid === 'alice' ? 'alice-flagship' : null) });
    add('a1', 'alice');
    add('a2', 'alice');
    add('b1', 'bob');
    owners.set('bobs-ship', 'bob');

    sys.setMode('alice', ['a1'], 'escort', { escortId: 'a2' });
    expect(sys.brainOf('a1')!.mode).toBe('escort');
    expect(sys.brainOf('a1')!.escortId).toBe('a2');

    sys.setMode('alice', ['a1'], 'escort', { escortId: 'alice-flagship' });
    expect(sys.brainOf('a1')!.escortId).toBe('alice-flagship');

    sys.setMode('alice', ['a1'], 'escort', { escortId: 'bobs-ship' });
    expect(sys.brainOf('a1')!.mode).toBe('defend');
    expect(sys.brainOf('a1')!.escortId).toBeNull();

    // A group escort of a1: a1 itself is not told to escort itself.
    sys.setMode('alice', ['a1', 'a2'], 'escort', { escortId: 'a1' });
    expect(sys.brainOf('a1')!.mode).toBe('defend');
    expect(sys.brainOf('a2')!.escortId).toBe('a1');
  });

  it('hunt asks the nearestHostile hook with the ticking ship\'s id and its sensor range', () => {
    const calls: { id: string; r: number }[] = [];
    const { sys, add } = modesHarness({
      nearestHostile: (id, _x, _y, r, out) => {
        calls.push({ id, r });
        out.x = 500; out.y = 0; out.vx = 0; out.vy = 0;
        return 'swarm-9';
      },
    });
    add('a1', 'alice');
    add('a2', 'alice');
    sys.setMode('alice', ['a1'], 'hunt');
    sys.tick(0);
    expect(calls.map((c) => c.id)).toEqual(['a1']);
    expect(calls[0]!.r).toBe(sys.brainOf('a1')!.huntSensorRange);
    expect(sys.statusFor('alice').find((s) => s.id === 'a1')!.targetId).toBe('swarm-9');
  });

  it('retreat takes a point; noteDamage reaches the brain\'s morale (seeded per ship id)', () => {
    const { sys, add } = modesHarness();
    add('a1', 'alice', 0, 0);
    sys.setMode('alice', ['a1'], 'retreat', { x: 3000, y: 0 });
    sys.tick(0);
    expect(sys.statusFor('alice')[0]!.activity).toBe('retreating');

    sys.noteDamage('a1', 90, 100, 0.1, 100, 0);
    sys.noteDamage('ghost', 90, 100, 0.1); // unknown: ignored
    sys.tick(1);
    expect(sys.brainOf('a1')!.moraleOutcome).not.toBeNull();
  });

  it('wingmanConfigFor carries the hull\'s aiRole and fire range', () => {
    const kind = getShipKind('fighter');
    const cfg = wingmanConfigFor(kind, undefined, 900);
    expect(cfg.aiRole).toBe(kind.aiRole);
    expect(cfg.fireRange).toBe(900);
  });

  it('recentAttackerOf: its own recent attacker, else a squadmate\'s, within the window (RTS slice 5)', () => {
    const { sys, add } = harness();
    add('a', 'alice');
    add('b', 'alice');
    add('c', 'alice');
    expect(sys.recentAttackerOf('a', 100, 600)).toBeNull();
    // A hit with no attacker id records nothing.
    sys.noteDamage('a', 5, 100, 0.95, 10, 10);
    expect(sys.recentAttackerOf('a', 100, 600)).toBeNull();
    sys.noteDamage('a', 5, 100, 0.9, 10, 10, 'drone-1', 100);
    expect(sys.recentAttackerOf('a', 650, 600)).toBe('drone-1');
    expect(sys.recentAttackerOf('a', 701, 600), 'too long ago').toBeNull();
    // b isn't in a squad with a yet: a's attacker is not b's business.
    expect(sys.recentAttackerOf('b', 120, 600)).toBeNull();
    sys.formSquad('alice', ['a', 'b', 'c']);
    sys.noteDamage('c', 5, 100, 0.9, 0, 0, 'drone-2', 110);
    expect(sys.recentAttackerOf('b', 120, 600), 'the most recent squadmate attacker').toBe('drone-2');
    expect(sys.recentAttackerOf('a', 120, 600), 'its own attacker comes first').toBe('drone-1');
    expect(sys.recentAttackerOf('ghost', 120, 600)).toBeNull();
  });
});
