/**
 * Lock for squad flying (RTS slice 15b): a squad flies in formation on its
 * leader, squad-wide commands go to the leader, individual orders return the
 * member to its slot, the leader is reassigned when it leaves, and a squad
 * whose member the owner is flying forms up on that (pilot-led) ship.
 *
 * Real fighter bodies in a `PhysicsWorld`, flown only through the posted
 * player control bits (`World.applyInput`), at the real 10 Hz re-plan.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PhysicsWorld } from '../../core/physics/World.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { FleetCommandSubsystem, type FleetCommandHooks } from './FleetCommandSubsystem.js';
import type { WingmanControls } from '../../core/ai/wingman/types.js';

const FIGHTER = { kind: getShipKind('fighter') };

let world: PhysicsWorld;
beforeAll(async () => {
  world = await PhysicsWorld.create();
});

let nextBase = 0;

function harness(opts: { pilot?: () => string | null } = {}) {
  const owners = new Map<string, string>();
  const tag = `h${nextBase++}-`;
  // The worker HOLDS a ship's last INPUT between re-plans (input-queue rule #3).
  const held = new Map<string, WingmanControls>();
  const hooks: FleetCommandHooks = {
    ownerOf: (id) => owners.get(id) ?? null,
    readPose: (id, out) => {
      const s = world.getShipState(id);
      if (!s) return false;
      out.x = s.x; out.y = s.y; out.vx = s.vx; out.vy = s.vy; out.angle = s.angle; out.angvel = s.angvel ?? 0;
      return true;
    },
    postInput: (id, c) => held.set(id, { ...c }),
    // The room resolves non-attached ships (the pilot's own ship) by id.
    resolvePoseInto: (id, out) => {
      const s = world.getShipState(id);
      if (!s) return false;
      out.x = s.x; out.y = s.y; out.vx = s.vx; out.vy = s.vy; out.angle = s.angle;
      return true;
    },
    pilotShipOf: () => (opts.pilot ? opts.pilot() : null),
  };
  const sys = new FleetCommandSubsystem(hooks, { disabled: false });
  let tick = 0;
  const add = (name: string, x: number, y: number): string => {
    const id = tag + name;
    world.spawnShip(id, x, y, 'fighter');
    owners.set(id, 'alice');
    sys.attach(id, 'alice', FIGHTER, { x, y });
    return id;
  };
  const run = (ticks: number, until?: () => boolean, before?: () => void): boolean => {
    for (let t = 0; t < ticks; t++) {
      before?.();
      sys.tick(tick++);
      for (const [id, c] of held) if (sys.isAttached(id)) world.applyInput(id, c);
      world.tick(1 / 60);
      if (until?.()) return true;
    }
    return false;
  };
  return { sys, owners, add, run };
}

const pos = (id: string) => world.getShipState(id)!;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
const near = (a: { x: number; y: number }, b: { x: number; y: number }, r: number): boolean => dist(a, b) < r;

describe('FleetCommandSubsystem — squads fly in formation', () => {
  it('a squad-wide move: the leader flies it, the members hold their slots and arrive with it', () => {
    const bx = 0 * 40_000;
    const { sys, add, run } = harness();
    const L = add('L', bx, 0);
    const A = add('A', bx + 300, -200);
    const B = add('B', bx - 300, -200);
    sys.formSquad('alice', [L, A, B]);
    run(6);
    expect(sys.brainOf(A)!.formationLeaderId).toBe(L);
    expect(sys.brainOf(B)!.formationSlotIndex).toBe(2);
    expect(sys.brainOf(L)!.formationLeaderId).toBeNull();
    const rows = sys.statusFor('alice');
    expect(rows.every((r) => r.squadLeaderId === L)).toBe(true);

    const target = { x: bx, y: 3000 };
    const acc = sys.applyOrder('alice', [L, A, B], { kind: 'move', ...target });
    expect([...acc].sort()).toEqual([L, A, B].sort());
    expect(sys.brainOf(L)!.order).toEqual({ kind: 'move', ...target });
    expect(sys.brainOf(A)!.order).toBeNull();
    expect(sys.brainOf(B)!.order).toBeNull();

    // Mid-flight: the members trail the leader (behind it, either side).
    run(60 * 6);
    const l = pos(L);
    expect(l.y).toBeGreaterThan(500);
    expect(pos(A).y).toBeLessThan(l.y);
    expect(pos(B).y).toBeLessThan(l.y);
    expect(pos(A).x).toBeGreaterThan(l.x); // slot 1: starboard of a north-bound leader
    expect(pos(B).x).toBeLessThan(l.x);    // slot 2: port

    expect(run(60 * 40, () => sys.brainOf(L)!.order === null
      && sys.brainOf(A)!.activity === 'guarding' && sys.brainOf(B)!.activity === 'guarding')).toBe(true);
    expect(near(pos(L), target, 80)).toBe(true);
    const spacing = sys.brainOf(A)!.stationSpacing;
    for (const m of [A, B]) expect(near(pos(m), pos(L), spacing * 2.5)).toBe(true);
  });

  it('an order to one member: it goes, then rejoins its slot; a subset mode takes it out of the squad', () => {
    const bx = 1 * 40_000;
    const { sys, add, run } = harness();
    const L = add('L', bx, 0);
    const A = add('A', bx - 200, -200);
    const B = add('B', bx + 200, -200);
    const { squadId } = sys.formSquad('alice', [L, A, B])!;
    run(60 * 15);
    expect(sys.brainOf(A)!.activity).toBe('guarding');
    const spacing = sys.brainOf(A)!.stationSpacing;

    sys.applyOrder('alice', [A], { kind: 'move', x: bx + 2000, y: 0 });
    expect(sys.brainOf(A)!.order).not.toBeNull();
    expect(sys.brainOf(L)!.order).toBeNull();
    expect(run(60 * 30, () => sys.brainOf(A)!.order === null)).toBe(true);
    expect(pos(A).x).toBeGreaterThan(bx + 1500);
    expect(sys.brainOf(A)!.formationLeaderId).toBe(L);
    expect(run(60 * 30, () => sys.brainOf(A)!.activity === 'guarding' && near(pos(A), pos(L), spacing * 2))).toBe(true);

    // A standing mode to a subset: that ship leaves; the squad keeps the rest.
    sys.setMode('alice', [B], 'defend', { x: bx + 5000, y: 0 });
    expect(sys.squad(squadId)!.memberIds).toEqual([L, A]);
    expect(sys.brainOf(B)!.formationLeaderId).toBeNull();
    expect(sys.brainOf(B)!.guardPostX).toBe(bx + 5000);
    expect(sys.statusFor('alice').find((r) => r.id === B)!.squadLeaderId).toBeNull();
  });

  it('a squad-wide mode becomes the squad mode; when the leader leaves the next member leads and flies it', () => {
    const bx = 2 * 40_000;
    const { sys, add, run } = harness();
    const L = add('L', bx, 0);
    const A = add('A', bx - 200, -200);
    const B = add('B', bx + 200, -200);
    const { squadId } = sys.formSquad('alice', [L, A, B])!;
    sys.setMode('alice', [L, A, B], 'patrol', { route: [[bx, 1500], [bx + 1500, 1500]] });
    expect(sys.squad(squadId)!.mode).toBe('patrol');
    expect(sys.brainOf(L)!.mode).toBe('patrol');
    expect(sys.brainOf(A)!.mode).toBe('defend'); // members only hold formation
    sys.setStance('alice', [L, A, B], 'aggressive');
    expect(sys.brainOf(B)!.stance).toBe('aggressive');
    run(60 * 5);
    expect(sys.brainOf(L)!.activity).toBe('patrolling');

    // The leader is gone (reclaimed / destroyed): A leads, flies the patrol; B forms on A.
    sys.detach(L);
    world.despawnShip?.(L);
    expect(sys.squad(squadId)!.leaderId).toBe(A);
    run(6);
    expect(sys.brainOf(A)!.formationLeaderId).toBeNull();
    expect(sys.brainOf(A)!.mode).toBe('patrol');
    expect(sys.brainOf(A)!.patrolRouteLength).toBe(2);
    expect(sys.brainOf(B)!.formationLeaderId).toBe(A);
    expect(sys.brainOf(B)!.formationSlotIndex).toBe(1);
    run(60 * 10);
    expect(sys.brainOf(A)!.activity).toBe('patrolling');
    expect(near(pos(B), pos(A), sys.brainOf(B)!.stationSpacing * 3)).toBe(true);
  });

  it('a member the owner flies leads the squad (pilot-led); released, it is the AI leader on the squad mode', () => {
    const bx = 3 * 40_000;
    let piloting: string | null = null;
    const { sys, add, run } = harness({ pilot: () => piloting });
    const L = add('L', bx, 0);
    const P = add('P', bx + 400, 0);
    const A = add('A', bx - 200, -200);
    const { squadId } = sys.formSquad('alice', [L, P, A])!;
    sys.setMode('alice', [L, P, A], 'defend', { x: bx, y: 0 });
    run(60 * 5);

    // The owner takes P's controls: detached, but still in the squad.
    sys.detach(P, { keepSquad: true });
    piloting = P;
    expect(sys.squadOf(P)!.id).toBe(squadId);
    run(6);
    expect(sys.squad(squadId)!.leaderId).toBe(P);
    expect(sys.brainOf(L)!.formationLeaderId).toBe(P);
    expect(sys.brainOf(A)!.formationLeaderId).toBe(P);
    expect(sys.statusFor('alice').every((r) => r.squadLeaderId === P)).toBe(true);

    // The pilot flies P (player keys: a 3 s burn on its heading, then a coast); the AI members follow.
    let burn = 180;
    const fly = (): void => { if (burn-- > 0) world.applyInput(P, { thrust: true, reverse: false, turnLeft: false, turnRight: false, boost: false }); };
    const p0 = { x: pos(P).x, y: pos(P).y };
    run(60 * 20, undefined, fly);
    const p = pos(P);
    const tx = p.x - p0.x, ty = p.y - p0.y;
    const travelled = Math.hypot(tx, ty);
    expect(travelled).toBeGreaterThan(400);
    for (const m of [L, A]) {
      // Followed it the whole way: as far along P's track as P (within a few slots).
      expect(((pos(m).x - p0.x) * tx + (pos(m).y - p0.y) * ty) / travelled).toBeGreaterThan(travelled - sys.brainOf(m)!.stationSpacing * 4);
      expect(near(pos(m), p, sys.brainOf(m)!.stationSpacing * 4)).toBe(true);
    }
    // A squad-wide move while pilot-led: nobody AI-flown takes it.
    sys.applyOrder('alice', [L, A], { kind: 'move', x: 0, y: 0 });
    expect(sys.brainOf(L)!.order).toBeNull();
    expect(sys.brainOf(A)!.order).toBeNull();

    // Released: P is attached again and leads on the squad mode (defend).
    piloting = null;
    const s = pos(P);
    sys.attach(P, 'alice', FIGHTER, { x: s.x, y: s.y });
    run(6);
    expect(sys.squad(squadId)!.leaderId).toBe(P);
    expect(sys.brainOf(P)!.formationLeaderId).toBeNull();
    expect(sys.brainOf(P)!.mode).toBe('defend');
    expect(sys.brainOf(P)!.guardPostX).toBe(bx);
    expect(sys.brainOf(L)!.formationLeaderId).toBe(P);

    // The flown member dies while piloted: it leaves the squad.
    sys.detach(P, { keepSquad: true });
    piloting = P;
    sys.forgetSquadMember(P);
    piloting = null;
    expect(sys.squadOf(P)).toBeNull();
    expect(sys.squad(squadId)!.leaderId).toBe(L);
  });

  it('disbanding returns every member to its own mode', () => {
    const bx = 4 * 40_000;
    const { sys, add, run } = harness();
    const L = add('L', bx, 0);
    const A = add('A', bx - 200, -200);
    const { squadId } = sys.formSquad('alice', [L, A])!;
    run(6);
    expect(sys.brainOf(A)!.formationLeaderId).toBe(L);
    sys.disbandSquad('alice', squadId);
    expect(sys.brainOf(A)!.formationLeaderId).toBeNull();
    expect(sys.squadOf(A)).toBeNull();
    run(6);
    expect(sys.brainOf(A)!.mode).toBe('defend');
  });
});
