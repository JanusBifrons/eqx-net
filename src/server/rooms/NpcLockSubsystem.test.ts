/**
 * NPC lock-to-fire gate: a drone may fire at a pilot only with a COMPLETED
 * lock on THAT pilot. Direction is irrelevant (the old 0.45 rad line-of-fire
 * cone let a shot aimed off a pilot's bearing through unlocked).
 */
import { describe, it, expect } from 'vitest';
import { NpcLockSubsystem, type NpcLockDeps, type NpcPose } from './NpcLockSubsystem.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipLockRange } from '../../core/combat/mountReach.js';
import { LOCKED_BY_WIRE_ROWS } from '../../shared-types/combat/lockProfile.js';

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
    // Owner 2026-11-21: a lock reaches only the NPC's longest gun (hull to
    // hull). Past it the refresh stops at once and the lock breaks after the
    // grace, so the NPC's 30 s forget runs from here.
    pilots.p1!.y = 50_000;
    calls.length = 0;
    for (let i = 0; i < 30; i++) s.step();
    expect(calls).toEqual([]);
    expect(s.isLocked('n1', 'p1')).toBe(false);
    expect(s.wireFor('p1') ?? []).toHaveLength(0);
  });
});

describe('NpcLockSubsystem — lock range is the NPC ship\'s longest gun (owner 2026-11-21)', () => {
  const edge = (npc: string, pilot: string): number =>
    getShipKind(npc).radius + shipLockRange(getShipKind(npc)) + getShipKind(pilot).radius;

  it('a fighter NPC locks a pilot inside its longest gun, never past it', () => {
    const near = rig({ p1: { x: 0, y: 0, kind: 'interceptor' } }, { n1: { x: 0, y: edge('fighter', 'interceptor') - 20, kind: 'fighter' } });
    for (let i = 0; i < 600 && !near.isLocked('n1', 'p1'); i++) near.step();
    expect(near.isLocked('n1', 'p1')).toBe(true);
    const far = rig({ p1: { x: 0, y: 0, kind: 'interceptor' } }, { n1: { x: 0, y: edge('fighter', 'interceptor') + 20, kind: 'fighter' } });
    for (let i = 0; i < 600; i++) far.step();
    expect(far.isLocked('n1', 'p1')).toBe(false);
  });

  it('a battleship NPC locks a pilot 20 km off its hull (its 16" reach), far past a fighter', () => {
    const y = getShipKind('battleship').radius + 20_000;
    const s = rig({ p1: { x: 0, y: 0, kind: 'fighter' } }, { n1: { x: 0, y, kind: 'battleship' } });
    for (let i = 0; i < 6000 && !s.isLocked('n1', 'p1'); i++) s.step();
    expect(s.isLocked('n1', 'p1')).toBe(true);
  });

  it('testMode instantLock does not lift lock range', () => {
    const at = (y: number) => new NpcLockSubsystem({
      pilots: () => ['p1'],
      pilotPose: (_id, out) => { out.x = 0; out.y = 0; out.vx = 0; out.vy = 0; return getShipKind('interceptor'); },
      forEachHostileNpc: (_pid, visit) => visit('n1', 1),
      npcPose: (_id, out) => { out.x = 0; out.y = y; out.vx = 0; out.vy = 0; return getShipKind('fighter'); },
      instantLock: () => true,
    });
    const inside = at(edge('fighter', 'interceptor') - 20);
    inside.step();
    expect(inside.isLocked('n1', 'p1')).toBe(true);
    const past = at(50_000);
    past.step();
    expect(past.isLocked('n1', 'p1')).toBe(false);
  });
});

