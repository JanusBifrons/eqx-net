import { describe, it, expect, beforeAll } from 'vitest';
import { PhysicsWorld } from '../physics/World.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { WingmanBehaviour } from './WingmanBehaviour.js';
import { formationSlotOffset, formationSlotWorldPose, makeSlotOffset } from './formation.js';
import { headingOf } from './wingman/intentToControlBits.js';
import {
  reverseAccelFor,
  type WingmanPose,
  type WingmanPoseOut,
  type WingmanShipStats,
  type WingmanWorldView,
} from './wingman/types.js';

/**
 * RTS slice 15b: the formation ROLE (squad members). Real fighter bodies flown
 * only through `World.applyInput`; the leader is a scripted pose in the view.
 */

let world: PhysicsWorld;
let nextId = 0;

beforeAll(async () => {
  world = await PhysicsWorld.create();
});

const ARRIVE = 40;
const GUARD = 300;
const SPACING = 150;

function spawnFighter(x: number, y: number): { id: string; stats: WingmanShipStats } {
  const id = `fm-${nextId++}`;
  world.spawnShip(id, x, y, 'fighter');
  const kind = getShipKind('fighter');
  const stats: WingmanShipStats = {
    maxSpeed: kind.maxSpeed,
    linearDamping: kind.linearDamping,
    maxAngvel: kind.maxAngvel,
    angularDamping: kind.angularDamping,
    turnTorque: kind.turnTorque,
    reverseAccel: reverseAccelFor(kind, world.getBodyMass(id)!),
  };
  return { id, stats };
}

function poseOf(id: string): WingmanPose {
  const s = world.getShipState(id)!;
  return { x: s.x, y: s.y, vx: s.vx, vy: s.vy, angle: s.angle, angvel: s.angvel ?? 0 };
}

interface Leader { x: number; y: number; vx: number; vy: number; angle: number }
type View = { tick: number } & Pick<WingmanWorldView, 'resolvePoseInto'>;

function viewFor(leader: Leader, others: Map<string, WingmanPoseOut> = new Map()): View {
  return {
    tick: 0,
    resolvePoseInto: (id, out) => {
      if (id === 'lead') {
        out.x = leader.x; out.y = leader.y; out.vx = leader.vx; out.vy = leader.vy; out.angle = leader.angle;
        return true;
      }
      const o = others.get(id);
      if (!o) return false;
      out.x = o.x; out.y = o.y; out.vx = o.vx; out.vy = o.vy;
      return true;
    },
  };
}

/** One tick for every member, then the leader moves. */
function stepAll(members: { id: string; b: WingmanBehaviour }[], leader: Leader, view: View): void {
  for (const m of members) world.applyInput(m.id, m.b.tick(poseOf(m.id), view));
  world.tick(1 / 60);
  leader.x += leader.vx / 60;
  leader.y += leader.vy / 60;
  view.tick++;
}

