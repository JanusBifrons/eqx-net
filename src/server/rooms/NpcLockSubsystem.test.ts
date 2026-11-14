/**
 * NPC lock-to-fire gate: a drone may fire at a pilot only with a COMPLETED
 * lock on THAT pilot. Direction is irrelevant (the old 0.45 rad line-of-fire
 * cone let a shot aimed off a pilot's bearing through unlocked).
 */
import { describe, it, expect } from 'vitest';
import { NpcLockSubsystem, type NpcLockDeps, type NpcPose } from './NpcLockSubsystem.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

interface Body { x: number; y: number; kind: string; vy?: number }

function rig(pilots: Record<string, Body>, npcs: Record<string, Body>) {
  const write = (b: Body, out: NpcPose) => { out.x = b.x; out.y = b.y; out.vx = 0; out.vy = b.vy ?? 0; out.angle = 0; return getShipKind(b.kind); };
  const ids = Object.keys(pilots);
  const deps: NpcLockDeps = {
    pilots: () => ids,
    pilotPose: (id, out) => (pilots[id] ? write(pilots[id]!, out) : null),
    forEachHostileNpc: (_pid, visit) => { let e = 1; for (const id of Object.keys(npcs)) visit(id, e++); },
    npcPose: (id, out) => (npcs[id] ? write(npcs[id]!, out) : null),
  };
  return new NpcLockSubsystem(deps);
}

function stepUntilLocked(s: NpcLockSubsystem, npcId: string, pilotId: string): void {
  for (let i = 0; i < 200 && !s.isLocked(npcId, pilotId); i++) s.step();
  expect(s.isLocked(npcId, pilotId)).toBe(true);
}

describe('NpcLockSubsystem — drones fire only with a completed lock on their target', () => {
  it('blocks a shot at a pilot until the lock on that pilot completes, then allows it', () => {
    const s = rig({ p1: { x: 0, y: 0, kind: 'interceptor' } }, { n1: { x: 0, y: 160, kind: 'fighter' } });
    // Not stepped yet: the pilot is tracked but no lock exists.
    expect(s.fireBlocked('n1', 'p1')).toBe(true);
    s.step();
    expect(s.isLocked('n1', 'p1')).toBe(false);
    expect(s.fireBlocked('n1', 'p1')).toBe(true); // acquiring is not enough
    stepUntilLocked(s, 'n1', 'p1');
    expect(s.fireBlocked('n1', 'p1')).toBe(false);
  });

  it('a lock on one pilot does not license a shot at another (the "aimed elsewhere" gap)', () => {
    // p2 crosses far too fast to track: it is never locked, wherever the shot points.
    const s = rig(
      { p1: { x: 0, y: 0, kind: 'interceptor' }, p2: { x: 1000, y: 0, kind: 'interceptor', vy: 50_000 } },
      { n1: { x: 0, y: 160, kind: 'fighter' } },
    );
    stepUntilLocked(s, 'n1', 'p1');
    expect(s.isLocked('n1', 'p2')).toBe(false);
    expect(s.fireBlocked('n1', 'p2')).toBe(true);
    expect(s.fireBlocked('n1', 'p1')).toBe(false);
  });

  it('another NPC\'s lock does not count', () => {
    const s = rig({ p1: { x: 0, y: 0, kind: 'interceptor' } }, { n1: { x: 0, y: 160, kind: 'fighter' } });
    stepUntilLocked(s, 'n1', 'p1');
    expect(s.fireBlocked('n2', 'p1')).toBe(true);
  });

  it('non-pilot targets (NPCs, structures) are unchanged: not gated', () => {
    const s = rig({ p1: { x: 0, y: 0, kind: 'interceptor' } }, { n1: { x: 0, y: 160, kind: 'fighter' } });
    s.step();
    expect(s.fireBlocked('n1', 'drone-7')).toBe(false);
    expect(s.fireBlocked('n1', 'struct-3')).toBe(false);
  });
});

describe('NpcLockSubsystem — its own lock keeps the NPC hostile (owner 2026-11-12)', () => {
  it('refreshes hostility every step while locking or locked in FIRE range; outside it the lock holds but the refresh stops', () => {
    const pilots: Record<string, Body> = { p1: { x: 0, y: 0, kind: 'interceptor' } };
    const npcs: Record<string, Body> = { n1: { x: 0, y: 160, kind: 'fighter' } };
    const calls: string[] = [];
    const write = (b: Body, out: NpcPose) => { out.x = b.x; out.y = b.y; out.vx = 0; out.vy = b.vy ?? 0; out.angle = 0; return getShipKind(b.kind); };
    const s = new NpcLockSubsystem({
      pilots: () => ['p1'],
      pilotPose: (id, out) => (pilots[id] ? write(pilots[id]!, out) : null),
      forEachHostileNpc: (_pid, visit) => visit('n1', 1),
      npcPose: (id, out) => (npcs[id] ? write(npcs[id]!, out) : null),
      refreshHostility: (npcId, pid) => { calls.push(`${npcId}>${pid}`); },
    });
    s.step();
    expect(s.isLocked('n1', 'p1')).toBe(false);
    expect(calls).toEqual(['n1>p1']); // acquiring counts
    stepUntilLocked(s, 'n1', 'p1');
    const n = calls.length;
    s.step();
    expect(calls.length).toBe(n + 1); // locked counts
    // Owner 2026-11-14: locks work at any distance, so the NPC keeps its lock
    // far out of reach; but (lead call) only a lock inside the NPC's FIRE
    // range keeps it hostile, so its 30 s forget runs from here.
    pilots.p1!.y = 50_000;
    calls.length = 0;
    for (let i = 0; i < 30; i++) s.step();
    expect(calls).toEqual([]);
    expect(s.isLocked('n1', 'p1')).toBe(true);
    expect(s.wireFor('p1')).toHaveLength(1);
  });
});

describe('NpcLockSubsystem — locks at any distance (owner 2026-11-14)', () => {
  it('an NPC locks a pilot far past every gun\'s reach, slowly', () => {
    const near = rig({ p1: { x: 0, y: 0, kind: 'interceptor' } }, { n1: { x: 0, y: 160, kind: 'fighter' } });
    let nearSteps = 0;
    while (!near.isLocked('n1', 'p1') && nearSteps < 600) { near.step(); nearSteps++; }
    const far = rig({ p1: { x: 0, y: 0, kind: 'interceptor' } }, { n1: { x: 0, y: 50_000, kind: 'fighter' } });
    let farSteps = 0;
    while (!far.isLocked('n1', 'p1') && farSteps < 600) { far.step(); farSteps++; }
    expect(far.isLocked('n1', 'p1')).toBe(true);
    expect(farSteps).toBeGreaterThan(nearSteps);
  });

  it('testMode instantLock completes an NPC lock at any distance', () => {
    const s = new NpcLockSubsystem({
      pilots: () => ['p1'],
      pilotPose: (_id, out) => { out.x = 0; out.y = 0; out.vx = 0; out.vy = 0; return getShipKind('interceptor'); },
      forEachHostileNpc: (_pid, visit) => visit('n1', 1),
      npcPose: (_id, out) => { out.x = 0; out.y = 50_000; out.vx = 0; out.vy = 0; return getShipKind('fighter'); },
      instantLock: () => true,
    });
    s.step();
    expect(s.isLocked('n1', 'p1')).toBe(true);
  });
});
