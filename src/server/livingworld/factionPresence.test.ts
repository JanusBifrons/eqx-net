import { describe, expect, it } from 'vitest';
import { tallyFaction, type FactionPresenceMap } from './factionPresence.js';

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
