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
    expect(loadSettings('alice')).toEqual({});
  });

  it('round-trips persisted booleans for a given user', () => {
    saveSettings('alice', { showDevOverlay: false, showLogPanel: true, showServerGhost: false });
    expect(loadSettings('alice')).toEqual({
      showDevOverlay: false,
      showLogPanel: true,
      showServerGhost: false,
    });
  });

  it('keeps users isolated', () => {
    saveSettings('alice', { showDevOverlay: false, showLogPanel: false, showServerGhost: false });
    saveSettings('bob',   { showDevOverlay: true,  showLogPanel: true,  showServerGhost: true  });
    expect(loadSettings('alice').showDevOverlay).toBe(false);
    expect(loadSettings('bob').showDevOverlay).toBe(true);
  });

  it('uses the :anon slot when userId is null', () => {
    saveSettings(null, { showDevOverlay: false, showLogPanel: true, showServerGhost: false });
    expect(loadSettings(null)).toEqual({
      showDevOverlay: false,
      showLogPanel: true,
      showServerGhost: false,
    });
    // The legacy global key was NOT written to.
    expect(localStorage.getItem('eqxSettings')).toBeNull();
    expect(localStorage.getItem('eqxSettings:anon')).not.toBeNull();
  });

  it('migrates the legacy eqxSettings key into the per-user slot on first read', () => {
    localStorage.setItem(
      'eqxSettings',
      JSON.stringify({ showDevOverlay: false, showLogPanel: true, showServerGhost: false }),
    );
    expect(loadSettings('alice')).toEqual({
      showDevOverlay: false,
      showLogPanel: true,
      showServerGhost: false,
    });
    // Per-user slot now populated …
    expect(localStorage.getItem('eqxSettings:alice')).not.toBeNull();
    // … and the legacy key is read-only — still present so older tabs survive.
    expect(localStorage.getItem('eqxSettings')).not.toBeNull();
  });

  it('does not re-migrate once the per-user slot is populated', () => {
    saveSettings('alice', { showDevOverlay: true, showLogPanel: true, showServerGhost: true });
    // Legacy key changes after migration; should not be reapplied.
    localStorage.setItem(
      'eqxSettings',
      JSON.stringify({ showDevOverlay: false, showLogPanel: false, showServerGhost: false }),
    );
    expect(loadSettings('alice').showDevOverlay).toBe(true);
  });

  it('ignores malformed JSON without throwing', () => {
    localStorage.setItem('eqxSettings:alice', '{not json');
    expect(loadSettings('alice')).toEqual({});
  });

  it('drops fields that are not booleans', () => {
    localStorage.setItem(
      'eqxSettings:alice',
      JSON.stringify({ showDevOverlay: 'yes', showLogPanel: 1, showServerGhost: true }),
    );
    expect(loadSettings('alice')).toEqual({ showServerGhost: true });
  });

  it('survives saveSettings throwing (e.g. quota exceeded)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
      removeItem: () => {},
    });
    // Should not throw.
    expect(() =>
      saveSettings('alice', { showDevOverlay: true, showLogPanel: true, showServerGhost: true }),
    ).not.toThrow();
  });
});