function slotPos(leader: Leader, slot: number, heading: number): { x: number; y: number } {
  const off = formationSlotOffset('wedge', slot, 3, SPACING, makeSlotOffset());
  return formationSlotWorldPose(leader.x, leader.y, heading, off, { x: 0, y: 0 });
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

describe('WingmanBehaviour — formation role', () => {
  it('members converge on their wedge slots behind a moving leader and hold them velocity-matched', () => {
    const bx = 2_000_000;
    const leader: Leader = { x: bx, y: 0, vx: 0, vy: 150, angle: 0 };
    const members = [spawnFighter(bx - 600, -500), spawnFighter(bx + 500, -700)].map(({ id, stats }, i) => {
      const b = new WingmanBehaviour({ stats, arriveRadius: ARRIVE, guardRadius: GUARD });
      b.setFormationSlot('lead', i + 1, 'wedge', 3, SPACING);
      return { id, b };
    });
    const view = viewFor(leader);
    stepAll(members, leader, view);
    expect(members[0]!.b.activity).toBe('formingUp');
    expect(members[0]!.b.formationLeaderId).toBe('lead');

    for (let t = 0; t < 60 * 30 && !members.every((m) => m.b.activity === 'guarding'); t++) stepAll(members, leader, view);
    expect(members.every((m) => m.b.activity === 'guarding')).toBe(true);

    // Hold for 5 s: slot 1 behind-starboard (+x), slot 2 behind-port (−x) of a north-bound leader.
    const heading = headingOf(0, 1);
    let maxErr = 0;
    for (let t = 0; t < 300; t++) {
      stepAll(members, leader, view);
      members.forEach((m, i) => { maxErr = Math.max(maxErr, dist(poseOf(m.id), slotPos(leader, i + 1, heading))); });
    }
    expect(maxErr).toBeLessThan(SPACING * 0.75);
    expect(poseOf(members[0]!.id).x).toBeGreaterThan(leader.x);
    expect(poseOf(members[1]!.id).x).toBeLessThan(leader.x);
    for (const m of members) expect(Math.abs(poseOf(m.id).vy - leader.vy)).toBeLessThan(40);
  });

  it('a parked leader: every member uses its nose to orient the slots', () => {
    const bx = 2_100_000;
    // Nose pointing east (angle −π/2: forward = (−sin, cos) = (1, 0)).
    const leader: Leader = { x: bx, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2 };
    const { id, stats } = spawnFighter(bx + 300, 400);
    const b = new WingmanBehaviour({ stats, arriveRadius: ARRIVE, guardRadius: GUARD });
    b.setFormationSlot('lead', 1, 'wedge', 2, SPACING);
    const view = viewFor(leader);
    for (let t = 0; t < 60 * 20; t++) stepAll([{ id, b }], leader, view);
    // Slot 1 of an east-facing leader: behind (−x) and to starboard (−y).
    const want = slotPos(leader, 1, leader.angle);
    expect(want.x).toBeLessThan(bx);
    expect(want.y).toBeLessThan(0);
    expect(dist(poseOf(id), want)).toBeLessThan(ARRIVE * 2);
    expect(b.activity).toBe('guarding');
  });

  it('an individual order wins, then the member rejoins its slot (not its own mode)', () => {
    const bx = 2_200_000;
    const leader: Leader = { x: bx, y: 0, vx: 0, vy: 100, angle: 0 };
    const { id, stats } = spawnFighter(bx + SPACING, -SPACING);
    const b = new WingmanBehaviour({ stats, arriveRadius: ARRIVE, guardRadius: GUARD, mode: 'defend' });
    b.setFormationSlot('lead', 1, 'wedge', 2, SPACING);
    const view = viewFor(leader);
    const m = [{ id, b }];
    for (let t = 0; t < 60 * 10; t++) stepAll(m, leader, view);
    expect(b.activity).toBe('guarding');

    b.issueOrder({ kind: 'move', x: bx + 1500, y: leader.y });
    stepAll(m, leader, view);
    expect(b.activity).toBe('moving');
    let t = 0;
    for (; t < 60 * 30 && b.order !== null; t++) stepAll(m, leader, view);
    expect(b.order).toBeNull();
    expect(b.formationLeaderId).toBe('lead');
    // Back on station behind the (still moving) leader.
    for (t = 0; t < 60 * 30 && b.activity !== 'guarding'; t++) stepAll(m, leader, view);
    expect(b.activity).toBe('guarding');
    expect(dist(poseOf(id), slotPos(leader, 1, headingOf(0, 1)))).toBeLessThan(SPACING);

    // A stop order: brakes, then rejoins (it does not become a defend post).
    b.issueOrder({ kind: 'stop' });
    for (t = 0; t < 60 * 30 && b.order !== null; t++) stepAll(m, leader, view);
    expect(b.order).toBeNull();
    expect(b.mode).toBe('defend');
    stepAll(m, leader, view);
    // Back in its formation role at once: forming up, or already guarding when
    // the brake left it inside the slot (one mass source, #611: a fighter
    // brakes harder than this test was first tuned for).
    expect(b.formationLeaderId).toBe('lead');
    expect(['formingUp', 'guarding']).toContain(b.activity);
    for (t = 0; t < 60 * 30 && b.activity !== 'guarding'; t++) stepAll(m, leader, view);
    for (t = 0; t < 120; t++) stepAll(m, leader, view);
    expect(b.activity).toBe('guarding');
    expect(dist(poseOf(id), slotPos(leader, 1, headingOf(0, 1)))).toBeLessThan(SPACING);
  });

  it('follows the leader\'s target unless holdFire, then returns to the slot; clearFormation resumes the mode', () => {
    const bx = 2_300_000;
    const leader: Leader = { x: bx, y: 0, vx: 0, vy: 0, angle: 0 };
    const foe: WingmanPoseOut = { x: bx + 1200, y: 600, vx: 0, vy: 0 };
    const { id, stats } = spawnFighter(bx + SPACING, -SPACING);
    const b = new WingmanBehaviour({ stats, arriveRadius: ARRIVE, guardRadius: GUARD });
    b.setFormationSlot('lead', 1, 'wedge', 2, SPACING);
    const view = viewFor(leader, new Map([['foe', foe]]));
    const m = [{ id, b }];

    b.setStance('holdFire');
    b.setLeaderTarget('foe');
    stepAll(m, leader, view);
    expect(b.targetId).toBeNull();

    b.setStance('aggressive');
    stepAll(m, leader, view);
    expect(b.targetId).toBe('foe');
    expect(['chasing', 'attacking']).toContain(b.activity);
    for (let t = 0; t < 60 * 15; t++) stepAll(m, leader, view);
    expect(dist(poseOf(id), foe)).toBeLessThan(GUARD);

    b.setLeaderTarget(null);
    let t = 0;
    for (; t < 60 * 30 && b.activity !== 'guarding'; t++) stepAll(m, leader, view);
    expect(b.targetId).toBeNull();
    expect(b.activity).toBe('guarding');
    expect(dist(poseOf(id), slotPos(leader, 1, b.formationLeaderId !== null ? leader.angle : 0))).toBeLessThan(SPACING);

    // Out of formation: defend resumes from where it is.
    b.clearFormation();
    stepAll(m, leader, view);
    expect(b.formationLeaderId).toBeNull();
    expect(b.mode).toBe('defend');
    expect(dist({ x: b.guardPostX!, y: b.guardPostY! }, poseOf(id))).toBeLessThan(20);
  });

  it('a lost leader: defends where it was lost', () => {
    const { id, stats } = spawnFighter(2_400_000, 0);
    const b = new WingmanBehaviour({ stats, arriveRadius: ARRIVE, guardRadius: GUARD });
    b.setFormationSlot('ghost', 1);
    const view: View = { tick: 0, resolvePoseInto: () => false };
    world.applyInput(id, b.tick(poseOf(id), view));
    expect(b.activity).toBe('guarding');
    expect(b.guardPostX).toBeCloseTo(2_400_000, 0);
  });
});
