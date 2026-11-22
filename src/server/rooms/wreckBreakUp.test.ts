/**
 * Structure break-up T1: the server death path (`onDeath` → `breakUpWreck` →
 * `spawnWreck`, hit tracking included) takes any `WreckSource`, not only a
 * ship kind. Plain mocks, no room, no worker.
 */
import { describe, expect, it } from 'vitest';
import { CapitalWreckSubsystem, type WreckPieceSpawn } from './CapitalWreckSubsystem.js';
import type { CapitalWreckDeps } from './capitalWreckTypes.js';
import { ROCK_WRECK_PARENT_KIND, rockWreckSource, shipWreckSource, type WreckSource } from '../../core/destruction/wreckSource.js';
import type { ShipKindId } from '../../shared-types/shipKinds.js';

function make(sourceOf: (id: string) => ShipKindId | WreckSource | null) {
  const spawned: WreckPieceSpawn[] = [];
  const live = new Set<string>();
  const deps: CapitalWreckDeps = {
    serverTick: () => 1000,
    wreckKindOf: sourceOf,
    positionOf: (id) => (id === 'attacker' ? { x: 5000, y: 0 } : null),
    spawnPiece: (s) => { spawned.push(s); live.add(s.id); return true; },
    removePiece: (id) => { live.delete(id); },
    isLive: (id) => live.has(id),
    pieceAngle: () => 0,
    kickPiece: () => {},
    impulsePiece: () => {},
  };
  const sys = new CapitalWreckSubsystem(deps);
  sys.forcedSeed = 11;
  return { sys, spawned };
}

const pose = { x: 100, y: -50, vx: 0, vy: 0, angle: 0.4, angvel: 0 };

describe('breakUpWreck: any wreck source', () => {
  it('breaks a non-ship source (a rock) through onDeath into pieces', () => {
    const src = rockWreckSource({ id: 'rock-7', shape: 7, r: 300 });
    const { sys, spawned } = make((id) => (id === 'thing' ? src : null));
    sys.noteHit('thing', 'attacker', 400, 120, -40);
    let despawns = 0;
    const out = sys.onDeath('thing', src, pose, src.maxHull, () => { despawns++; });
    expect(out.vaporised).toBe(false);
    expect(out.pieces).toBeGreaterThan(1);
    expect(spawned).toHaveLength(out.pieces);
    expect(despawns).toBe(1);
    for (const p of spawned) expect(p.parentShipKind).toBeUndefined();
    const [desc] = sys.descriptors();
    expect(desc?.parentKind).toBe(ROCK_WRECK_PARENT_KIND);
    expect(desc?.rock?.id).toBe('rock-7');
    expect(sys.lastHit('thing')).toBeNull(); // the hit record was consumed
  });

  it('a ship kind and its WreckSource break identically', () => {
    const a = make(() => 'battleship');
    const b = make(() => shipWreckSource('battleship'));
    for (const { sys } of [a, b]) sys.noteHit('cap', 'attacker', 2000, 120, 40);
    const na = a.sys.onDeath('cap', 'battleship', pose, 10_000).pieces;
    const nb = b.sys.onDeath('cap', shipWreckSource('battleship'), pose, 10_000).pieces;
    expect(nb).toBe(na);
    expect(b.spawned).toEqual(a.spawned);
    expect(b.sys.descriptors()).toEqual(a.sys.descriptors());
  });
});
