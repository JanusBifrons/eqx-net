import { describe, it, expect } from 'vitest';
import { SquadPool, SQUAD_SIZE, LIVING_WORLD_SQUAD_COUNT } from './SquadPool.js';

function botIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `lwbot-${i}`);
}

describe('SquadPool — seeding', () => {
  it('partitions bots into homogeneous squads of SQUAD_SIZE', () => {
    const pool = new SquadPool();
    pool.seed(botIds(LIVING_WORLD_SQUAD_COUNT * SQUAD_SIZE), 'sol-prime', () => 'fighter');
    const squads = [...pool.all()];
    expect(squads).toHaveLength(LIVING_WORLD_SQUAD_COUNT);
    for (const sq of squads) {
      expect(sq.botIds).toHaveLength(SQUAD_SIZE);
      expect(sq.kind).toBe('fighter');
      expect(sq.state).toBe('forming');
      expect(sq.sectorKey).toBe('sol-prime');
      expect(sq.targetFactionId).toBeNull();
    }
  });

  it('every member maps back to its squad (squadOf)', () => {
    const pool = new SquadPool();
    pool.seed(botIds(LIVING_WORLD_SQUAD_COUNT * SQUAD_SIZE), 'sol-prime', () => 'fighter');
    expect(pool.squadOf('lwbot-0')?.squadId).toBe('squad-0');
    expect(pool.squadOf('lwbot-8')?.squadId).toBe('squad-1');
    expect(pool.squadOf('lwbot-999')).toBeUndefined();
  });

  it('re-seeding clears prior squads + index', () => {
    const pool = new SquadPool();
    pool.seed(botIds(16), 'a', () => 'fighter');
    pool.seed(botIds(8), 'b', () => 'scout');
    // Second seed: 8 ids → squad-0 full (8), squad-1 + squad-2 empty.
    expect(pool.get('squad-0')?.botIds).toHaveLength(SQUAD_SIZE);
    expect(pool.get('squad-1')?.botIds).toHaveLength(0);
    expect(pool.get('squad-0')?.kind).toBe('scout');
    expect(pool.squadOf('lwbot-0')?.sectorKey).toBe('b');
  });

  it('tolerates fewer bots than capacity (partial squads)', () => {
    const pool = new SquadPool();
    pool.seed(botIds(10), 'a', () => 'fighter'); // 8 + 2
    expect(pool.get('squad-0')?.botIds).toHaveLength(8);
    expect(pool.get('squad-1')?.botIds).toHaveLength(2);
    expect(pool.get('squad-2')?.botIds).toHaveLength(0);
  });
});

describe('SquadPool — state + targeting', () => {
  const seeded = (): SquadPool => {
    const pool = new SquadPool();
    pool.seed(botIds(LIVING_WORLD_SQUAD_COUNT * SQUAD_SIZE), 'sol-prime', () => 'fighter');
    return pool;
  };

  it('assignTarget sets sector + faction; clearTarget drops the faction', () => {
    const pool = seeded();
    const sq = pool.get('squad-0')!;
    pool.assignTarget(sq, 'vega', 'alice');
    expect(sq.sectorKey).toBe('vega');
    expect(sq.targetFactionId).toBe('alice');
    pool.clearTarget(sq);
    expect(sq.targetFactionId).toBeNull();
    expect(sq.sectorKey).toBe('vega'); // sector retained until next move
  });

  it('setState transitions the squad brain', () => {
    const pool = seeded();
    const sq = pool.get('squad-0')!;
    pool.setState(sq, 'warping');
    expect(sq.state).toBe('warping');
  });

  it('activeMemberCount counts only members passing the predicate', () => {
    const pool = seeded();
    const sq = pool.get('squad-0')!;
    const alive = new Set(['lwbot-0', 'lwbot-1', 'lwbot-3']);
    expect(pool.activeMemberCount(sq, (id) => alive.has(id))).toBe(3);
  });
});

describe('SquadPool — squad-aware respawn (hostile-review C4)', () => {
  it('a member respawns into its squad sector once the squad is committed', () => {
    const pool = new SquadPool();
    pool.seed(botIds(8), 'sol-prime', () => 'fighter');
    const sq = pool.get('squad-0')!;
    // forming ⇒ no committed sector ⇒ ambient fallback (null).
    expect(pool.respawnSectorFor('lwbot-0')).toBeNull();
    // Committed to an attack on 'vega' ⇒ respawning members rejoin there.
    pool.assignTarget(sq, 'vega', 'alice');
    pool.setState(sq, 'attacking');
    expect(pool.respawnSectorFor('lwbot-0')).toBe('vega');
  });

  it('an unassigned bot falls back to the ambient picker (null)', () => {
    const pool = new SquadPool();
    pool.seed(botIds(8), 'sol-prime', () => 'fighter');
    expect(pool.respawnSectorFor('lwbot-999')).toBeNull();
  });
});

describe('SquadPool — snapshot', () => {
  it('counts squads by state', () => {
    const pool = new SquadPool();
    pool.seed(botIds(LIVING_WORLD_SQUAD_COUNT * SQUAD_SIZE), 'a', () => 'fighter');
    pool.setState(pool.get('squad-0')!, 'attacking');
    pool.setState(pool.get('squad-1')!, 'warping');
    const snap = pool.snapshot();
    expect(snap.total).toBe(3);
    expect(snap.byState.attacking).toBe(1);
    expect(snap.byState.warping).toBe(1);
    expect(snap.byState.forming).toBe(1);
  });
});
