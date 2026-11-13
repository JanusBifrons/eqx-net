/**
 * Capital destruction S2a: the hit tracker + death → wreck spawn decisions,
 * driven with plain mocks (no room, no worker).
 */
import { describe, expect, it } from 'vitest';
import { CapitalWreckSubsystem, type WreckPieceSpawn } from './CapitalWreckSubsystem.js';
import { buildWreckPieces, WRECK_ANGULAR_DAMPING, WRECK_LINEAR_DAMPING, WRECK_RECENT_DAMAGE_TICKS } from '../../core/destruction/wreckPieces.js';
import { SUBCAP_WRECK_COLLISION_GROUPS, WRECK_COLLISION_GROUPS } from '../../core/physics/collisionGroups.js';
import { DESTRUCTION_PROFILES } from '../../shared-types/shipScale/destruction.js';
import { wreckCrackTicks } from '../../shared-types/wreckTiming.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';

function make(kinds: Record<string, string> = { cap: 'battleship' }, withRigid = false) {
  const rigid: Array<{ ids: readonly string[]; jx: number; jy: number; px: number; py: number }> = [];
  let tick = 1000;
  const spawned: WreckPieceSpawn[] = [];
  const live = new Set<string>();
  const removed: string[] = [];
  const angles = new Map<string, number>();
  const kicks: Array<{ id: string; dvx: number; dvy: number; dw: number; tick: number }> = [];
  const impulses: Array<{ id: string; jx: number; jy: number; px: number; py: number }> = [];
  const sys = new CapitalWreckSubsystem({
    serverTick: () => tick,
    wreckKindOf: (id) => (kinds[id] as 'battleship' | undefined) ?? null,
    positionOf: (id) => (id === 'attacker' ? { x: 5000, y: 0 } : null),
    spawnPiece: (s) => { spawned.push(s); live.add(s.id); return true; },
    removePiece: (id) => { live.delete(id); removed.push(id); },
    isLive: (id) => live.has(id),
    pieceAngle: (id) => (live.has(id) ? angles.get(id) ?? 0 : null),
    kickPiece: (id, dvx, dvy, dw) => { kicks.push({ id, dvx, dvy, dw, tick }); },
    impulsePiece: (id, jx, jy, px, py) => { impulses.push({ id, jx, jy, px, py }); },
    ...(withRigid ? { impulseWreck: (ids: readonly string[], jx: number, jy: number, px: number, py: number) => { rigid.push({ ids, jx, jy, px, py }); } } : {}),
  });
  return { sys, spawned, removed, kicks, impulses, rigid, angles, live, setTick: (t: number) => { tick = t; } };
}

const pose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };

