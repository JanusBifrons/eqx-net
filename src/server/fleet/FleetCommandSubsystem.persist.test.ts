/**
 * Lock for RTS slice 9 — wingman state across a server restart:
 * `exportShip` / `exportSquads` / `exportState` and the hydrate side
 * `restoreShip` / `restoreSquads`. Standing mode (+ data), stance and squad
 * membership survive a JSON round trip into a FRESH subsystem; direct orders
 * do not; invalid entries and foreign members are dropped; escort targets are
 * re-validated like a live `set_mode`.
 */
import { describe, it, expect } from 'vitest';
import { FleetCommandSubsystem, type FleetCommandHooks, type FleetPose } from './FleetCommandSubsystem.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

const FIGHTER = { kind: getShipKind('fighter') };

function harness() {
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
  };
  const sys = new FleetCommandSubsystem(hooks, { disabled: false });
  const add = (id: string, owner: string, x = 0, y = 0): void => {
    owners.set(id, owner);
    poses.set(id, { x, y, vx: 0, vy: 0, angle: 0, angvel: 0 });
    sys.attach(id, owner, FIGHTER, { x, y });
  };
  return { sys, owners, add };
}

/** What the snapshot would carry: through JSON, like the DB row. */
function viaJson<T>(v: T): unknown {
  return JSON.parse(JSON.stringify(v)) as unknown;
}

const ROUTE: Array<[number, number]> = [[100, 0], [100, 400], [-200, 400]];

