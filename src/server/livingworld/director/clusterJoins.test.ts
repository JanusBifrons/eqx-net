import { describe, expect, it } from 'vitest';
import { CLUSTER_MAX_MEMBERS, planClusterJoins, type ClusterCandidate } from './clusterJoins.js';

const c = (squadId: string, sectorKey: string, size = 6, eligible = true, gathered = true): ClusterCandidate => ({ squadId, sectorKey, eligible, gathered, size });

describe('robot cluster joins', () => {
  it('two squads idling in one sector merge: the later joins the earlier', () => {
    const j = planClusterJoins([c('a', 's1'), c('b', 's1'), c('c', 's2')], new Map());
    expect([...j]).toEqual([['b', 'a']]);
  });

  it('a cluster never grows past the cap', () => {
    const j = planClusterJoins([c('a', 's1'), c('b', 's1'), c('c', 's1')], new Map());
    expect([...j]).toEqual([['b', 'a']]); // 6 + 6 = 12; c (6) would make 18
    expect(CLUSTER_MAX_MEMBERS).toBe(12);
    // A shrunken squad can top a cluster up.
    const j2 = planClusterJoins([c('a', 's1', 4), c('b', 's1', 4), c('c', 's1', 4)], new Map());
    expect([...j2]).toEqual([['b', 'a'], ['c', 'a']]);
  });

  it('ineligible (busy / scattered) or empty squads never cluster', () => {
    expect(planClusterJoins([c('a', 's1'), c('b', 's1', 6, false)], new Map()).size).toBe(0);
    expect(planClusterJoins([c('a', 's1', 0), c('b', 's1')], new Map()).size).toBe(0);
  });

  it('a join persists, and breaks when they split up or the host becomes ineligible', () => {
    const prev = new Map([['a', 'b']]); // order-independent: a still follows b
    expect([...planClusterJoins([c('a', 's1'), c('b', 's1')], prev)]).toEqual([['a', 'b']]);
    expect(planClusterJoins([c('a', 's1'), c('b', 's2')], prev).size).toBe(0);
    expect(planClusterJoins([c('a', 's1'), c('b', 's1', 6, false)], prev).size).toBe(0);
  });

  it('squads only START merging once both have arrived; a cluster stays merged while it travels', () => {
    expect(planClusterJoins([c('a', 's1'), c('b', 's1', 6, true, false)], new Map()).size).toBe(0);
    const prev = new Map([['b', 'a']]);
    expect([...planClusterJoins([c('a', 's2', 6, true, false), c('b', 's2', 6, true, false)], prev)]).toEqual([['b', 'a']]);
  });

  it('a host is never also a joiner (no chains)', () => {
    const j = planClusterJoins([c('a', 's1', 3), c('b', 's1', 3), c('c', 's1', 3)], new Map());
    for (const host of j.values()) expect(j.has(host)).toBe(false);
  });
});
