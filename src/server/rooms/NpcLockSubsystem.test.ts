/**
 * NPC lock-to-fire gate: a drone may fire at a pilot only with a COMPLETED
 * lock on THAT pilot. Direction is irrelevant (the old 0.45 rad line-of-fire
 * cone let a shot aimed off a pilot's bearing through unlocked).
 */
import { describe, it, expect } from 'vitest';
import { NpcLockSubsystem, type NpcLockDeps, type NpcPose } from './NpcLockSubsystem.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

interface Body { x: number; y: number; kind: string }

function rig(pilots: Record<string, Body>, npcs: Record<string, Body>) {
  const write = (b: Body, out: NpcPose) => { out.x = b.x; out.y = b.y; out.vx = 0; out.vy = 0; return getShipKind(b.kind); };
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
    // p2 is far out of the drone's reach: it is never locked, wherever the shot points.
    const s = rig(
      { p1: { x: 0, y: 0, kind: 'interceptor' }, p2: { x: 50_000, y: 0, kind: 'interceptor' } },
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
