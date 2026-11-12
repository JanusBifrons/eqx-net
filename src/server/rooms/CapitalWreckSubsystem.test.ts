/**
 * Capital destruction S2a: the hit tracker + death → wreck spawn decisions,
 * driven with plain mocks (no room, no worker).
 */
import { describe, expect, it } from 'vitest';
import { CapitalWreckSubsystem, type WreckPieceSpawn } from './CapitalWreckSubsystem.js';
import { buildWreckPieces, WRECK_RECENT_DAMAGE_TICKS } from '../../core/destruction/wreckPieces.js';

function make(kinds: Record<string, string> = { cap: 'battleship' }) {
  let tick = 1000;
  const spawned: WreckPieceSpawn[] = [];
  const live = new Set<string>();
  const removed: string[] = [];
  const sys = new CapitalWreckSubsystem({
    serverTick: () => tick,
    capitalKindOf: (id) => (kinds[id] as 'battleship' | undefined) ?? null,
    positionOf: (id) => (id === 'attacker' ? { x: 5000, y: 0 } : null),
    spawnPiece: (s) => { spawned.push(s); live.add(s.id); return true; },
    removePiece: (id) => { live.delete(id); removed.push(id); },
    isLive: (id) => live.has(id),
  });
  return { sys, spawned, removed, setTick: (t: number) => { tick = t; } };
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
});
