import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadSettings, saveSettings } from './settingsStorage.js';

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
}

describe('settingsStorage', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
  });

  it('returns an empty object when nothing is persisted', () => {
    expect(loadSettings()).toEqual({});
  });

  it('round-trips persisted booleans', () => {
    saveSettings({ showDevOverlay: false, showLogPanel: true, showServerGhost: false });
    expect(loadSettings()).toEqual({
      showDevOverlay: false,
      showLogPanel: true,
      showServerGhost: false,
    });
  });

  it('ignores malformed JSON without throwing', () => {
    localStorage.setItem('eqxSettings', '{not json');
    expect(loadSettings()).toEqual({});
  });

  it('drops fields that are not booleans', () => {
    localStorage.setItem(
      'eqxSettings',
      JSON.stringify({ showDevOverlay: 'yes', showLogPanel: 1, showServerGhost: true }),
    );
    expect(loadSettings()).toEqual({ showServerGhost: true });
  });

  it('survives saveSettings throwing (e.g. quota exceeded)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
      removeItem: () => {},
    });
    // Should not throw.
    expect(() =>
      saveSettings({ showDevOverlay: true, showLogPanel: true, showServerGhost: true }),
    ).not.toThrow();
  });
});
