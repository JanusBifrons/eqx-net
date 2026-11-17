import { describe, it, expect } from 'vitest';
import { GALAXY_SECTORS, getNeighbours } from './galaxy.js';
import { gateFirstHop, gateHops } from './gateHops.js';

/** The hand-written BFS `population.nextHopToward` / `hopDistance` used before
 *  they moved onto the shared searcher: answers must not change. */
function referenceFirstHop(from: string, goal: string): { hop: string | null; hops: number } {
  if (from === goal) return { hop: null, hops: 0 };
  const prev = new Map<string, string>();
  const visited = new Set<string>([from]);
  const queue: string[] = [from];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === goal) break;
    for (const n of getNeighbours(cur)) {
      if (visited.has(n.key)) continue;
      visited.add(n.key);
      prev.set(n.key, cur);
      queue.push(n.key);
    }
  }
  if (!prev.has(goal)) return { hop: null, hops: Infinity };
  let step = goal, hops = 1;
  while (prev.get(step) !== from) { step = prev.get(step)!; hops++; }
  return { hop: step, hops };
}

describe('gateHops (galaxy gate graph on the shared searcher)', () => {
  it('matches the old BFS for every sector pair (first hop and hop count)', () => {
    for (const a of GALAXY_SECTORS) {
      for (const b of GALAXY_SECTORS) {
        const ref = referenceFirstHop(a.key, b.key);
        expect(gateFirstHop(a.key, b.key)).toBe(ref.hop);
        expect(gateHops(a.key, b.key)).toBe(ref.hops);
      }
    }
  });

  it('unknown sectors: no hop, infinite distance', () => {
    expect(gateFirstHop('nowhere', GALAXY_SECTORS[0]!.key)).toBeNull();
    expect(gateHops(GALAXY_SECTORS[0]!.key, 'nowhere')).toBe(Infinity);
  });
});
