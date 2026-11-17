import { afterEach, describe, expect, it } from 'vitest';
import {
  FIXED_FACTIONS, LIVERY_EDGES, MINOR_FACTIONS, PLAYER_LIVERY, REGION_POWER_IDS, SIGIL_COUNT,
  claimFactionLook, factionLookOf, factionLookVersion, factionLooksWire, freeSigilsFor, isLookFree, setFactionLooks,
  teamColorOf, teamEdgeOf, teamSigilOf,
} from './factions.js';

function hueOf(c: number): number {
  const r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

describe('ship livery', () => {
  it('palette has 12 unique entries, pairwise >= 25° hue apart, no NPC duplicates', () => {
    expect(PLAYER_LIVERY).toHaveLength(12);
    expect(new Set(PLAYER_LIVERY).size).toBe(12);
    for (let i = 0; i < 12; i++)
      for (let j = i + 1; j < 12; j++) {
        const d = Math.abs(hueOf(PLAYER_LIVERY[i]!) - hueOf(PLAYER_LIVERY[j]!));
        expect(Math.min(d, 360 - d)).toBeGreaterThanOrEqual(25);
      }
    for (const f of FIXED_FACTIONS) expect(PLAYER_LIVERY).not.toContain(f.color);
  });
  it('NPC faction colours pass through', () => {
    expect(teamColorOf('drones')).toBe(0xff4444);
    expect(teamColorOf('robots')).toBe(0xc070ff);
    expect(teamColorOf('traders')).toBe(0xffd060);
    expect(teamColorOf('core')).toBe(0x6fb6ff);
  });
  it('players map into the palette deterministically', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `player-${i}`);
    for (const id of ids) {
      expect(PLAYER_LIVERY).toContain(teamColorOf(id));
      expect(teamColorOf(id)).toBe(teamColorOf(id));
      expect(teamSigilOf(id)).toBe(teamSigilOf(id));
      expect(teamSigilOf(id)).toBeGreaterThanOrEqual(0);
      expect(teamSigilOf(id)).toBeLessThan(0x10000);
    }
    expect(new Set(ids.map(teamColorOf)).size).toBeGreaterThan(6);
    expect(teamSigilOf('drones')).toBe(teamSigilOf('drones'));
  });
});

describe('teamEdgeOf (per-faction section edge, livery b8)', () => {
  it('every NPC faction has its own set edge, and teamEdgeOf returns it', () => {
    for (const f of [...FIXED_FACTIONS, ...MINOR_FACTIONS]) {
      expect(LIVERY_EDGES, f.id).toContain(f.liveryEdge);
      expect(teamEdgeOf(f.id)).toBe(f.liveryEdge);
    }
  });
  it('rivals differ: drones vs robots, drones vs the red Crimson Expanse, the three cool-coloured powers', () => {
    expect(teamEdgeOf('drones')).not.toBe(teamEdgeOf('robots'));
    expect(teamEdgeOf('drones')).not.toBe(teamEdgeOf('crimson-expanse'));
    expect(new Set(['core', 'verdant-reach', 'azure-deep'].map(teamEdgeOf)).size).toBe(3);
  });
  it("a region's minor factions wear all three edges", () => {
    for (const r of REGION_POWER_IDS) expect(new Set(MINOR_FACTIONS.filter((f) => f.region === r).map((f) => f.liveryEdge)).size).toBe(3);
  });
  it('players hash deterministically over all three edges', () => {
    const ids = Array.from({ length: 60 }, (_, i) => `player-${i}`);
    for (const id of ids) {
      expect(LIVERY_EDGES).toContain(teamEdgeOf(id));
      expect(teamEdgeOf(id)).toBe(teamEdgeOf(id));
    }
    expect(new Set(ids.map(teamEdgeOf)).size).toBe(3);
  });
});

