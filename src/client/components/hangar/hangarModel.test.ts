import { describe, expect, it } from 'vitest';
import { HANGAR_TABS, hangarKinds, hangarTiles, launchFooter, tabReadyCount, tileVerdict } from './hangarModel.js';
import { capitalClassAndFitOf } from '../../../shared-types/shipKinds/capitals/index.js';

const SUB = HANGAR_TABS[0]!;
const CAP = HANGAR_TABS[1]!;
const broke = { wallet: 0, freeLaunches: 0, ownedHere: new Set<string>(), costsOn: true };

describe('Hangar model (join flow stage 5)', () => {
  it('reads a warship kind as class + fit, and nothing else', () => {
    expect(capitalClassAndFitOf('battleship')).toEqual({ classId: 'battleship', fit: 'naval' });
    expect(capitalClassAndFitOf('battleship-rail')).toEqual({ classId: 'battleship', fit: 'rail' });
    expect(capitalClassAndFitOf('heavy-cruiser-beam')).toEqual({ classId: 'heavy-cruiser', fit: 'beam' });
    expect(capitalClassAndFitOf('battlecruiser-lance')).toEqual({ classId: 'battlecruiser', fit: 'lance' });
    expect(capitalClassAndFitOf('battleship-b')).toBeNull(); // NPC-only hull style
    expect(capitalClassAndFitOf('barge')).toBeNull();
    expect(capitalClassAndFitOf('fighter')).toBeNull();
  });

  it('every flyable hull is on exactly one tab, engineering hulls on none', () => {
    const shown = HANGAR_TABS.flatMap((t) => hangarTiles(t).flatMap((x) => x.fits.map((f) => f.kind)));
    expect(new Set(shown).size).toBe(shown.length);
    expect([...shown].sort()).toEqual(hangarKinds().map((k) => k.id).sort());
    expect(shown).not.toContain('crossguard');
  });

  it('folds a class\'s fits into one tile, base kind first', () => {
    const tiles = hangarTiles(CAP);
    expect(tiles.map((t) => t.id)).toEqual(['destroyer', 'light-cruiser', 'heavy-cruiser', 'battlecruiser', 'battleship', 'barge']);
    expect(tiles.find((t) => t.id === 'battleship')!.fits.map((f) => f.fit)).toEqual(['naval', 'rail']);
    expect(hangarTiles(SUB).every((t) => t.fits.length === 1)).toBe(true);
  });

  it('a tile asks the shared verdict: free, owned, token, debt, shipyard', () => {
    expect(tileVerdict('fighter', broke).kind).toBe('free');
    expect(tileVerdict('heavy', broke)).toMatchObject({ kind: 'refuse', reason: 'shipyard' });
    expect(tileVerdict('heavy', { ...broke, ownedHere: new Set(['heavy']) }).kind).toBe('owned');
    expect(tileVerdict('battleship', { ...broke, freeLaunches: 1 }).kind).toBe('token');
    expect(tileVerdict('destroyer', broke).kind).toBe('debt');
  });

  it('counts ready tiles per tab', () => {
    // Broke with no free launches: every warship still launches into debt; the Barge (Shipyard) doesn't.
    expect(tabReadyCount(CAP, broke)).toBe(5);
    expect(tabReadyCount(CAP, { ...broke, ownedHere: new Set(['barge']) })).toBe(6);
    // Sub-caps: scout and fighter are free; the Shipyard hulls need building.
    expect(tabReadyCount(SUB, broke)).toBe(2);
  });

  it('footer shows the cost and the balance after launch', () => {
    expect(launchFooter({ kind: 'pay', cost: 2500 }, 10_000)).toEqual({ cost: '2,500 cr', after: 7500 });
    expect(launchFooter({ kind: 'debt', cost: 2500 }, 0)).toEqual({ cost: '2,500 cr', after: -2500 });
    expect(launchFooter({ kind: 'token', cost: 0 }, 0)).toEqual({ cost: 'Free launch', after: 0 });
  });
});