describe('CapitalWreckSubsystem', () => {
  it('feeds the last hit point, the final blow and the recent damage into the fracture', () => {
    const { sys, spawned, setTick } = make();
    sys.forcedSeed = 9;
    setTick(100);
    sys.noteHit('cap', 'attacker', 500, 10, 20); // long ago: outside the window
    setTick(100 + WRECK_RECENT_DAMAGE_TICKS * 3);
    sys.noteHit('cap', 'attacker', 1000, 300, -200);
    sys.noteHit('cap', 'attacker', 2000, 120, 40);
    const n = sys.onDeath('cap', 'battleship', pose, 10_000);
    const want = buildWreckPieces({
      kindId: 'battleship', pose, killWorld: { x: 120, y: 40 }, attackerWorld: { x: 5000, y: 0 },
      seed: 9, killBlowDamage: 0.2, recentDamageRate: 0.3,
    }).pieces;
    expect(n).toBe(want.length);
    expect(spawned.map((s) => [s.x, s.y, s.vx, s.vy])).toEqual(want.map((p) => [p.x, p.y, p.vx, p.vy]));
  });

  it('ignores hits on non-capitals and breaks a hull once per death tick', () => {
    const { sys, spawned } = make();
    sys.noteHit('fighter', 'attacker', 50, 0, 0);
    expect(sys.onDeath('cap', 'battleship', pose, 10_000)).toBeGreaterThan(0);
    const first = spawned.length;
    expect(sys.onDeath('cap', 'battleship', pose, 10_000)).toBe(0);
    expect(spawned.length).toBe(first);
  });

  it('with no hit point the kill point is the hull edge nearest the attacker', () => {
    const { sys, spawned } = make();
    sys.forcedSeed = 3;
    sys.noteHit('cap', 'attacker', 100_000, undefined, undefined);
    sys.onDeath('cap', 'battleship', pose, 10_000);
    const want = buildWreckPieces({
      kindId: 'battleship', pose, killWorld: { x: 5000, y: 0 }, attackerWorld: null,
      seed: 3, killBlowDamage: 10, recentDamageRate: 10,
    }).pieces;
    expect(spawned.length).toBe(want.length);
  });

  it('holds the pieces together for the crack delay (game ticks), then kicks each once, turned with the hull', () => {
    const { sys, spawned, kicks, angles, live, setTick } = make();
    sys.forcedSeed = 9;
    setTick(2000);
    sys.noteHit('cap', 'attacker', 2000, 120, 40);
    const deathPose = { ...pose, angle: 0.3 };
    const n = sys.onDeath('cap', 'battleship', deathPose, 10_000);
    const want = buildWreckPieces({
      kindId: 'battleship', pose: deathPose, killWorld: { x: 120, y: 40 }, attackerWorld: { x: 5000, y: 0 },
      seed: 9, killBlowDamage: 0.2, recentDamageRate: 0.2,
    }).pieces;
    expect(n).toBe(want.length);
    // Spawned with the dead hull's rigid motion (at rest here): no kick yet.
    for (const s of spawned) expect([s.vx, s.vy, s.angvel]).toEqual([0, 0, 0]);
    setTick(2000 + wreckCrackTicks() - 1);
    sys.tick();
    expect(kicks).toHaveLength(0);
    // One piece is gone before the split; another has turned 0.5 rad.
    live.delete(spawned[0]!.id);
    angles.set(spawned[1]!.id, 0.3 + 0.5);
    setTick(2000 + wreckCrackTicks());
    sys.tick();
    expect(kicks).toHaveLength(n - 1);
    expect(sys.pendingKicks()).toBe(0);
    const k1 = kicks.find((k) => k.id === spawned[1]!.id)!;
    const p1 = want[1]!;
    expect(k1.dvx).toBeCloseTo(p1.kickVx * Math.cos(0.5) - p1.kickVy * Math.sin(0.5), 9);
    expect(k1.dvy).toBeCloseTo(p1.kickVx * Math.sin(0.5) + p1.kickVy * Math.cos(0.5), 9);
    expect(k1.dw).toBe(p1.kickAngvel);
    sys.tick();
    expect(kicks).toHaveLength(n - 1); // once only
  });

  it('an overkill hit on a piece posts an impulse along the shot at the hit point, capped at wreckKnockMax', () => {
    const { sys, spawned: pieces, impulses } = make();
    sys.forcedSeed = 9;
    const maxHull = 10_000;
    sys.onDeath('cap', 'battleship', pose, maxHull);
    const hullMass = pieces.reduce((s, p) => s + p.mass, 0);
    const t = shipTuning(getShipKind('battleship'));
    const big = pieces.reduce((a, b) => (b.mass > a.mass ? b : a));
    const small = pieces.reduce((a, b) => (b.mass < a.mass ? b : a));

    // A 16" shell on the biggest piece: J = damage × hull mass × knock ÷ max hull, along the shot.
    expect(sys.onWreckHit(big.id, 10, 20, 3, 4, 1400)).toBe(true);
    const j = 1400 * hullMass * t.wreckKnockSpeed / maxHull;
    expect(impulses[0]!.id).toBe(big.id);
    expect(impulses[0]!.jx).toBeCloseTo(j * 0.6, 6);
    expect(impulses[0]!.jy).toBeCloseTo(j * 0.8, 6);
    expect([impulses[0]!.px, impulses[0]!.py]).toEqual([10, 20]);
    expect(j / big.mass).toBeLessThan(t.wreckKnockMax);

    // A huge blow on the smallest piece is capped: its speed change is wreckKnockMax.
    expect(sys.onWreckHit(small.id, 0, 0, 1, 0, 1e7)).toBe(true);
    expect(impulses[1]!.jx / small.mass).toBeCloseTo(t.wreckKnockMax, 6);

    // Not a piece, no damage, no direction, or gone: nothing.
    expect(sys.onWreckHit('cap', 0, 0, 1, 0, 1400)).toBe(false);
    expect(sys.onWreckHit(big.id, 0, 0, 1, 0, 0)).toBe(false);
    expect(sys.onWreckHit(big.id, 0, 0, 0, 0, 1400)).toBe(false);
    sys.pieceGone(big.id);
    expect(sys.onWreckHit(big.id, 0, 0, 1, 0, 1400)).toBe(false);
    expect(impulses).toHaveLength(2);
  });

  it('during the crack hold a hit shoves the WHOLE wreck as one body; after it, only the piece hit', () => {
    const { sys, spawned: pieces, impulses, rigid, setTick } = make({ cap: 'battleship' }, true);
    sys.forcedSeed = 9;
    const maxHull = 10_000;
    setTick(5000);
    sys.onDeath('cap', 'battleship', pose, maxHull);
    const hullMass = pieces.reduce((s, p) => s + p.mass, 0);
    const t = shipTuning(getShipKind('battleship'));
    const small = pieces.reduce((a, b) => (b.mass < a.mass ? b : a));
    const j = 1400 * hullMass * t.wreckKnockSpeed / maxHull;

    // Inside the hold: every piece of the wreck, the same impulse, nothing single.
    setTick(5000 + wreckCrackTicks() - 1);
    expect(sys.onWreckHit(small.id, 10, 20, 3, 4, 1400)).toBe(true);
    expect(impulses).toHaveLength(0);
    expect(rigid).toHaveLength(1);
    expect([...rigid[0]!.ids].sort()).toEqual(pieces.map((p) => p.id).sort());
    expect(rigid[0]!.jx).toBeCloseTo(j * 0.6, 6);
    expect(rigid[0]!.jy).toBeCloseTo(j * 0.8, 6);
    expect([rigid[0]!.px, rigid[0]!.py]).toEqual([10, 20]);
    // The cap is on the whole wreck's speed change.
    expect(sys.onWreckHit(small.id, 0, 0, 1, 0, 1e9)).toBe(true);
    expect(rigid[1]!.jx / hullMass).toBeCloseTo(t.wreckKnockMax, 6);

    // From the split on: the piece alone (#542).
    setTick(5000 + wreckCrackTicks());
    expect(sys.onWreckHit(small.id, 0, 0, 1, 0, 1400)).toBe(true);
    expect(rigid).toHaveLength(2);
    expect(impulses).toHaveLength(1);
    expect(impulses[0]!.id).toBe(small.id);
  });
});

