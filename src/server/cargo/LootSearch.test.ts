import { describe, it, expect } from 'vitest';
import { LootSearch, MAX_GAP_MS } from './LootSearch.js';

describe('LootSearch: server-owned search time per viewer and container', () => {
  it('counts in-reach time between queries, per viewer', () => {
    const s = new LootSearch();
    expect(s.advance('a', 'pod', 1000, true)).toBe(0);
    expect(s.advance('a', 'pod', 1500, true)).toBe(500);
    expect(s.advance('b', 'pod', 1500, true), 'another viewer starts fresh').toBe(0);
    expect(s.advance('a', 'pod', 2500, true)).toBe(1500);
  });

  it('leaving reach pauses the search; coming back resumes it', () => {
    const s = new LootSearch();
    s.advance('a', 'pod', 0, true);
    expect(s.advance('a', 'pod', 800, true)).toBe(800);
    expect(s.advance('a', 'pod', 1000, false), 'the out-of-reach query adds nothing').toBe(800);
    expect(s.advance('a', 'pod', 9000, true), 'time away never counts').toBe(800);
    expect(s.advance('a', 'pod', 9400, true)).toBe(1200);
  });

  it('a long gap between queries (window shut) credits at most MAX_GAP_MS', () => {
    const s = new LootSearch();
    s.advance('a', 'pod', 0, true);
    expect(s.advance('a', 'pod', 60_000, true)).toBe(MAX_GAP_MS);
  });

  it('forgetContainer drops every viewer search on it', () => {
    const s = new LootSearch();
    s.advance('a', 'pod', 0, true);
    s.advance('b', 'pod', 0, true);
    s.advance('a', 'other', 0, true);
    s.forgetContainer('pod');
    expect(s.size()).toBe(1);
  });
});
