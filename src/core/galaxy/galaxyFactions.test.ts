/** Factions F1: every galaxy region is a region-power faction with the same name. */
import { describe, expect, it } from 'vitest';
import { GALAXY_FACTIONS } from './galaxy.js';
import { factionDisplayName, npcFactionDef } from '../../shared-types/factions.js';

describe('region powers', () => {
  it('each galaxy region id is a power faction with the region name', () => {
    for (const r of GALAXY_FACTIONS) {
      expect(npcFactionDef(r.id)?.kind, r.id).toBe('power');
      expect(factionDisplayName(r.id)).toBe(r.displayName);
    }
  });
});