describe('NpcLockSubsystem — lockedBy rows capped to the nearest threats (owner 2026-11-14)', () => {
  // 20 hostile fighters at shuffled distances 180..1320 u (inside a fighter's lock range).
  const DIST = [1500, 300, 2100, 700, 1100, 1900, 400, 1300, 900, 2200, 500, 1700, 1000, 600, 2000, 800, 1200, 1800, 1400, 1600].map((d) => d * 0.6);
  function crowd(instant: { on: boolean }) {
    const npcs: Record<string, Body> = {};
    DIST.forEach((d, i) => { npcs[`n${i}`] = { x: 0, y: d, kind: 'fighter' }; });
    const ids = new Map<string, number>();
    const write = (b: Body, out: NpcPose) => { out.x = b.x; out.y = b.y; out.vx = 0; out.vy = 0; out.angle = 0; return getShipKind(b.kind); };
    const s = new NpcLockSubsystem({
      pilots: () => ['p1'],
      pilotPose: (_id, out) => write({ x: 0, y: 0, kind: 'interceptor' }, out),
      forEachHostileNpc: (_pid, visit) => {
        for (const id of Object.keys(npcs)) { if (!ids.has(id)) ids.set(id, ids.size + 1); visit(id, ids.get(id)!); }
      },
      npcPose: (id, out) => (npcs[id] ? write(npcs[id]!, out) : null),
      instantLock: () => instant.on,
    });
    return { s, npcs };
  }
  /** Entity keys `s:<i+1>` of the n nearest of DIST. */
  const nearest = (n: number) => DIST.map((d, i) => ({ d, t: `s:${i + 1}` })).sort((a, b) => a.d - b.d).slice(0, n).map((r) => r.t);

  it('20 lockers ⇒ exactly the capped number of rows, the nearest, and a total of 20', () => {
    const { s } = crowd({ on: false });
    s.step();
    const rows = s.wireFor('p1')!;
    expect(LOCKED_BY_WIRE_ROWS).toBeLessThan(20);
    expect(rows).toHaveLength(LOCKED_BY_WIRE_ROWS);
    expect(rows.map((r) => r.t).sort()).toEqual(nearest(LOCKED_BY_WIRE_ROWS).sort());
    expect(s.totalFor('p1')).toBe(20);
  });

  it('completed locks rank before nearer locks still building', () => {
    const instant = { on: true };
    const { s, npcs } = crowd(instant);
    s.step(); // all 20 locked
    instant.on = false;
    for (let i = 0; i < 5; i++) npcs[`c${i}`] = { x: 0, y: 100 + i * 10, kind: 'fighter' }; // nearer, acquiring
    s.step();
    const rows = s.wireFor('p1')!;
    expect(rows).toHaveLength(LOCKED_BY_WIRE_ROWS);
    expect(rows.every((r) => r.s === 2)).toBe(true);
    expect(rows.map((r) => r.t).sort()).toEqual(nearest(LOCKED_BY_WIRE_ROWS).sort());
    expect(s.totalFor('p1')).toBe(25);
    expect(s.lockedTotalFor('p1')).toBe(20); // the 5 nearer ones still acquire
  });

  it('a few completed locks lead, the nearest acquiring ones fill the rest', () => {
    const instant = { on: true };
    const { s, npcs } = crowd(instant);
    // Only the 3 FARTHEST exist on the first step and lock instantly.
    const far = ['n9', 'n2', 'n14']; // 1320, 1260, 1200
    const saved = { ...npcs };
    for (const k of Object.keys(npcs)) if (!far.includes(k)) delete npcs[k];
    s.step();
    instant.on = false;
    Object.assign(npcs, saved);
    s.step();
    const rows = s.wireFor('p1')!;
    expect(rows).toHaveLength(LOCKED_BY_WIRE_ROWS);
    expect(rows.filter((r) => r.s === 2).map((r) => r.t).sort()).toEqual(['s:1', 's:2', 's:3']);
    const acquiring = rows.filter((r) => r.s === 1).map((r) => r.t);
    expect(acquiring).toHaveLength(LOCKED_BY_WIRE_ROWS - 3);
    expect(s.totalFor('p1')).toBe(20);
  });

  it('fewer than the cap: every locker is a row and the total equals the rows', () => {
    const s = rig({ p1: { x: 0, y: 0, kind: 'interceptor' } }, { n1: { x: 0, y: 160, kind: 'fighter' }, n2: { x: 0, y: 400, kind: 'fighter' } });
    s.step();
    expect(s.wireFor('p1')).toHaveLength(2);
    expect(s.totalFor('p1')).toBe(2);
    expect(s.lockedTotalFor('p1')).toBe(s.wireFor('p1')!.filter((r) => r.s === 2).length);
  });
});
