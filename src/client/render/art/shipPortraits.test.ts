import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PORTRAIT_KINDS, portraitFraming, shipPortraitUrl } from './shipPortraits.js';

describe('ship portraits (join flow stage 3)', () => {
  it('every flyable hull has a committed picture', () => {
    const missing = PORTRAIT_KINDS.filter((k) => !existsSync(path.resolve('public/ships', `${k}.webp`)));
    expect(missing).toEqual([]);
  });

  it('resolves a flyable hull and nothing else', () => {
    expect(shipPortraitUrl('fighter')).toBe('/ships/fighter.webp');
    expect(shipPortraitUrl('battleship-rail')).toBe('/ships/battleship-rail.webp');
    expect(shipPortraitUrl('crossguard')).toBeNull(); // engineering-only
    expect(shipPortraitUrl('no-such-hull')).toBeNull();
  });

  it('capitals are framed closer, with no engine glow', () => {
    expect(portraitFraming('battleship')).toEqual({ zm: 2.5, th: 0 });
    expect(portraitFraming('fighter')).toEqual({ zm: 1, th: 0.6 });
  });
});