describe('FleetCommandSubsystem persistence (slice 9)', () => {
  it('export → JSON → restore into a fresh subsystem keeps mode + data, stance and squads; not orders', () => {
    const a = harness();
    a.add('p1', 'alice');
    a.add('g1', 'alice', 50, 60);
    a.add('e1', 'alice');
    a.add('r1', 'alice');
    a.add('h1', 'alice');
    a.add('s1', 'alice', 10, 0);
    a.add('s2', 'alice', 20, 0);
    a.sys.setMode('alice', ['p1'], 'patrol', { route: ROUTE });
    a.sys.setStance('alice', ['p1'], 'aggressive');
    a.sys.setMode('alice', ['g1'], 'defend', { x: 300, y: -40 });
    a.sys.setMode('alice', ['e1'], 'escort', { escortId: 'g1' });
    a.sys.setStance('alice', ['e1'], 'holdFire');
    a.sys.setMode('alice', ['r1'], 'retreat', { x: -900, y: 900 });
    a.sys.setMode('alice', ['h1'], 'hunt', { x: 1, y: 2 });
    a.sys.applyOrder('alice', ['h1'], { kind: 'move', x: 5000, y: 0 }); // not persisted
    const sq = a.sys.formSquad('alice', ['s1', 's2'])!;
    a.sys.setMode('alice', ['s1', 's2'], 'defend', { x: 77, y: 88 }); // squad-wide

    const state = a.sys.exportState();
    const ships = viaJson(state.ships) as Array<Record<string, unknown> & { id: string }>;
    const squads = viaJson(state.squads) as unknown[];
    expect(ships.find((s) => s.id === 'p1')).toMatchObject({ mode: 'patrol', stance: 'aggressive', modeData: { route: ROUTE } });
    expect(ships.find((s) => s.id === 's1')).toMatchObject({ squadId: sq.squadId });
    expect(JSON.stringify(ships)).not.toContain('5000'); // no order

    // A fresh boot: the hulls come back with default brains.
    const b = harness();
    for (const id of ['p1', 'g1', 'e1', 'r1', 'h1', 's1', 's2']) b.add(id, 'alice');
    for (const s of ships) b.sys.restoreShip(s.id, s);
    expect(b.sys.restoreSquads(squads)).toBe(1);

    const p1 = b.sys.brainOf('p1')!;
    expect(p1.mode).toBe('patrol');
    expect(p1.stance).toBe('aggressive');
    expect(p1.patrolRouteLength).toBe(3);
    expect([p1.patrolRouteX(1), p1.patrolRouteY(1)]).toEqual([100, 400]);
    const g1 = b.sys.brainOf('g1')!;
    expect([g1.mode, g1.guardPostX, g1.guardPostY]).toEqual(['defend', 300, -40]);
    const e1 = b.sys.brainOf('e1')!;
    expect([e1.mode, e1.escortId, e1.stance]).toEqual(['escort', 'g1', 'holdFire']);
    const r1 = b.sys.brainOf('r1')!;
    expect([r1.mode, r1.retreatPointX, r1.retreatPointY]).toEqual(['retreat', -900, 900]);
    const h1 = b.sys.brainOf('h1')!;
    expect([h1.mode, h1.guardPostX, h1.order]).toEqual(['hunt', 1, null]);

    const restored = b.sys.squad(sq.squadId)!;
    expect(restored).toMatchObject({ ownerId: 'alice', leaderId: 's1', memberIds: ['s1', 's2'], mode: 'defend' });
    // Squads fly as a loose pack (RTS Part B slice 10): no formation shape is saved.
    expect(JSON.stringify(squads)).not.toContain('shape');
    b.sys.tick(0); // roles: the leader flies the squad mode, the member follows it
    expect(b.sys.brainOf('s1')!.guardPostX).toBe(77);
    expect(b.sys.squadFollowOf('s2')).toBe('s1');
    // A squad formed after the restore never reuses a restored id.
    b.add('t1', 'alice');
    b.add('t2', 'alice');
    expect(b.sys.formSquad('alice', ['t1', 't2'])!.squadId).not.toBe(sq.squadId);
  });

  it('invalid entries are dropped, valid parts kept', () => {
    const { sys, add } = harness();
    add('x1', 'alice', 5, 6);
    expect(sys.restoreShip('x1', { mode: 'teleport', stance: 'aggressive' })).toBe(true);
    expect(sys.brainOf('x1')!.mode).toBe('defend'); // bad mode dropped
    expect(sys.brainOf('x1')!.stance).toBe('aggressive'); // good stance kept
    expect(sys.restoreShip('x1', { mode: 'patrol', modeData: { route: [[1, 'a']] }, stance: 'brave' })).toBe(false);
    expect(sys.brainOf('x1')!.mode).toBe('defend');
    expect(sys.restoreShip('ghost', { mode: 'hunt' })).toBe(false); // not attached

    add('y1', 'alice');
    add('y2', 'alice');
    expect(sys.restoreSquads([
      null,
      { id: 'sq-1', ownerId: 'alice', leaderId: '', memberIds: ['y1', 'y2'] }, // bad leader id
      { id: 'sq-2', ownerId: 'alice', leaderId: 'y1', memberIds: ['y1', 'ghost'] }, // < 2 left
      { id: 'sq-3', ownerId: 'alice', leaderId: 'y1', memberIds: 'y1,y2' },
    ])).toBe(0);
    expect(sys.squadOf('y1')).toBeNull();
  });

  it('a squad saved with a formation shape (before RTS Part B slice 10) still restores', () => {
    const { sys, add } = harness();
    add('z1', 'alice');
    add('z2', 'alice');
    add('z3', 'alice');
    add('z4', 'alice');
    expect(sys.restoreSquads([
      { id: 'sq-7', ownerId: 'alice', leaderId: 'z1', memberIds: ['z1', 'z2'], shape: 'wedge', mode: 'defend', modeData: { x: 1, y: 2 } },
      { id: 'sq-8', ownerId: 'alice', leaderId: 'z3', memberIds: ['z3', 'z4'], shape: 'blob' }, // any old value
    ])).toBe(2);
    expect(sys.squad('sq-7')).toMatchObject({ leaderId: 'z1', memberIds: ['z1', 'z2'], mode: 'defend' });
    expect(sys.squad('sq-8')).toMatchObject({ leaderId: 'z3', memberIds: ['z3', 'z4'] });
    expect(JSON.stringify(sys.exportSquads())).not.toContain('shape');
  });

  it('a member its squad owner does not own is dropped; an escort target the owner does not own becomes defend', () => {
    const { sys, add, owners } = harness();
    add('a1', 'alice');
    add('a2', 'alice');
    add('b1', 'bob');
    expect(sys.restoreSquads([
      { id: 'sq-4', ownerId: 'alice', leaderId: 'b1', memberIds: ['b1', 'a1', 'a2'] },
    ])).toBe(1);
    expect(sys.squad('sq-4')).toMatchObject({ leaderId: 'a1', memberIds: ['a1', 'a2'] });
    expect(sys.squadOf('b1')).toBeNull();
    // Bob alone can't make a squad of Alice's ships either.
    expect(sys.restoreSquads([
      { id: 'sq-5', ownerId: 'bob', leaderId: 'b1', memberIds: ['b1', 'a1'] },
    ])).toBe(0);

    add('a3', 'alice');
    sys.restoreShip('a3', { mode: 'escort', modeData: { escortId: 'b1' } });
    expect(sys.brainOf('a3')!.mode).toBe('defend');
    expect(sys.brainOf('a3')!.escortId).toBeNull();
    sys.restoreShip('a3', { mode: 'escort', modeData: { escortId: 'a3' } }); // never itself
    expect(sys.brainOf('a3')!.mode).toBe('defend');
    // A hull whose owner changed since the save is not restored.
    owners.set('a3', 'carol');
    expect(sys.restoreShip('a3', { stance: 'holdFire' })).toBe(false);
  });
});
