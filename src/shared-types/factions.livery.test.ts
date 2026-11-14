import { describe, expect, it } from 'vitest';
import { FIXED_FACTIONS, PLAYER_LIVERY, teamColorOf, teamSigilOf } from './factions.js';

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
