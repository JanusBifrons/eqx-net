import { describe, it, expect } from 'vitest';
import { targetUrl } from './recorder';
import { resolveArtMode, resolveFxMode, resolveShipLighting } from '../src/client/render/art/artMode';

/** The capture browser is automated; the clip must still show what a desktop player sees. */
function lookOf(url: string): { art: string; fx: boolean; lighting: unknown } {
  const search = new URL(url).search;
  const art = resolveArtMode(search, true, null);
  return { art, fx: resolveFxMode(search, art, true), lighting: resolveShipLighting(search, art, { automation: true }) };
}

describe('showcase films the player look (user, 2026-11-10)', () => {
  it('a shot with no look params films the desktop default: Machined, new effects, GPU lighting at High', () => {
    const url = targetUrl('http://x', { room: 'r', params: { shipKind: 'fighter' } }, 't', 'none');
    const player = resolveShipLighting('', 'machined', { automation: false, touch: false });
    expect(player).toBeDefined();
    expect(lookOf(url)).toEqual({ art: 'machined', fx: true, lighting: player });
  });

  it("a shot's own params still win", () => {
    const url = targetUrl('http://x', { room: 'r', params: { art: 'classic', shiplight: 'baked' } }, 't', 'none');
    expect(lookOf(url)).toMatchObject({ art: 'classic', fx: false, lighting: undefined });
  });
});

describe('showcase films the game as is (user, 2026-11-10)', () => {
  it('every shot films the full HUD and no cleanworld, whatever the shot asks for', () => {
    for (const hud of ['none', 'minimal', 'clean', 'full'] as const) {
      const q = new URL(targetUrl('http://x', { room: 'r' }, 't', hud)).searchParams;
      expect(q.get('hud')).toBe('full');
      expect(q.has('cleanworld')).toBe(false);
    }
  });
});
