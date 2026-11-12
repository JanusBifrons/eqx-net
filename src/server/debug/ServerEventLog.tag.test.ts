import { describe, expect, it, beforeEach } from 'vitest';
import { clearEvents, getRecentEvents, getRecentEventsByTag, serverLogEvent } from './ServerEventLog.js';

describe('ServerEventLog — ?tag= filter (2026-11-12)', () => {
  beforeEach(() => clearEvents());

  it('returns the newest matching entries from the whole ring, oldest first', () => {
    serverLogEvent('missile_expired', { n: 1 });
    for (let i = 0; i < 200; i++) serverLogEvent('tick_budget', { i });
    serverLogEvent('missile_expired', { n: 2 });
    for (let i = 0; i < 200; i++) serverLogEvent('tick_budget', { i });
    // The plain "newest 200" view has scrolled both expiries away...
    expect(getRecentEvents(150).some((e) => e.tag === 'missile_expired')).toBe(false);
    // ...the tag view still finds them, in order, capped by `limit`.
    expect(getRecentEventsByTag('missile_expired', 200).map((e) => e.data['n'])).toEqual([1, 2]);
    expect(getRecentEventsByTag('missile_expired', 1).map((e) => e.data['n'])).toEqual([2]);
  });
});