describe('CapitalWreckSubsystem — sub-capital profile (sub-cap break-up slice 2)', () => {
  it('a sub-capital parts at once: the kick is in the spawn motion, no pending kick, no rigid hold', () => {
    const { sys, spawned, kicks, rigid, impulses } = make({ f: 'fighter' }, true);
    sys.forcedSeed = 11;
    const at = { x: 100, y: -50, vx: 30, vy: -10, angle: 0.4, angvel: 0.5 };
    const n = sys.onDeath('f', 'fighter', at, 1000);
    const want = buildWreckPieces({ kindId: 'fighter', pose: at, killWorld: null, attackerWorld: null, seed: 11, killBlowDamage: 0, recentDamageRate: 0 }).pieces;
    expect(n).toBe(want.length);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(3);
    expect(sys.pendingKicks()).toBe(0);
    for (let i = 0; i < n; i++) {
      expect(spawned[i]!.vx).toBeCloseTo(want[i]!.vx + want[i]!.kickVx, 9);
      expect(spawned[i]!.vy).toBeCloseTo(want[i]!.vy + want[i]!.kickVy, 9);
      expect(spawned[i]!.angvel).toBeCloseTo(want[i]!.angvel + want[i]!.kickAngvel, 9);
      // The profile's body: damped ×10, pieces ignore each other.
      expect(spawned[i]!.collisionGroups).toBe(SUBCAP_WRECK_COLLISION_GROUPS);
      expect(spawned[i]!.linearDamping).toBeCloseTo(WRECK_LINEAR_DAMPING * DESTRUCTION_PROFILES.subcap.dampingScale, 12);
    }
    sys.tick();
    expect(kicks).toHaveLength(0);
    // A hit right after the kill shoves the single piece (overkill knock-back),
    // never the whole wreck: there is no hold.
    expect(sys.onWreckHit(spawned[0]!.id, 0, 0, 1, 0, 500)).toBe(true);
    expect(rigid).toHaveLength(0);
    expect(impulses).toHaveLength(1);
  });

  it('a capital keeps its hold, collides and is damped as before', () => {
    const { sys, spawned } = make();
    sys.onDeath('cap', 'battleship', pose, 10_000);
    expect(sys.pendingKicks()).toBe(spawned.length);
    for (const s of spawned) {
      expect(s.collisionGroups).toBe(WRECK_COLLISION_GROUPS);
      expect(s.linearDamping).toBe(WRECK_LINEAR_DAMPING);
      expect(s.angularDamping).toBe(WRECK_ANGULAR_DAMPING);
    }
  });

  it('the sub-cap FIFO evicts its own oldest pieces and never a capital piece', () => {
    const kinds: Record<string, string> = { cap: 'battleship' };
    for (let i = 0; i < 6; i++) kinds[`f${i}`] = 'fighter';
    const { sys, spawned, removed, setTick } = make(kinds);
    sys.subcapCapOverride = 5;
    sys.onDeath('cap', 'battleship', pose, 10_000);
    const capital = spawned.map((s) => s.id);
    const perDeath: string[][] = [];
    for (let i = 0; i < 6; i++) {
      setTick(2000 + i);
      const before = spawned.length;
      sys.onDeath(`f${i}`, 'fighter', { ...pose, x: i * 500 }, 1000);
      perDeath.push(spawned.slice(before).map((s) => s.id));
    }
    expect(sys.liveSubcapCount()).toBe(5);
    expect(sys.liveCount()).toBe(capital.length + 5);
    for (const id of capital) expect(removed).not.toContain(id);
    // Oldest first: the evicted ids are a prefix of the sub-cap spawn order.
    const order = perDeath.flat();
    expect(removed).toEqual(order.slice(0, removed.length));
    expect(removed.length).toBe(order.length - 5);
  });
});
