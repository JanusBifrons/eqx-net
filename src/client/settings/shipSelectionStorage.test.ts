import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadShipKind, saveShipKind } from './shipSelectionStorage.js';
import { DEFAULT_SHIP_KIND } from '../../shared-types/shipKinds.js';

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
}

describe('shipSelectionStorage', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
  });

  it('returns the catalogue default when nothing is persisted', () => {
    expect(loadShipKind('alice')).toBe(DEFAULT_SHIP_KIND);
  });

  it('round-trips a valid kind id per user', () => {
    saveShipKind('alice', 'heavy');
    expect(loadShipKind('alice')).toBe('heavy');
  });

  it('keeps users isolated', () => {
    saveShipKind('alice', 'heavy');
    saveShipKind('bob', 'scout');
    expect(loadShipKind('alice')).toBe('heavy');
    expect(loadShipKind('bob')).toBe('scout');
  });

  it('uses the :anon slot when userId is null', () => {
    saveShipKind(null, 'scout');
    expect(loadShipKind(null)).toBe('scout');
    expect(localStorage.getItem('eqxShipSelection:anon')).not.toBeNull();
  });

  it('falls back to the default when the persisted value is unknown / removed from the catalogue', () => {
    // Simulate an older build that wrote a kind id we no longer ship.
    localStorage.setItem('eqxShipSelection:alice', JSON.stringify({ shipKind: 'corvette' }));
    expect(loadShipKind('alice')).toBe(DEFAULT_SHIP_KIND);
  });

  it('falls back to the default on malformed JSON without throwing', () => {
    localStorage.setItem('eqxShipSelection:alice', '{not json');
    expect(() => loadShipKind('alice')).not.toThrow();
    expect(loadShipKind('alice')).toBe(DEFAULT_SHIP_KIND);
  });

  it('survives a saveShipKind throwing (quota exceeded)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
      removeItem: () => {},
    });
    expect(() => saveShipKind('alice', 'heavy')).not.toThrow();
  });
});
