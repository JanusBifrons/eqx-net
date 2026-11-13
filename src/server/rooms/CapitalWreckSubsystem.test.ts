/**
 * Capital destruction S2a: the hit tracker + death → wreck spawn decisions,
 * driven with plain mocks (no room, no worker).
 */
import { describe, expect, it } from 'vitest';
import { CapitalWreckSubsystem, type WreckPieceSpawn } from './CapitalWreckSubsystem.js';
import { buildWreckPieces, WRECK_RECENT_DAMAGE_TICKS } from '../../core/destruction/wreckPieces.js';
import { wreckCrackTicks } from '../../shared-types/wreckTiming.js';

function make(kinds: Record<string, string> = { cap: 'battleship' }) {
  let tick = 1000;
  const spawned: WreckPieceSpawn[] = [];
  const live = new Set<string>();
  const removed: string[] = [];
  const angles = new Map<string, number>();
  const kicks: Array<{ id: string; dvx: number; dvy: number; dw: number; tick: number }> = [];
  const sys = new CapitalWreckSubsystem({
    serverTick: () => tick,
    capitalKindOf: (id) => (kinds[id] as 'battleship' | undefined) ?? null,
    positionOf: (id) => (id === 'attacker' ? { x: 5000, y: 0 } : null),
    spawnPiece: (s) => { spawned.push(s); live.add(s.id); return true; },
    removePiece: (id) => { live.delete(id); removed.push(id); },
    isLive: (id) => live.has(id),
    pieceAngle: (id) => (live.has(id) ? angles.get(id) ?? 0 : null),
    kickPiece: (id, dvx, dvy, dw) => { kicks.push({ id, dvx, dvy, dw, tick }); },
  });
  return { sys, spawned, removed, kicks, angles, live, setTick: (t: number) => { tick = t; } };
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
});
