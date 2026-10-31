/**
 * PR 3a — the client keeps the browser's anonymous id and the account's
 * canonical id separately, and uses the account id only while logged in.
 */
import { beforeEach, describe, expect, it } from 'vitest';

const store = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

const { loadStoredPlayerId, persistPlayerId, setAccountPlayerId, clearAccountPlayerId } =
  await import('./token.js');

const ANON = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';

describe('client player identity storage', () => {
  beforeEach(() => store.clear());

  it('logged out → the anonymous browser id', () => {
    persistPlayerId(ANON);
    expect(loadStoredPlayerId()).toBe(ANON);
  });

  it('logged in → the account id, not the browser id', () => {
    persistPlayerId(ANON);
    store.set('eqxAuthToken', 'tok');
    setAccountPlayerId(ACCOUNT);
    expect(loadStoredPlayerId()).toBe(ACCOUNT);
  });

  it('logged in but not yet bound → the browser id, and the welcome id becomes the account id', () => {
    persistPlayerId(ANON);
    store.set('eqxAuthToken', 'tok');
    setAccountPlayerId(null);
    expect(loadStoredPlayerId()).toBe(ANON);
    persistPlayerId(ACCOUNT); // the server's welcome after binding
    expect(loadStoredPlayerId()).toBe(ACCOUNT);
    expect(store.get('eqxPlayerId')).toBe(ANON); // anonymous id untouched
  });

  it('logout forgets the account id (never reused logged-out)', () => {
    persistPlayerId(ANON);
    store.set('eqxAuthToken', 'tok');
    setAccountPlayerId(ACCOUNT);
    store.delete('eqxAuthToken');
    clearAccountPlayerId();
    expect(loadStoredPlayerId()).toBe(ANON);
  });
});
