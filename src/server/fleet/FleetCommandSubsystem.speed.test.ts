/**
 * Command speed (the speed telegraph in Command): a Move carries the chosen
 * speed to each ship's own order, and `setMoveSpeed` re-paces the RUNNING
 * Moves of the selection (0 = halt in place, the destination kept), telling
 * the room so the AI pilot brain flies the new pace. Ships with no Move are
 * left alone; foreign ids are dropped.
 */
import { describe, it, expect } from 'vitest';
import { FleetCommandSubsystem, type FleetCommandHooks, type FleetPose } from './FleetCommandSubsystem.js';
import type { FleetOrder } from '../../shared-types/messages/fleetStatusMessages.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

const FIGHTER = { kind: getShipKind('fighter') };

function harness() {
  const owners = new Map<string, string>();
  const poses = new Map<string, FleetPose>();
  const issued: { id: string; order: FleetOrder }[] = [];
  const hooks: FleetCommandHooks = {
    ownerOf: (id) => owners.get(id) ?? null,
    readPose: (id, out) => {
      const p = poses.get(id);
      if (!p) return false;
      Object.assign(out, p);
      return true;
    },
    orderIssued: (id, order) => issued.push({ id, order: { ...order } }),
  };
  const sys = new FleetCommandSubsystem(hooks, { disabled: false });
  const add = (id: string, owner: string, x = 0, y = 0): void => {
    owners.set(id, owner);
    poses.set(id, { x, y, vx: 0, vy: 0, angle: 0, angvel: 0 });
    sys.attach(id, owner, FIGHTER, { x, y });
  };
  return { sys, add, issued };
}

const moveOf = (sys: FleetCommandSubsystem, id: string) =>
  sys.ordersOf(id)!.order as { kind: 'move'; x: number; y: number; speed?: number };

describe('FleetCommandSubsystem — Command speed', () => {
  it('a Move carries its speed to every ship (alone and spread); absent = full', () => {
    const { sys, add } = harness();
    add('a', 'alice', 0, 0);
    add('b', 'alice', 0, 300);
    sys.applyOrder('alice', ['a'], { kind: 'move', x: 1000, y: 0, speed: 1 / 3 });
    expect(moveOf(sys, 'a')).toMatchObject({ x: 1000, y: 0, speed: 1 / 3 });
    sys.applyOrder('alice', ['a', 'b'], { kind: 'move', x: 5000, y: 0, speed: 2 / 3 });
    expect(moveOf(sys, 'a').speed).toBe(2 / 3);
    expect(moveOf(sys, 'b').speed).toBe(2 / 3);
    sys.applyOrder('alice', ['a'], { kind: 'move', x: 10, y: 10 });
    expect(moveOf(sys, 'a').speed).toBe(1);
  });

  it('setMoveSpeed re-paces running Moves, keeps each destination, and re-issues them', () => {
    const { sys, add, issued } = harness();
    add('a', 'alice', 0, 0);
    add('b', 'alice', 0, 300);
    add('idle', 'alice', 50, 50);
    sys.applyOrder('alice', ['a', 'b'], { kind: 'move', x: 5000, y: 0 });
    const destA = { x: moveOf(sys, 'a').x, y: moveOf(sys, 'a').y };
    issued.length = 0;
    const acc = sys.setMoveSpeed('alice', ['a', 'b', 'idle'], 0);
    expect([...acc].sort()).toEqual(['a', 'b', 'idle']);
    expect(moveOf(sys, 'a')).toMatchObject({ kind: 'move', ...destA, speed: 0 });
    expect(issued.map((i) => i.id).sort(), 'only the moving ships are re-issued').toEqual(['a', 'b']);
    expect(issued.every((i) => i.order.kind === 'move' && i.order.speed === 0)).toBe(true);
    expect(sys.ordersOf('idle')!.order, 'an idle ship takes no order').toBeNull();
    sys.setMoveSpeed('alice', ['a'], 1);
    expect(moveOf(sys, 'a')).toMatchObject({ ...destA, speed: 1 });
  });

  it('setMoveSpeed ignores foreign ships', () => {
    const { sys, add, issued } = harness();
    add('a', 'alice');
    add('m', 'mallory');
    sys.applyOrder('mallory', ['m'], { kind: 'move', x: 100, y: 0 });
    issued.length = 0;
    expect(sys.setMoveSpeed('alice', ['m', 'a'], 0)).toEqual(['a']);
    expect(issued).toEqual([]);
    expect(moveOf(sys, 'm').speed).toBe(1);
  });
});
