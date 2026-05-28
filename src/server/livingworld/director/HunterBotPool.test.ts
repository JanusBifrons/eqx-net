import { describe, it, expect } from 'vitest';
import { HunterBotPool } from './HunterBotPool.js';
import { SHIP_KINDS_LIST } from '../../../shared-types/shipKinds.js';

/**
 * Regression lock for the 2026-05-28 smoke-test bug (capture ilhqk6):
 * Living World hunter bots were being seeded with `crossguard` and
 * `el` ship kinds (engineering-only test fixtures, both at `scale: 10`),
 * which leaked into Sol Prime and surrounding galaxy sectors. Symptoms:
 *   - Square `el` ship rendered far larger than its (190 + pad = 200 u)
 *     shield bubble (the polygon bounding circle is ~1414 u).
 *   - Heavy chassis + concave-hull collision drove per-frame
 *     `ramming_probe` log allocation, GC pauses, recv_gap_long bursts,
 *     and visible jumping (150 u correction at n=55).
 * Filter belongs at `HunterBotPool.seed` (and `pickRandomShipKind`
 * inside `SwarmSpawner` — covered in that file's test).
 */
describe('HunterBotPool — engineering kinds excluded from seed (capture ilhqk6)', () => {
  it('never seeds a bot with an engineeringOnly kind', () => {
    let nextRand = 0;
    const samples: number[] = [];
    // Seed the rng with values that, against the FULL SHIP_KINDS_LIST,
    // would land on crossguard + el deliberately — we want to prove the
    // filter is applied even when rng() lands on an engineering kind.
    const N = SHIP_KINDS_LIST.length;
    for (let i = 0; i < N; i++) samples.push(i / N + 1e-9);
    const rng = (): number => samples[nextRand++ % samples.length]!;

    const pool = new HunterBotPool({
      botCount: 200,
      initialStaggerMs: 1,
      rng,
      nowMs: () => 1_000_000,
    });
    pool.seed('sol-prime');

    const kinds = new Set<string>();
    for (const rec of pool.values()) kinds.add(rec.kind);

    for (const id of kinds) {
      const k = SHIP_KINDS_LIST.find((sk) => sk.id === id)!;
      expect(k.engineeringOnly, `hunter bot seeded with engineering kind ${id} — must be filtered out`).toBeFalsy();
    }
    expect(kinds.has('crossguard')).toBe(false);
    expect(kinds.has('el')).toBe(false);
    expect(kinds.size).toBeGreaterThan(0);
  });
});
