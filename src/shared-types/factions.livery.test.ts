import { describe, expect, it } from 'vitest';
import { FIXED_FACTIONS, LIVERY_EDGES, MINOR_FACTIONS, PLAYER_LIVERY, REGION_POWER_IDS, teamColorOf, teamEdgeOf, teamSigilOf } from './factions.js';

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
