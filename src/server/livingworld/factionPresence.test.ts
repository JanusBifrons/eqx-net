import { describe, expect, it } from 'vitest';
import { challengerOf, freshMultiControl, stepMultiControl, type SidePresence } from '../../core/territory/sectorControl.js';
import { controlOpposes, countsForControl, fillSectorPresence, tallyFaction, type FactionPresenceMap } from './factionPresence.js';

describe('tallyFaction', () => {
  it('counts ships and structures per faction, skipping an unknown owner', () => {
    const m: FactionPresenceMap = new Map();
    tallyFaction(m, 'alice', 'ships');
    tallyFaction(m, 'alice', 'structures');
    tallyFaction(m, 'alice', 'structures');
    tallyFaction(m, 'core', 'ships');
    tallyFaction(m, undefined, 'ships');
    tallyFaction(m, '', 'structures');
    expect(Object.fromEntries(m)).toEqual({
      alice: { ships: 1, structures: 2 },
      core: { ships: 1, structures: 0 },
    });
  });
});

describe("the Ancients don't count for capture", () => {
  /** Run one sector's meter for `seconds` of the given presence. */
  function run(byFaction: FactionPresenceMap, seconds: number) {
    const s = freshMultiControl(null);
    const presence = new Map<string, SidePresence>();
    const trace: Array<string | null> = [];
    for (let i = 0; i < seconds; i++) {
      fillSectorPresence(presence, [], byFaction, 0, false);
      stepMultiControl(s, presence, controlOpposes, 1000);
      trace.push(s.holder);
    }
    return { s, presence, trace };
  }

  it('the Ancients faction is excluded; others count', () => {
    expect(countsForControl('ancients')).toBe(false);
    expect(countsForControl('core')).toBe(true);
    expect(countsForControl('robots')).toBe(true);
    expect(countsForControl('alice')).toBe(true);
  });

  it('an Ancients-only presence leaves a sector neutral with no challenger', () => {
    const { s, presence } = run(new Map([['ancients', { ships: 6, structures: 4 }]]), 120);
    expect(presence.size).toBe(0);
    expect(s.holder).toBeNull();
    expect(s.shares.size).toBe(0);
    expect(challengerOf(s, controlOpposes)).toBeNull();
  });

  it('a player claims alongside the Ancients exactly as if they were not there', () => {
    const alone = run(new Map([['alice', { ships: 5, structures: 0 }]]), 90);
    const withAncients = run(new Map([
      ['alice', { ships: 5, structures: 0 }],
      ['ancients', { ships: 10, structures: 6 }],
    ]), 90);
    expect(alone.s.holder).toBe('alice');
    expect(withAncients.trace).toEqual(alone.trace);
    expect([...withAncients.s.shares]).toEqual([...alone.s.shares]);
  });
});
