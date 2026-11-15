/**
 * Lock for squad bookkeeping (RTS slice 15b; RTS Part B slice 10): squad-wide
 * commands go to the leader, an individual order leaves the member in the
 * pack, the leader is reassigned when it leaves, and a squad whose member the
 * owner is flying follows that (pilot-led) ship. Each role change reaches the
 * room through `modeSet` and reads back as `squadFollowOf` (who a member
 * follows) / `escortTargetOf`.
 *
 * Since slice 10 the AI pilot brain flies the pack (`setFlockFollow`), so the
 * old wingman-brain formation flight checks (slots, wedge sides) are gone; the
 * player-visible flight is locked in the room:
 * `tests/integration/sectorRoom/pilotLedSquad.test.ts` and
 * `ownedShipsSquadPack.test.ts`.
 *
 * Real fighter bodies in a `PhysicsWorld` (the wingman store still re-plans
 * here), flown only through the posted player control bits.
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
  const modeSets: string[] = [];
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
    modeSet: (id) => { modeSets.push(id); },
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
  return { sys, owners, add, run, modeSets };
}

const pos = (id: string) => world.getShipState(id)!;

describe('FleetCommandSubsystem — squads', () => {
  it('a squad-wide move: the leader takes it, the members follow the leader', () => {
    const bx = 0 * 40_000;
    const { sys, add, run, modeSets } = harness();
    const L = add('L', bx, 0);
    const A = add('A', bx + 300, -200);
    const B = add('B', bx - 300, -200);
    sys.formSquad('alice', [L, A, B]);
    run(6);
    expect(sys.squadFollowOf(A)).toBe(L);
    expect(sys.squadFollowOf(B)).toBe(L);
    expect(sys.squadFollowOf(L)).toBeNull();
    // Every role reached the room (the AI pilot brain flies it).
    for (const id of [L, A, B]) expect(modeSets).toContain(id);
    const rows = sys.statusFor('alice');
    expect(rows.every((r) => r.squadLeaderId === L)).toBe(true);

    const target = { x: bx, y: 3000 };
    const acc = sys.applyOrder('alice', [L, A, B], { kind: 'move', ...target });
    expect([...acc].sort()).toEqual([L, A, B].sort());
    expect(sys.brainOf(L)!.order).toEqual({ kind: 'move', ...target });
    expect(sys.brainOf(A)!.order).toBeNull();
    expect(sys.brainOf(B)!.order).toBeNull();
    expect(sys.squadFollowOf(A)).toBe(L);
  });

  it('an order to one member: it goes and stays in the pack; a subset mode takes it out of the squad', () => {
    const bx = 1 * 40_000;
    const { sys, add, run } = harness();
    const L = add('L', bx, 0);
    const A = add('A', bx - 200, -200);
    const B = add('B', bx + 200, -200);
    const { squadId } = sys.formSquad('alice', [L, A, B])!;
    run(6);

    sys.applyOrder('alice', [A], { kind: 'move', x: bx + 2000, y: 0 });
    expect(sys.brainOf(A)!.order).not.toBeNull();
    expect(sys.brainOf(L)!.order).toBeNull();
    expect(sys.squadFollowOf(A), 'still in the pack: it rejoins when the order is done').toBe(L);

    // A standing mode to a subset: that ship leaves; the squad keeps the rest.
    sys.setMode('alice', [B], 'defend', { x: bx + 5000, y: 0 });
    expect(sys.squad(squadId)!.memberIds).toEqual([L, A]);
    expect(sys.squadFollowOf(B)).toBeNull();
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
    expect(sys.brainOf(A)!.mode).toBe('defend'); // members only follow
    sys.setStance('alice', [L, A, B], 'aggressive');
    expect(sys.brainOf(B)!.stance).toBe('aggressive');
    run(6);

    // The leader is gone (reclaimed / destroyed): A leads, flies the patrol; B forms on A.
    sys.detach(L);
    world.despawnShip?.(L);
    expect(sys.squad(squadId)!.leaderId).toBe(A);
    run(6);
    expect(sys.squadFollowOf(A)).toBeNull();
    expect(sys.brainOf(A)!.mode).toBe('patrol');
    expect(sys.brainOf(A)!.patrolRouteLength).toBe(2);
    expect(sys.squadFollowOf(B)).toBe(A);
  });

  it('an Escort squad: every member (the leader too) escorts the ship; leaving Escort they follow the leader again', () => {
    const bx = 5 * 40_000;
    const { sys, add, run, modeSets } = harness();
    const E = add('E', bx + 600, 0);
    const L = add('L', bx, 0);
    const A = add('A', bx - 200, -200);
    const { squadId } = sys.formSquad('alice', [L, A])!;
    run(6);
    expect(sys.escortTargetOf(A)).toBeNull();
    modeSets.length = 0;
    sys.setMode('alice', [L, A], 'escort', { escortId: E });
    expect(sys.squad(squadId)!.mode).toBe('escort');
    run(6);
    expect(sys.escortTargetOf(L)).toBe(E);
    expect(sys.escortTargetOf(A)).toBe(E);
    expect(sys.escortTargetOf(E)).toBeNull();
    // The member's role was re-applied for the squad mode.
    expect(modeSets).toContain(A);
    // A lone ship's own Escort mode.
    sys.setMode('alice', [E], 'escort', { escortId: L });
    expect(sys.escortTargetOf(E)).toBe(L);
    // Back to Defend: the members follow the leader again.
    sys.setMode('alice', [L, A], 'defend');
    run(6);
    expect(sys.escortTargetOf(A)).toBeNull();
    expect(sys.escortTargetOf(L)).toBeNull();
    expect(sys.squadFollowOf(A)).toBe(L);
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
    expect(sys.squadFollowOf(L)).toBe(P);
    expect(sys.squadFollowOf(A)).toBe(P);
    expect(sys.statusFor('alice').every((r) => r.squadLeaderId === P)).toBe(true);

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
    expect(sys.squadFollowOf(P)).toBeNull();
    expect(sys.brainOf(P)!.mode).toBe('defend');
    expect(sys.brainOf(P)!.guardPostX).toBe(bx);
    expect(sys.squadFollowOf(L)).toBe(P);

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
    expect(sys.squadFollowOf(A)).toBe(L);
    sys.disbandSquad('alice', squadId);
    expect(sys.squadFollowOf(A)).toBeNull();
    expect(sys.squadOf(A)).toBeNull();
    run(6);
    expect(sys.brainOf(A)!.mode).toBe('defend');
  });
});