describe('claimed looks (unique colour + sigil pairs)', () => {
  afterEach(() => setFactionLooks([]));

  it('a claim drives teamColorOf / teamSigilOf / teamEdgeOf; unclaimed players keep the hash', () => {
    const before = { c: teamColorOf('player-a'), s: teamSigilOf('player-a'), e: teamEdgeOf('player-a') };
    expect(claimFactionLook('player-a', 3, 0x123)).toBe('ok');
    expect(teamColorOf('player-a')).toBe(PLAYER_LIVERY[3]);
    expect(teamSigilOf('player-a')).toBe((3 << 12) | 0x123);
    expect(teamEdgeOf('player-a')).toBe(LIVERY_EDGES[0x123 % LIVERY_EDGES.length]);
    expect(factionLookOf('player-a')).toEqual({ colorSlot: 3, sigil: 0x123 });
    setFactionLooks([]);
    expect({ c: teamColorOf('player-a'), s: teamSigilOf('player-a'), e: teamEdgeOf('player-a') }).toEqual(before);
  });

  it('a pair is unique: a second faction cannot take it; re-claiming frees the old pair', () => {
    expect(claimFactionLook('player-a', 3, 7)).toBe('ok');
    expect(isLookFree(3, 7)).toBe(false);
    expect(isLookFree(3, 7, 'player-a')).toBe(true);
    expect(claimFactionLook('player-b', 3, 7)).toBe('taken');
    expect(claimFactionLook('player-b', 4, 7)).toBe('ok'); // same sigil, other colour
    expect(claimFactionLook('player-a', 3, 8)).toBe('ok');
    expect(isLookFree(3, 7)).toBe(true);
    expect(claimFactionLook('player-b', 3, 7)).toBe('ok');
  });

  it('rejects out-of-range pairs', () => {
    expect(claimFactionLook('player-a', PLAYER_LIVERY.length, 0)).toBe('range');
    expect(claimFactionLook('player-a', -1, 0)).toBe('range');
    expect(claimFactionLook('player-a', 0, SIGIL_COUNT)).toBe('range');
    expect(claimFactionLook('player-a', 0, 1.5)).toBe('range');
    expect(factionLookOf('player-a')).toBeUndefined();
  });

  it('NPC factions are reserved: they cannot claim, and nobody can take their sigil', () => {
    expect(claimFactionLook('drones', 0, 0)).toBe('npc');
    const npc = [...FIXED_FACTIONS, ...MINOR_FACTIONS].map((f) => teamSigilOf(f.id)).find((s) => s >> 12 < PLAYER_LIVERY.length);
    expect(npc).toBeDefined();
    const [slot, sigil] = [npc! >> 12, npc! & 0xfff];
    expect(isLookFree(slot, sigil)).toBe(false);
    expect(claimFactionLook('player-a', slot, sigil)).toBe('taken');
    expect(freeSigilsFor(slot)).not.toContain(sigil);
  });

  it('lists free sigils per colour slot', () => {
    const all = freeSigilsFor(5).length;
    expect(claimFactionLook('player-a', 5, 42)).toBe('ok');
    expect(freeSigilsFor(5)).not.toContain(42);
    expect(freeSigilsFor(5)).toHaveLength(all - 1);
    expect(freeSigilsFor(5, 'player-a')).toContain(42);
  });

  it('setFactionLooks replaces the set, skips clashes, and bumps the version only on change', () => {
    const v0 = factionLookVersion();
    setFactionLooks([{ factionId: 'player-a', colorSlot: 1, sigil: 1 }, { factionId: 'player-b', colorSlot: 1, sigil: 1 }]);
    expect(factionLookOf('player-a')).toBeDefined();
    expect(factionLookOf('player-b'), 'a clash keeps the first').toBeUndefined();
    const v1 = factionLookVersion();
    expect(v1).toBeGreaterThan(v0);
    setFactionLooks([{ factionId: 'player-a', colorSlot: 1, sigil: 1 }]);
    expect(factionLookVersion(), 'unchanged set').toBe(v1);
    expect(factionLooksWire()).toEqual([{ factionId: 'player-a', colorSlot: 1, sigil: 1 }]);
  });
});
